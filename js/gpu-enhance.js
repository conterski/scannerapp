/* gpu-enhance.js — the "natural flash" look, as WebGL2 shader passes.
 *
 * Same filter as docphoto_filter.py (kept in the repository as the reference):
 * a partial flat-field correction, guided-filter grain attenuation, sharpening
 * gated by an ink mask, a soft-shouldered tone curve, and chroma smoothed and
 * lifted slightly — all in Lab.
 *
 * It runs on the GPU because it cannot be fast anywhere else. Measured in
 * OpenCV.js at 2 MP, converting colour there and back while doing no filtering
 * at all costs 58ms via YCrCb and 125ms via Lab; the whole filter costs ~850ms.
 * Every stage of it, though, is a local per-pixel operation — a colour
 * transform, box means, guided-filter coefficients, an ink mask, a tone curve
 * — which is exactly what fragment shaders are for. On the GPU the same work
 * is around 10ms.
 *
 * Two things make it correct rather than merely fast:
 *   * Moment textures are RG32F. The guided filter needs E[x²] - E[x]², and at
 *     half-float that difference is swallowed by quantisation. Two channels of
 *     full float cost 8 bytes a pixel — the same bandwidth as RGBA16F.
 *   * The paper percentile is a reduction, which shaders are bad at, so a
 *     small mip of the background is read back and it is computed on the CPU.
 *     The background is smooth by construction, so nothing is lost.
 *
 * Exposes window.GpuEnhance.
 */
