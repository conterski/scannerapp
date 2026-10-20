/* sw.js — offline use: every file the app needs, held on the device, so the
 * app opens and scans with no network at all — a basement, a warehouse, a
 * plane.
 *
 * Two caches. The app's own files (the page, js/, css/, icons) are held under
 * the deploy's stamp: the same stamp deploy.sh puts on every js/ and css/ URL,
 * so a cache only ever holds one self-consistent build. The vendored engines
 * (OpenCV, jsPDF) are held under a hash of vendor/ instead, so a deploy that
 * leaves them alone does not download 3 MB again.
 *
 * Every URL held is specific to its version — js/ and css/ carry the app's
 * stamp, the top-level engines the vendor stamp, and OpenCV sits in a folder
 * named by its build — so while an old version still serves the page of a
 * newer one, no file of the old can answer for the new.
 *
 * The page is fetched from the network first, so a new deploy shows up at
 * once when online; the cache answers when the network doesn't within
 * NAVIGATION_TIMEOUT_MS. Everything else precached is answered from the
 * cache. A new version installs beside the old one and takes over only when
 * no page of the old one is open — no skipWaiting, no clients.claim — so a
 * running session never mixes two builds, the guarantee the stamp gives.
 *
 * Only a deployed copy registers this (app.js): run from this machine, the
 * files change without the stamp moving, and a cache would serve stale ones.
 */
"use strict";
/* global openCvVariant */

// <stamp> Written by scripts/stamp.sh at deploy; do not edit by hand.
const VERSION = "1d741d4d0e";
const VENDOR_VERSION = "30a1b3a46c";
const PRECACHE = [
  "css/style.css?v=1d741d4d0e",
  "icon-180.png",
  "icon-512.png",
  "index.html",
  "js/app-chrome.js?v=1d741d4d0e",
  "js/app.js?v=1d741d4d0e",
  "js/auto-shutter.js?v=1d741d4d0e",
  "js/camera.js?v=1d741d4d0e",
  "js/capture-guidance.js?v=1d741d4d0e",
  "js/capture-lens.js?v=1d741d4d0e",
  "js/capture-outline.js?v=1d741d4d0e",
  "js/capture-quality.js?v=1d741d4d0e",
  "js/capture-rotation.js?v=1d741d4d0e",
  "js/capture-ui.js?v=1d741d4d0e",
  "js/choice-prompt.js?v=1d741d4d0e",
  "js/detect.js?v=1d741d4d0e",
  "js/editor.js?v=1d741d4d0e",
  "js/export.js?v=1d741d4d0e",
  "js/frame-sharpness.js?v=1d741d4d0e",
  "js/image-utils.js?v=1d741d4d0e",
  "js/job-queue.js?v=1d741d4d0e",
  "js/page-list-view.js?v=1d741d4d0e",
  "js/page-number.js?v=1d741d4d0e",
  "js/page-proportions.js?v=1d741d4d0e",
  "js/page-scroll.js?v=1d741d4d0e",
  "js/persisted-flag.js?v=1d741d4d0e",
  "js/photo-store.js?v=1d741d4d0e",
  "js/pointer-drag.js?v=1d741d4d0e",
  "js/promise-utils.js?v=1d741d4d0e",
  "js/render-tracker.js?v=1d741d4d0e",
  "js/scan-quality.js?v=1d741d4d0e",
  "js/scan-render.js?v=1d741d4d0e",
  "js/scan-worker.js?v=1d741d4d0e",
  "js/share-note.js?v=1d741d4d0e",
  "js/source-cache.js?v=1d741d4d0e",
  "js/store.js?v=1d741d4d0e",
  "js/worker/candidates.js?v=1d741d4d0e",
  "js/worker/edge-fusion.js?v=1d741d4d0e",
  "js/worker/frame.js?v=1d741d4d0e",
  "js/worker/geometry.js?v=1d741d4d0e",
  "js/worker/grid-evidence.js?v=1d741d4d0e",
  "js/worker/line-candidates.js?v=1d741d4d0e",
  "js/worker/opencv-variant.js?v=1d741d4d0e",
  "js/worker/pixel-probes.js?v=1d741d4d0e",
  "js/worker/quad-refine.js?v=1d741d4d0e",
  "js/worker/quad-score.js?v=1d741d4d0e",
  "js/worker/quad-search.js?v=1d741d4d0e",
  "js/worker/side-refit.js?v=1d741d4d0e",
  "js/worker/side-verify.js?v=1d741d4d0e",
  "manifest.json",
  "vendor/jspdf.umd.min.js?v=30a1b3a46c",
  "vendor/opencv-4.13.0-6e9b7a9e/scalar/opencv.js",
  "vendor/opencv-4.13.0-6e9b7a9e/scalar/opencv_js.wasm",
  "vendor/opencv-4.13.0-6e9b7a9e/simd/opencv.js",
  "vendor/opencv-4.13.0-6e9b7a9e/simd/opencv_js.wasm",
];
// </stamp>

// Which OpenCV build this device loads, decided as the scan worker decides it.
importScripts(`js/worker/opencv-variant.js?v=${VERSION}`);

const APP_CACHE = `scannerapp-app-${VERSION}`;
const VENDOR_CACHE = `scannerapp-vendor-${VENDOR_VERSION}`;
const OWN_CACHES = /^scannerapp-/;
const NAVIGATION_TIMEOUT_MS = 3000;

// Only the OpenCV variant this device will load is held.
const UNUSED_VARIANT = openCvVariant() === "simd" ? "/scalar/" : "/simd/";
const isVendor = (path) => path.startsWith("vendor/");

/** Adds whichever of `paths` the cache does not hold yet. */
async function fill(cacheName, paths) {
  const cache = await caches.open(cacheName);
  const held = await Promise.all(paths.map((path) => cache.match(path)));
  await cache.addAll(paths.filter((_, index) => !held[index]));
}

self.addEventListener("install", (event) => {
  const needed = PRECACHE.filter((path) => !path.includes(UNUSED_VARIANT));
  event.waitUntil(Promise.all([
    fill(APP_CACHE, needed.filter((path) => !isVendor(path))),
    fill(VENDOR_CACHE, needed.filter(isVendor)),
  ]));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(names
    .filter((name) => OWN_CACHES.test(name) && name !== APP_CACHE && name !== VENDOR_CACHE)
    .map((name) => caches.delete(name)))));
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); });
  });
}

/** The page from the network while there is one; else the page this
 *  version holds — whose URLs are exactly the ones it holds. */
async function pageFromNetworkFirst(request) {
  try {
    return await withTimeout(fetch(request), NAVIGATION_TIMEOUT_MS);
  } catch (error) {
    const held = await caches.match("index.html", { cacheName: APP_CACHE });
    if (held) return held;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (request.mode === "navigate") {
    event.respondWith(pageFromNetworkFirst(request));
    return;
  }
  event.respondWith(caches.match(request).then((held) => held || fetch(request)));
});
