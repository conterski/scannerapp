/* worker/opencv-variant.js — which of the two OpenCV builds this engine runs
 * (scripts/build-opencv.sh makes both): "simd" where WebAssembly SIMD is
 * there (Safari 16.4 and later), else "scalar". One definition for the scan
 * worker, which loads the build, and the service worker, which holds it for
 * offline use — were they to disagree, the one held would not be the one
 * loaded.
 *
 * Loaded into a worker's global scope with importScripts.
 */
"use strict";

/** A module using a SIMD instruction validates only where the engine has
 *  them. */
function openCvVariant() {
  const usesSimd = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
  return WebAssembly.validate(usesSimd) ? "simd" : "scalar";
}
