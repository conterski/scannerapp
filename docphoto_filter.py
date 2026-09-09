"""Invisible readability filter for photographed handwritten documents.

Goal: the photo should still look like a photo of paper — same paper tone,
same watermark, same lighting character — while the writing reads cleanly.
Nothing is clipped to pure white or pure black, and a controlled amount of
the original grain is kept, because a perfectly clean field is the single
biggest giveaway that an image has been processed.

Global preset: every radius is a fraction of the shorter image side, so the
same parameters apply to any resolution or crop of a similar document.

Design rules
    * Partial flat-field. Lighting is evened out, not erased, and the gain is
      clamped so the desk and shadowed edges keep their own tone.
    * Soft tone curve with a shoulder. Paper lands just below white, so the
      watermark, stamp and pale print survive instead of clipping away.
    * Sharpening is gated by an ink mask and soft-clipped, so paper receives
      none of it and no overshoot rim can form along a stroke.
    * Grain is attenuated, not removed; chroma is left near its original
      saturation so the sheet keeps its natural colour cast.

Usage
    python docphoto_filter.py input.jpg output.jpg
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

LAB_L_MAX = 100.0
LAB_AB_LIMIT = 110.0


@dataclass(frozen=True)
class FilterParams:
    """Radii are fractions of the shorter image side."""

    # Illumination — partial, so the original lighting character remains
    background_radius: float = 0.030
    paper_percentile: float = 90.0
    gain_limits: tuple[float, float] = (0.88, 1.18)
    flatten_strength: float = 0.55

    # Texture — attenuated, not erased
    denoise_radius: float = 0.003
    denoise_eps: float = 8.0e-4
    denoise_strength: float = 0.55

    # Ink sharpening
    detail_radius: float = 0.006
    detail_eps: float = 2.0e-3
    detail_gain: float = 0.60
    detail_soft_limit: float = 0.10  # reflectance units

    # Tone — soft shoulder, no clipping at either end
    black_point: float = 0.22
    white_point: float = 1.02
    ink_reference: float = 0.62  # reflectance treated as "clearly ink"
    contrast_shape: float = 0.30  # 0 = linear, 1 = full smoothstep
    output_black: float = 0.05
    output_white: float = 0.965
    tone_strength: float = 0.85

    # Colour
    chroma_radius: float = 0.006
    chroma_eps: float = 2.0e-3
    chroma_denoise_strength: float = 0.50
    chroma_gain: float = 1.05


def _radius_px(fraction: float, image: np.ndarray, minimum: int = 1) -> int:
    return max(minimum, int(round(fraction * min(image.shape[:2]))))


def _box_mean(image: np.ndarray, radius: int) -> np.ndarray:
    ksize = (2 * radius + 1, 2 * radius + 1)
    return cv2.boxFilter(image, -1, ksize, normalize=True,
                         borderType=cv2.BORDER_REFLECT)


def _blend(original: np.ndarray, processed: np.ndarray,
           strength: float) -> np.ndarray:
    return original + (processed - original) * strength


def guided_filter(guide: np.ndarray, source: np.ndarray, radius: int,
                  eps: float) -> np.ndarray:
    """Edge-aware smoothing; guide is normalised to roughly [0, 1]."""
    mean_guide = _box_mean(guide, radius)
    mean_source = _box_mean(source, radius)
    covariance = _box_mean(guide * source, radius) - mean_guide * mean_source
    variance = _box_mean(guide * guide, radius) - mean_guide * mean_guide

    scale = covariance / (variance + eps)
    offset = mean_source - scale * mean_guide
    return _box_mean(scale, radius) * guide + _box_mean(offset, radius)


def to_reflectance(luma: np.ndarray, params: FilterParams) -> np.ndarray:
    """Express each pixel relative to clean paper, correcting lighting partially.

    The gain is clamped and then eased toward 1.0, so shading is softened
    rather than flattened and dark surroundings are never lifted into noise.
    """
    radius = _radius_px(params.background_radius, luma)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                       (radius | 1, radius | 1))
    background = cv2.morphologyEx(luma, cv2.MORPH_CLOSE, kernel)
    background = cv2.GaussianBlur(background, (0, 0), radius)

    paper_level = float(np.percentile(background, params.paper_percentile))
    gain = np.clip(paper_level / np.maximum(background, 1.0), *params.gain_limits)
    gain = _blend(np.ones_like(gain), gain, params.flatten_strength)
    return luma * gain / max(paper_level, 1.0)


def suppress_texture(reflectance: np.ndarray, params: FilterParams) -> np.ndarray:
    """Attenuate grain while leaving enough for the image to read as a photo."""
    radius = _radius_px(params.denoise_radius, reflectance)
    smoothed = guided_filter(reflectance, reflectance, radius, params.denoise_eps)
    return _blend(reflectance, smoothed, params.denoise_strength)


def ink_weight(reflectance: np.ndarray, params: FilterParams) -> np.ndarray:
    """1 on ink, 0 on clean paper, smooth in between."""
    span = max(params.white_point - params.ink_reference, 1e-6)
    return np.clip((params.white_point - reflectance) / span, 0.0, 1.0)


def sharpen_ink(reflectance: np.ndarray, mask: np.ndarray,
                params: FilterParams) -> np.ndarray:
    """Edge-aware detail boost restricted to ink, with soft-clipped amplitude."""
    radius = _radius_px(params.detail_radius, reflectance)
    base = guided_filter(reflectance, reflectance, radius, params.detail_eps)

    limit = params.detail_soft_limit
    detail = np.tanh((reflectance - base) / limit) * limit
    return base + detail * (1.0 + params.detail_gain * mask)


def apply_tone_curve(reflectance: np.ndarray, params: FilterParams) -> np.ndarray:
    """Gentle levels with a partial smoothstep, mapped inside a safe output range."""
    span = max(params.white_point - params.black_point, 1e-6)
    linear = np.clip((reflectance - params.black_point) / span, 0.0, 1.0)
    shaped = linear * linear * (3.0 - 2.0 * linear)
    curved = _blend(linear, shaped, params.contrast_shape)

    output_span = params.output_white - params.output_black
    graded = params.output_black + curved * output_span
    return _blend(reflectance, graded, params.tone_strength)


def grade_chroma(chroma: np.ndarray, guide: np.ndarray,
                 params: FilterParams) -> np.ndarray:
    """Take the edge off colour noise, keep the paper's own cast and all ink hues."""
    radius = _radius_px(params.chroma_radius, guide)
    smoothed = np.stack(
        [guided_filter(guide, chroma[..., i], radius, params.chroma_eps)
         for i in range(chroma.shape[2])],
        axis=-1,
    )
    denoised = _blend(chroma, smoothed, params.chroma_denoise_strength)
    return np.clip(denoised * params.chroma_gain, -LAB_AB_LIMIT, LAB_AB_LIMIT)


def enhance(image_bgr: np.ndarray,
            params: FilterParams = FilterParams()) -> np.ndarray:
    lab = cv2.cvtColor(image_bgr.astype(np.float32) / 255.0, cv2.COLOR_BGR2LAB)
    luma, chroma = lab[..., 0], lab[..., 1:]

    reflectance = suppress_texture(to_reflectance(luma, params), params)
    mask = ink_weight(reflectance, params)
    reflectance = sharpen_ink(reflectance, mask, params)
    tone = np.clip(apply_tone_curve(reflectance, params), 0.0, 1.0)

    lab_out = np.dstack([tone * LAB_L_MAX, grade_chroma(chroma, reflectance, params)])
    result = cv2.cvtColor(lab_out, cv2.COLOR_LAB2BGR)
    return np.clip(result * 255.0, 0, 255).astype(np.uint8)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    image = cv2.imread(str(args.input), cv2.IMREAD_COLOR)
    if image is None:
        raise SystemExit(f"Cannot read image: {args.input}")

    cv2.imwrite(str(args.output), enhance(image),
                [cv2.IMWRITE_JPEG_QUALITY, 95])


if __name__ == "__main__":
    main()
