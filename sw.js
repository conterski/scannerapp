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

// <stamp> Written by scripts/stamp.sh at deploy; do not edit by hand.
const VERSION = "unstamped";
const VENDOR_VERSION = "unstamped";
const PRECACHE = [];
// </stamp>

const APP_CACHE = `scannerapp-app-${VERSION}`;
const VENDOR_CACHE = `scannerapp-vendor-${VENDOR_VERSION}`;
const OWN_CACHES = /^scannerapp-/;
const NAVIGATION_TIMEOUT_MS = 3000;

/** WebAssembly SIMD, checked the way the scan worker checks it, so only the
 *  OpenCV variant this device will load is held. */
function supportsSimd() {
  return WebAssembly.validate(new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
}

const UNUSED_VARIANT = supportsSimd() ? "/scalar/" : "/simd/";
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
