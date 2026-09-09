/* worker/guided-filter.js — edge-aware smoothing (He, Sun & Tang).
 *
 * Smooths an image without crossing the edges in a guide image. Where the
 * guide is flat the output is its local mean; where the guide has structure
 * the output follows it. That is what lets the enhancement attenuate paper
 * grain while leaving the sides of a pen stroke alone.
 *
 * Everything is expressed as OpenCV whole-image operations rather than loops
 * over the pixel data. That is not stylistic: measured at 2 MP in this build,
 * a JavaScript pass costs ~35ms where the equivalent cv.multiply costs ~2.6ms,
 * so the arithmetic here would otherwise dominate the whole filter.
 *
 * Single-channel CV_32FC1 throughout. Callers supply scratch Mats so a
 * pipeline that filters several times allocates once, not once per pass.
 *
 * Loaded into the worker's global scope by scan-worker.js.
 */
"use strict";

/** Mean over a (2r+1) square. OpenCV uses running sums, so the radius is
 *  almost free. Safe in place — verified bit-identical against a copy. */
function guidedBoxMean(source, destination, radius) {
  const side = 2 * radius + 1;
  cv.boxFilter(source, destination, -1, new cv.Size(side, side),
    new cv.Point(-1, -1), true, cv.BORDER_REFLECT);
}

/**
 * The guide's local mean and variance, which every channel filtered through
 * the same guide can share.
 *
 * @param scratch { tmp } — one CV_32FC1 Mat, left dirty
 * @param out { mean, variance } — filled in; neither may alias `scratch.tmp`
 */
function guidedMoments(guide, radius, scratch, out) {
  guidedBoxMean(guide, out.mean, radius);
  cv.multiply(guide, guide, scratch.tmp);
  guidedBoxMean(scratch.tmp, out.variance, radius);
  cv.multiply(out.mean, out.mean, scratch.tmp);
  cv.subtract(out.variance, scratch.tmp, out.variance);
}

/** The filtered image is mean(scale)*guide + mean(offset). Both coefficient
 *  maps are averaged in place, which is what makes the extra buffers the
 *  textbook form needs unnecessary. */
function guidedApply(guide, radius, scratch, destination) {
  guidedBoxMean(scratch.scale, scratch.scale, radius);
  guidedBoxMean(scratch.offset, scratch.offset, radius);
  cv.multiply(scratch.scale, guide, scratch.tmp);
  cv.add(scratch.tmp, scratch.offset, destination);
}

/**
 * Filters `source` using itself as the guide.
 *
 * Self-guiding collapses half the work: the covariance of an image with itself
 * *is* its variance, and the offset reduces to mean - mean*scale.
 *
 * @param scratch { tmp, mean, variance, scale, offset } — CV_32FC1, source-sized
 */
function guidedSelfFilter(source, radius, eps, scratch, destination) {
  guidedMoments(source, radius, scratch,
    { mean: scratch.mean, variance: scratch.variance });
  // scale = variance / (variance + eps)
  scratch.variance.convertTo(scratch.tmp, -1, 1, eps);
  cv.divide(scratch.variance, scratch.tmp, scratch.scale);
  // offset = mean * (1 - scale)
  cv.multiply(scratch.mean, scratch.scale, scratch.tmp);
  cv.subtract(scratch.mean, scratch.tmp, scratch.offset);
  guidedApply(source, radius, scratch, destination);
}

/**
 * Filters `source` through a separate guide whose moments were already
 * computed. Splitting the moments out is what lets two chroma channels share
 * one guide instead of recomputing it.
 *
 * @param moments { mean, variance } — from guidedMoments on the guide
 * @param scratch adds { meanSource } to the set guidedSelfFilter needs
 */
function guidedByReference(guide, moments, source, radius, eps, scratch, destination) {
  guidedBoxMean(source, scratch.meanSource, radius);
  cv.multiply(guide, source, scratch.tmp);
  guidedBoxMean(scratch.tmp, scratch.mean, radius); // mean of guide*source
  // covariance = mean(guide*source) - mean(guide)*mean(source)
  cv.multiply(moments.mean, scratch.meanSource, scratch.tmp);
  cv.subtract(scratch.mean, scratch.tmp, scratch.mean);
  // scale = covariance / (guide variance + eps)
  moments.variance.convertTo(scratch.tmp, -1, 1, eps);
  cv.divide(scratch.mean, scratch.tmp, scratch.scale);
  // offset = mean(source) - scale * mean(guide)
  cv.multiply(scratch.scale, moments.mean, scratch.tmp);
  cv.subtract(scratch.meanSource, scratch.tmp, scratch.offset);
  guidedApply(guide, radius, scratch, destination);
}