(function () {
  "use strict";

  // Transcribed from FilterParams in docphoto_filter.py. Radii are fractions
  // of the shorter image side.
  const PARAMS = Object.freeze({
    backgroundRadius: 0.030,
    paperPercentile: 90,
    gainMinimum: 0.88,
    gainMaximum: 1.18,
    flattenStrength: 0.55,

    denoiseRadius: 0.003,
    denoiseEps: 8.0e-4,
    denoiseStrength: 0.55,

    detailRadius: 0.006,
    detailEps: 2.0e-3,
    detailGain: 0.60,
    detailSoftLimit: 0.10,

    blackPoint: 0.22,
    whitePoint: 1.02,
    inkReference: 0.62,
    contrastShape: 0.30,
    outputBlack: 0.05,
    outputWhite: 0.965,
    toneStrength: 0.85,

    chromaRadius: 0.006,
    chromaEps: 2.0e-3,
    chromaDenoiseStrength: 0.50,
    chromaGain: 1.05,
  });

  // The illumination estimate is low-frequency, so the whole flat-field stage
  // runs at this size and only the gain is sampled back up. Matches the CPU
  // implementation this replaced.
  const BACKGROUND_EDGE = 512;
  // Chroma is being denoised and the eye carries little colour detail, so its
  // guided filter runs at a quarter. JPEG's own chroma subsampling is coarser
  // than the result, and this stage was a third of the filter's time at full
  // resolution.
  const CHROMA_DIVISOR = 4;
  // Enough samples to locate a percentile of a smooth field. Reading roughly
  // this many spread across the photo costs well under a millisecond.
  const PERCENTILE_SAMPLES = 20000;
  const PERCENTILE_BINS = 1024;

  // Lab is stored normalised so half-float precision is spent where it counts:
  // L over 0..1 rather than 0..100, chroma over roughly -1..1.
  const LAB_L_SCALE = 100.0;
  const LAB_AB_SCALE = 128.0;

  // ------------------------------------------------------------------
  // Shaders
  // ------------------------------------------------------------------

  const VERTEX_SHADER = `#version 300 es
    in vec2 aPosition;
    out vec2 vUV;
    void main() {
      vUV = aPosition * 0.5 + 0.5;
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }`;

  const HEADER = `#version 300 es
    precision highp float;
    precision highp sampler2D;
    in vec2 vUV;
    uniform sampler2D uSource;
    uniform vec2 uTexel;`;

  // sRGB <-> Lab, matching OpenCV's float conversion: sRGB transfer function,
  // the same primaries, D65.
  const COLOUR = `
    const mat3 RGB_TO_XYZ = mat3(
      0.412453, 0.212671, 0.019334,
      0.357580, 0.715160, 0.119193,
      0.180423, 0.072169, 0.950227);
    const mat3 XYZ_TO_RGB = mat3(
       3.240479, -0.969256,  0.055648,
      -1.537150,  1.875992, -0.204043,
      -0.498535,  0.041556,  1.057311);
    const vec3 WHITE_POINT = vec3(0.950456, 1.0, 1.088754);

    vec3 srgbToLinear(vec3 c) {
      return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
    }
    vec3 linearToSrgb(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
    }
    float labF(float t) {
      return t > 0.008856 ? pow(t, 1.0 / 3.0) : (7.787 * t + 16.0 / 116.0);
    }
    float labFInverse(float t) {
      return t > 0.206893 ? t * t * t : (t - 16.0 / 116.0) / 7.787;
    }
    vec3 rgbToLab(vec3 rgb) {
      vec3 xyz = (RGB_TO_XYZ * srgbToLinear(rgb)) / WHITE_POINT;
      vec3 f = vec3(labF(xyz.x), labF(xyz.y), labF(xyz.z));
      return vec3(116.0 * f.y - 16.0, 500.0 * (f.x - f.y), 200.0 * (f.y - f.z));
    }
    vec3 labToRgb(vec3 lab) {
      float fy = (lab.x + 16.0) / 116.0;
      vec3 f = vec3(fy + lab.y / 500.0, fy, fy - lab.z / 200.0);
      vec3 xyz = vec3(labFInverse(f.x), labFInverse(f.y), labFInverse(f.z)) * WHITE_POINT;
      return clamp(linearToSrgb(clamp(XYZ_TO_RGB * xyz, 0.0, 1.0)), 0.0, 1.0);
    }`;

  const SHADER_SOURCE = {
    /** RGBA8 photo -> normalised Lab. */
    toLab: `${HEADER}${COLOUR}
      out vec4 outColour;
      void main() {
        vec3 lab = rgbToLab(texture(uSource, vUV).rgb);
        outColour = vec4(lab.x / ${LAB_L_SCALE.toFixed(1)},
                         lab.y / ${LAB_AB_SCALE.toFixed(1)},
                         lab.z / ${LAB_AB_SCALE.toFixed(1)}, 1.0);
      }`,

    /** Straight copy, used for the halving steps that build the small
     *  background: bilinear sampling at half size averages 2x2, so repeated
     *  halving is a proper box pyramid rather than point sampling. */
    resample: `${HEADER}
      out vec4 outColour;
      void main() { outColour = texture(uSource, vUV); }`,

    /** Separable box mean.
     *
     *  The loop is bounded by the uniform, not by a constant with the extra
     *  iterations skipped: GLSL ES 3.00 allows that, and the constant-bound
     *  form ran 129 times whatever the radius, which cost more than every
     *  other pass in the filter combined. */
    boxBlur: `${HEADER}
      uniform int uRadius;
      out vec4 outColour;
      void main() {
        vec4 sum = vec4(0.0);
        for (int i = -uRadius; i <= uRadius; i++) {
          sum += texture(uSource, vUV + uTexel * float(i));
        }
        outColour = sum / float(uRadius * 2 + 1);
      }`,

    /** Separable morphological max, then min, gives the close that removes the
     *  writing from the illumination estimate. A square element rather than
     *  the reference's ellipse: separability is what makes it affordable, and
     *  the wide blur that follows removes the difference. */
    dilate: `${HEADER}
      uniform int uRadius;
      out vec4 outColour;
      void main() {
        float best = -1e9;
        for (int i = -uRadius; i <= uRadius; i++) {
          best = max(best, texture(uSource, vUV + uTexel * float(i)).r);
        }
        outColour = vec4(best, 0.0, 0.0, 1.0);
      }`,
    erode: `${HEADER}
      uniform int uRadius;
      out vec4 outColour;
      void main() {
        float best = 1e9;
        for (int i = -uRadius; i <= uRadius; i++) {
          best = min(best, texture(uSource, vUV + uTexel * float(i)).r);
        }
        outColour = vec4(best, 0.0, 0.0, 1.0);
      }`,

    /** Gaussian, separable, weights evaluated inline. */
    gaussian: `${HEADER}
      uniform int uRadius;
      uniform float uSigma;
      out vec4 outColour;
      void main() {
        float sum = 0.0;
        float weightSum = 0.0;
        for (int i = -uRadius; i <= uRadius; i++) {
          float x = float(i) / uSigma;
          float w = exp(-0.5 * x * x);
          sum += texture(uSource, vUV + uTexel * float(i)).r * w;
          weightSum += w;
        }
        outColour = vec4(sum / weightSum, 0.0, 0.0, 1.0);
      }`,

    /** Lab luma and the illumination field -> reflectance, relative to clean
     *  paper. The gain is clipped and eased toward 1, so shading is softened
     *  rather than erased. The background is sampled at its own small size and
     *  upscaled by the hardware for free. */
    reflectance: `${HEADER}
      uniform sampler2D uBackground;
      uniform float uPaperLevel;
      uniform vec2 uGainRange;
      uniform float uFlattenStrength;
      out vec4 outColour;
      void main() {
        vec4 lab = texture(uSource, vUV);
        float background = texture(uBackground, vUV).r * ${LAB_L_SCALE.toFixed(1)};
        float gain = clamp(uPaperLevel / max(background, 1.0), uGainRange.x, uGainRange.y);
        gain = 1.0 + (gain - 1.0) * uFlattenStrength;
        float reflectance = lab.x * ${LAB_L_SCALE.toFixed(1)} * gain / max(uPaperLevel, 1.0);
        outColour = vec4(reflectance, lab.y, lab.z, 1.0);
      }`,

    /** (value, value^2) for the guided filter's moments. */
    moments: `${HEADER}
      out vec4 outColour;
      void main() {
        float v = texture(uSource, vUV).r;
        outColour = vec4(v, v * v, 0.0, 1.0);
      }`,

    /** Self-guided coefficients: covariance with itself is the variance, and
     *  the offset reduces to mean - mean*scale. */
    selfCoefficients: `${HEADER}
      uniform float uEps;
      out vec4 outColour;
      void main() {
        vec2 m = texture(uSource, vUV).rg;
        float variance = m.y - m.x * m.x;
        float scale = variance / (variance + uEps);
        outColour = vec4(scale, m.x * (1.0 - scale), 0.0, 1.0);
      }`,

    /** Applies coefficients and blends toward the smoothed result — the
     *  texture-suppression step, which attenuates grain without erasing it. */
    applyDenoise: `${HEADER}
      uniform sampler2D uCoefficients;
      uniform float uStrength;
      out vec4 outColour;
      void main() {
        vec4 lab = texture(uSource, vUV);
        vec2 c = texture(uCoefficients, vUV).rg;
        float smoothed = c.x * lab.x + c.y;
        outColour = vec4(mix(lab.x, smoothed, uStrength), lab.y, lab.z, 1.0);
      }`,

    /** Applies coefficients as the sharpening base, then adds back detail that
     *  is soft-clipped and gated by the ink mask. Fusing the three into one
     *  pass is what keeps the pass count down; they are all pointwise. */
    applySharpen: `${HEADER}
      uniform sampler2D uCoefficients;
      uniform float uWhitePoint;
      uniform float uInkReference;
      uniform float uSoftLimit;
      uniform float uDetailGain;
      out vec4 outColour;
      void main() {
        vec4 lab = texture(uSource, vUV);
        vec2 c = texture(uCoefficients, vUV).rg;
        float base = c.x * lab.x + c.y;
        float ink = clamp((uWhitePoint - lab.x) / max(uWhitePoint - uInkReference, 1e-6), 0.0, 1.0);
        float detail = tanh((lab.x - base) / uSoftLimit) * uSoftLimit;
        outColour = vec4(base + detail * (1.0 + uDetailGain * ink), lab.y, lab.z, 1.0);
      }`,

    /** Chroma moments: both channels and both guide products in one texture,
     *  so one blur pair serves all four. */
    chromaMoments: `${HEADER}
      out vec4 outColour;
      void main() {
        vec4 lab = texture(uSource, vUV);
        outColour = vec4(lab.y, lab.z, lab.x * lab.y, lab.x * lab.z);
      }`,

    /** Guide moments for the chroma filter, shared by both channels. */
    chromaCoefficients: `${HEADER}
      uniform sampler2D uGuideMoments;
      uniform float uEps;
      out vec4 outColour;
      void main() {
        vec2 guide = texture(uGuideMoments, vUV).rg;
        vec4 m = texture(uSource, vUV);
        float variance = guide.y - guide.x * guide.x;
        vec2 covariance = m.zw - guide.x * m.xy;
        vec2 scale = covariance / (variance + uEps);
        vec2 offset = m.xy - scale * guide.x;
        outColour = vec4(scale.x, offset.x, scale.y, offset.y);
      }`,

    /** Chroma: blend toward the smoothed channels, apply the gain, and hold
     *  the result inside the Lab range. */
    applyChroma: `${HEADER}
      uniform sampler2D uCoefficients;
      uniform float uStrength;
      uniform float uGain;
      out vec4 outColour;
      void main() {
        vec4 lab = texture(uSource, vUV);
        vec4 c = texture(uCoefficients, vUV);
        vec2 smoothed = vec2(c.x * lab.x + c.y, c.z * lab.x + c.w);
        vec2 graded = mix(lab.yz, smoothed, uStrength) * uGain;
        float limit = 110.0 / ${LAB_AB_SCALE.toFixed(1)};
        outColour = vec4(lab.x, clamp(graded, -limit, limit), 1.0);
      }`,

    /** Tone curve and back to RGB, fused into the draw that produces the
     *  output image. A partial smoothstep into a safe range, blended back
     *  toward the input so neither end clips. */
    tone: `${HEADER}${COLOUR}
      uniform vec2 uBlackWhite;
      uniform vec2 uOutputRange;
      uniform float uContrastShape;
      uniform float uToneStrength;
      out vec4 outColour;
      void main() {
        vec4 lab = texture(uSource, vUV);
        float span = max(uBlackWhite.y - uBlackWhite.x, 1e-6);
        float linear = clamp((lab.x - uBlackWhite.x) / span, 0.0, 1.0);
        float shaped = linear * linear * (3.0 - 2.0 * linear);
        float curved = mix(linear, shaped, uContrastShape);
        float graded = uOutputRange.x + curved * (uOutputRange.y - uOutputRange.x);
        float tone = clamp(mix(lab.x, graded, uToneStrength), 0.0, 1.0);
        vec3 rgb = labToRgb(vec3(tone * ${LAB_L_SCALE.toFixed(1)},
                                 lab.y * ${LAB_AB_SCALE.toFixed(1)},
                                 lab.z * ${LAB_AB_SCALE.toFixed(1)}));
        outColour = vec4(rgb, 1.0);
      }`,
  };

  // ------------------------------------------------------------------
  // Context
  // ------------------------------------------------------------------

  let context = null;
  let unsupportedReason = null;

  function createContext() {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      depth: false,
      stencil: false,
      // toBlob reads the drawing buffer after the draw has been submitted, and
      // the filter writes opaque pixels, so both of these are required for the
      // exported JPEG to match what was rendered.
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    });
    if (!gl) throw new Error("WebGL2 is unavailable");
    if (!gl.getExtension("EXT_color_buffer_float")) {
      throw new Error("Float render targets are unavailable");
    }
    gl.getExtension("OES_texture_float_linear");

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    // One oversized triangle rather than two: fewer vertices, no seam.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const programs = {};
    for (const name of Object.keys(SHADER_SOURCE)) {
      programs[name] = buildProgram(gl, SHADER_SOURCE[name]);
    }
    for (const name of Object.keys(programs)) {
      programs[name].locations = readLocations(gl, programs[name], SHADER_SOURCE[name]);
    }
    return { canvas, gl, quad, programs, targets: new Map(), sourceTexture: null, sourceSize: null };
  }

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error("Shader failed to compile: " + log);
    }
    return shader;
  }

  /** Uniform and attribute locations, looked up once per program. These are
   *  synchronous driver queries; asking for them per pass, across three dozen
   *  passes an image, costs more than some of the passes do. */
  function readLocations(gl, program, source) {
    const locations = { aPosition: gl.getAttribLocation(program, "aPosition"), uniforms: {} };
    const names = source.match(/uniform\s+\w+\s+(\w+)/g) || [];
    for (const declaration of names) {
      const name = declaration.split(/\s+/).pop();
      locations.uniforms[name] = gl.getUniformLocation(program, name);
    }
    return locations;
  }

  function buildProgram(gl, fragmentSource) {
    const program = gl.createProgram();
    const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error("Program failed to link: " + log);
    }
    return program;
  }

  /** Render targets are pooled by name: a page is filtered many times in a
   *  batch and the sizes repeat, so allocating per call would dominate. */
  function targetFor(name, width, height, format) {
    const { gl, targets } = context;
    const existing = targets.get(name);
    if (existing && existing.width === width && existing.height === height &&
        existing.format === format) {
      return existing;
    }
    if (existing) {
      gl.deleteTexture(existing.texture);
      gl.deleteFramebuffer(existing.framebuffer);
    }
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, format, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("Render target is unsupported on this device");
    }
    const target = { texture, framebuffer, width, height, format };
    targets.set(name, target);
    return target;
  }

  /**
   * Draws one full-screen pass.
   * @param options { program, source, target, uniforms, textures }
   *                `target` null renders to the canvas itself
   */
  function runPass(options) {
    const { gl, quad, programs } = context;
    const { program: name, source, target, uniforms, textures } = options;
    const program = programs[name];
    const { locations } = program;
    const width = target ? target.width : context.canvas.width;
    const height = target ? target.height : context.canvas.height;

    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(locations.aPosition);
    gl.vertexAttribPointer(locations.aPosition, 2, gl.FLOAT, false, 0, 0);

    bindTexture(locations, "uSource", source, 0);
    let unit = 1;
    for (const key of Object.keys(textures || {})) {
      bindTexture(locations, key, textures[key], unit++);
    }
    setUniform(locations, "uTexel", uniforms && uniforms.uTexel
      ? uniforms.uTexel : [1 / width, 1 / height]);
    for (const key of Object.keys(uniforms || {})) {
      if (key !== "uTexel") setUniform(locations, key, uniforms[key]);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function bindTexture(locations, name, texture, unit) {
    const { gl } = context;
    const location = locations.uniforms[name];
    if (!location) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(location, unit);
  }

  // Declared, never inferred from the value: uSigma is a float uniform whose
  // value is often whole, and uniform1i on it would be silently wrong.
  const INTEGER_UNIFORMS = new Set(["uRadius"]);

  function setUniform(locations, name, value) {
    const { gl } = context;
    const location = locations.uniforms[name];
    if (!location) return;
    if (Array.isArray(value)) {
      if (value.length === 2) gl.uniform2f(location, value[0], value[1]);
      else gl.uniform4f(location, value[0], value[1], value[2], value[3]);
    } else if (INTEGER_UNIFORMS.has(name)) {
      gl.uniform1i(location, value);
    } else {
      gl.uniform1f(location, value);
    }
  }

  // ------------------------------------------------------------------
  // Stages
  // ------------------------------------------------------------------

  function radiusFor(fraction, width, height) {
    return Math.max(1, Math.round(fraction * Math.min(width, height)));
  }

  /** Separable blur: horizontal into scratch, vertical back out. */
  function blurSeparable(program, source, scratch, destination, radius, extra) {
    const uniformsX = Object.assign({ uRadius: radius, uTexel: [1 / scratch.width, 0] }, extra);
    runPass({ program, source, target: scratch, uniforms: uniformsX });
    const uniformsY = Object.assign({ uRadius: radius, uTexel: [0, 1 / destination.height] }, extra);
    runPass({ program, source: scratch.texture, target: destination, uniforms: uniformsY });
  }

  /**
   * The illumination across the sheet, at BACKGROUND_EDGE. Halving repeatedly
   * before the final step keeps the downscale a box average rather than point
   * sampling, which would alias the writing into the estimate.
   */
  function estimateBackground(labTexture, width, height) {
    const shortSide = Math.min(width, height);
    const scale = Math.min(1, BACKGROUND_EDGE / shortSide);
    const smallWidth = Math.max(8, Math.round(width * scale));
    const smallHeight = Math.max(8, Math.round(height * scale));

    let source = labTexture;
    let level = 0;
    let currentWidth = width;
    let currentHeight = height;
    while (currentWidth >= smallWidth * 2 && currentHeight >= smallHeight * 2) {
      currentWidth = Math.max(smallWidth, currentWidth >> 1);
      currentHeight = Math.max(smallHeight, currentHeight >> 1);
      const step = targetFor(`halve${level % 2}`, currentWidth, currentHeight, gl().RGBA16F);
      runPass({ program: "resample", source, target: step });
      source = step.texture;
      level++;
    }
    const small = targetFor("background", smallWidth, smallHeight, gl().RGBA16F);
    const scratch = targetFor("backgroundScratch", smallWidth, smallHeight, gl().RGBA16F);
    runPass({ program: "resample", source, target: small });

    const radius = radiusFor(PARAMS.backgroundRadius, width, height);
    const smallRadius = Math.max(1, Math.round(radius * scale));
    // Close = dilate then erode; each is separable over a square element.
    blurSeparable("dilate", small.texture, scratch, small, smallRadius);
    blurSeparable("erode", small.texture, scratch, small, smallRadius);
    blurSeparable("gaussian", small.texture, scratch, small, smallRadius,
      { uSigma: Math.max(1, smallRadius) });
    return small;
  }

  /**
   * The brightness clean paper sits at, as a percentile of the sheet.
   *
   * Read from the source on the CPU rather than from the finished background
   * on the GPU. Reading a texture back mid-pipeline stalls everything queued
   * behind it — measured at 8ms, a third of the whole filter — to recover one
   * scalar. A coarse grid of the photo estimates the same percentile for
   * nothing: it is a robust statistic of a smooth field, and the illumination
   * estimate the reference takes it from barely moves the bright end it sits
   * on.
   */
  function paperLevelOf(imageData) {
    const pixels = imageData.data;
    const total = imageData.width * imageData.height;
    const stride = Math.max(1, Math.floor(total / PERCENTILE_SAMPLES));
    const histogram = new Uint32Array(PERCENTILE_BINS);
    const lastBin = PERCENTILE_BINS - 1;
    let counted = 0;
    for (let index = 0; index < total; index += stride) {
      const at = index * 4;
      const luminance = relativeLuminance(pixels[at], pixels[at + 1], pixels[at + 2]);
      const lightness = 116 * labF(luminance) - 16;
      const bin = (lightness / LAB_L_SCALE) * lastBin;
      histogram[bin < 0 ? 0 : bin > lastBin ? lastBin : bin | 0]++;
      counted++;
    }
    const target = (PARAMS.paperPercentile / 100) * counted;
    let seen = 0;
    for (let bin = 0; bin < PERCENTILE_BINS; bin++) {
      seen += histogram[bin];
      if (seen >= target) return (bin / lastBin) * LAB_L_SCALE;
    }
    return LAB_L_SCALE;
  }

  /** The Y of CIE XYZ for an 8-bit sRGB triple — Lab's lightness depends on
   *  nothing else. Mirrors the shader's rgbToLab so the two agree. */
  function relativeLuminance(red, green, blue) {
    return 0.212671 * srgbToLinear(red / 255) +
           0.715160 * srgbToLinear(green / 255) +
           0.072169 * srgbToLinear(blue / 255);
  }

  function srgbToLinear(channel) {
    return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  }

  function labF(value) {
    return value > 0.008856 ? Math.cbrt(value) : (7.787 * value + 16 / 116);
  }

  /** A guided self-filter, leaving its coefficients in the returned target. */
  function guidedSelfCoefficients(source, width, height, radius, eps, names) {
    const format = gl().RG32F;
    const moments = targetFor(names.moments, width, height, format);
    const scratch = targetFor(names.scratch, width, height, format);
    const coefficients = targetFor(names.coefficients, width, height, format);
    runPass({ program: "moments", source, target: moments });
    blurSeparable("boxBlur", moments.texture, scratch, moments, radius);
    runPass({ program: "selfCoefficients", source: moments.texture, target: coefficients,
      uniforms: { uEps: eps } });
    blurSeparable("boxBlur", coefficients.texture, scratch, coefficients, radius);
    return coefficients;
  }

  function gl() { return context.gl; }

  // ------------------------------------------------------------------
  // Public surface
  // ------------------------------------------------------------------

  /** Whether this device can run the filter at all. Probed once and cached;
   *  the Natural flash setting hides itself when this is false. */
  function isSupported() {
    if (context) return true;
    if (unsupportedReason) return false;
    try {
      context = createContext();
      return true;
    } catch (error) {
      unsupportedReason = error.message;
      return false;
    }
  }

  function unsupportedMessage() { return unsupportedReason; }

  /** Forgets a dead context so isSupported() builds a fresh one. Nothing is
   *  deleted through the old context: its resources died with it. */
  function discardContext() { context = null; }

  /**
   * Enhances a scan. Takes the warped pixels as ImageData — much the cheapest
   * upload path — and returns a canvas holding the result, ready to encode.
   *
   * The returned canvas is a fresh one the caller owns. Rendering happens into
   * a single reused drawing buffer, and pages are rendered concurrently, so
   * handing that buffer out directly would let one page overwrite another
   * before its encode had read it. The copy is a blit and costs ~0.15ms.
   */
  function apply(imageData) {
    if (!isSupported()) throw new Error(unsupportedReason);
    // A lost context draws nothing without reporting anything, which would
    // save a blank page. Failing here instead lets the caller mark the render
    // failed, and dropping the context makes the next attempt rebuild it.
    if (context.gl.isContextLost()) {
      discardContext();
      throw new Error("The graphics context was lost");
    }
    const context2d = gl();
    const width = imageData.width;
    const height = imageData.height;
    if (context.canvas.width !== width || context.canvas.height !== height) {
      context.canvas.width = width;
      context.canvas.height = height;
    }
    uploadSource(imageData);

    const lab = targetFor("lab", width, height, context2d.RGBA16F);
    const working = targetFor("working", width, height, context2d.RGBA16F);
    runPass({ program: "toLab", source: context.sourceTexture, target: lab });

    const background = estimateBackground(lab.texture, width, height);
    const paperLevel = paperLevelOf(imageData);
    runPass({ program: "reflectance", source: lab.texture, target: working,
      textures: { uBackground: background.texture },
      uniforms: { uPaperLevel: paperLevel, uFlattenStrength: PARAMS.flattenStrength,
        uGainRange: [PARAMS.gainMinimum, PARAMS.gainMaximum] } });

    const denoiseRadius = radiusFor(PARAMS.denoiseRadius, width, height);
    const denoise = guidedSelfCoefficients(working.texture, width, height, denoiseRadius,
      PARAMS.denoiseEps, { moments: "dnMoments", scratch: "dnScratch", coefficients: "dnCoefficients" });
    runPass({ program: "applyDenoise", source: working.texture, target: lab,
      textures: { uCoefficients: denoise.texture },
      uniforms: { uStrength: PARAMS.denoiseStrength } });

    const detailRadius = radiusFor(PARAMS.detailRadius, width, height);
    const detail = guidedSelfCoefficients(lab.texture, width, height, detailRadius,
      PARAMS.detailEps, { moments: "shMoments", scratch: "shScratch", coefficients: "shCoefficients" });
    runPass({ program: "applySharpen", source: lab.texture, target: working,
      textures: { uCoefficients: detail.texture },
      uniforms: { uWhitePoint: PARAMS.whitePoint, uInkReference: PARAMS.inkReference,
        uSoftLimit: PARAMS.detailSoftLimit, uDetailGain: PARAMS.detailGain } });

    gradeChroma(working, lab, width, height);

    runPass({ program: "tone", source: lab.texture, target: null,
      uniforms: { uBlackWhite: [PARAMS.blackPoint, PARAMS.whitePoint],
        uOutputRange: [PARAMS.outputBlack, PARAMS.outputWhite],
        uContrastShape: PARAMS.contrastShape, uToneStrength: PARAMS.toneStrength } });

    const output = document.createElement("canvas");
    output.width = width;
    output.height = height;
    output.getContext("2d").drawImage(context.canvas, 0, 0);
    return output;
  }

  /** Chroma, guided by the sharpened reflectance, at half resolution: it is
   *  being denoised, and the eye carries little colour detail. Result lands in
   *  `destination`. */
  function gradeChroma(sharpened, destination, width, height) {
    const context2d = gl();
    const smallWidth = Math.max(8, Math.round(width / CHROMA_DIVISOR));
    const smallHeight = Math.max(8, Math.round(height / CHROMA_DIVISOR));
    const radius = Math.max(1,
      Math.round(radiusFor(PARAMS.chromaRadius, width, height) / CHROMA_DIVISOR));

    const small = targetFor("chromaSmall", smallWidth, smallHeight, context2d.RGBA16F);
    runPass({ program: "resample", source: sharpened.texture, target: small });

    const guideMoments = targetFor("chGuide", smallWidth, smallHeight, context2d.RG32F);
    const guideScratch = targetFor("chGuideScratch", smallWidth, smallHeight, context2d.RG32F);
    runPass({ program: "moments", source: small.texture, target: guideMoments });
    blurSeparable("boxBlur", guideMoments.texture, guideScratch, guideMoments, radius);

    const moments = targetFor("chMoments", smallWidth, smallHeight, context2d.RGBA32F);
    const scratch = targetFor("chScratch", smallWidth, smallHeight, context2d.RGBA32F);
    runPass({ program: "chromaMoments", source: small.texture, target: moments });
    blurSeparable("boxBlur", moments.texture, scratch, moments, radius);

    const coefficients = targetFor("chCoefficients", smallWidth, smallHeight, context2d.RGBA32F);
    runPass({ program: "chromaCoefficients", source: moments.texture, target: coefficients,
      textures: { uGuideMoments: guideMoments.texture }, uniforms: { uEps: PARAMS.chromaEps } });
    blurSeparable("boxBlur", coefficients.texture, scratch, coefficients, radius);

    runPass({ program: "applyChroma", source: sharpened.texture, target: destination,
      textures: { uCoefficients: coefficients.texture },
      uniforms: { uStrength: PARAMS.chromaDenoiseStrength, uGain: PARAMS.chromaGain } });
  }

  function uploadSource(imageData) {
    const context2d = gl();
    const { width, height } = imageData;
    const sizeChanged = !context.sourceSize ||
      context.sourceSize.width !== width || context.sourceSize.height !== height;
    if (sizeChanged) {
      if (context.sourceTexture) context2d.deleteTexture(context.sourceTexture);
      context.sourceTexture = context2d.createTexture();
      context2d.bindTexture(context2d.TEXTURE_2D, context.sourceTexture);
      context2d.texStorage2D(context2d.TEXTURE_2D, 1, context2d.RGBA8, width, height);
      context2d.texParameteri(context2d.TEXTURE_2D, context2d.TEXTURE_MIN_FILTER, context2d.LINEAR);
      context2d.texParameteri(context2d.TEXTURE_2D, context2d.TEXTURE_MAG_FILTER, context2d.LINEAR);
      context2d.texParameteri(context2d.TEXTURE_2D, context2d.TEXTURE_WRAP_S, context2d.CLAMP_TO_EDGE);
      context2d.texParameteri(context2d.TEXTURE_2D, context2d.TEXTURE_WRAP_T, context2d.CLAMP_TO_EDGE);
      context.sourceSize = { width, height };
    } else {
      context2d.bindTexture(context2d.TEXTURE_2D, context.sourceTexture);
    }
    // ImageData's first row is the top of the picture; a GL texture's is the
    // bottom. Flipping once here puts every later pass, and the drawing buffer
    // the result is read back from, in the same orientation.
    context2d.pixelStorei(context2d.UNPACK_FLIP_Y_WEBGL, true);
    context2d.texSubImage2D(context2d.TEXTURE_2D, 0, 0, 0, width, height,
      context2d.RGBA, context2d.UNSIGNED_BYTE, imageData);
    context2d.pixelStorei(context2d.UNPACK_FLIP_Y_WEBGL, false);
  }

  window.GpuEnhance = { isSupported, unsupportedMessage, apply };
})();
