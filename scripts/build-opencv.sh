#!/usr/bin/env bash
# build-opencv.sh — builds the OpenCV.js the app vendors: only the core and
# imgproc functions the worker calls (scripts/opencv_js.config.py), with the
# WebAssembly in its own file, fetched and compiled by the browser as such
# rather than decoded out of base64 inside the script. Two variants, since the
# worker picks one at runtime: "simd" for browsers with WebAssembly SIMD
# (Safari 16.4+) and "scalar" for the rest.
#
#   scripts/build-opencv.sh            # both variants into vendor/opencv-<version>-<hash>/
#   WORK=/tmp/cv scripts/build-opencv.sh
#
# The output directory is named by a hash of what the build is made from —
# the versions, the build options and the whitelist — and the name is written
# into the worker
# (OPENCV_BUILD in js/scan-worker.js). The files are served unstamped, so a
# rebuild that changed them must change their URL, or a browser holding the
# old build would pair it with a worker calling functions it lacks.
#
# Needs git, python3, cmake and make; the Emscripten SDK is fetched into
# $WORK. Pinned on purpose: the detector's results are measured against this
# exact OpenCV, and a toolchain change is a change to verify, not a drift.
set -euo pipefail

OPENCV_VERSION=4.13.0
EMSDK_VERSION=3.1.74

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-"$ROOT/.opencv-build"}
CONFIG="$ROOT/scripts/opencv_js.config.py"
BUILD_OPTIONS=(
  --build_wasm --disable_single_file
  --cmake_option=-DBUILD_LIST=core,imgproc,js
  --cmake_option=-DBUILD_EXAMPLES=OFF
  --cmake_option=-DBUILD_TESTS=OFF
  --cmake_option=-DBUILD_PERF_TESTS=OFF
)
BUILD_HASH=$({ echo "$OPENCV_VERSION $EMSDK_VERSION ${BUILD_OPTIONS[*]}"; cat "$CONFIG"; } | sha1sum | cut -c1-8)
BUILD_NAME="opencv-$OPENCV_VERSION-$BUILD_HASH"
OUT="$ROOT/vendor/$BUILD_NAME"

mkdir -p "$WORK"
[ -d "$WORK/emsdk" ] || git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$WORK/emsdk"
"$WORK/emsdk/emsdk" install "$EMSDK_VERSION"
"$WORK/emsdk/emsdk" activate "$EMSDK_VERSION"
# shellcheck disable=SC1091
source "$WORK/emsdk/emsdk_env.sh"

[ -d "$WORK/opencv" ] ||
  git clone --depth 1 --branch "$OPENCV_VERSION" https://github.com/opencv/opencv.git "$WORK/opencv"

build() {
  local variant=$1; shift
  local dir="$WORK/build-$variant"
  emcmake python3 "$WORK/opencv/platforms/js/build_js.py" "$dir" --config "$CONFIG" "${BUILD_OPTIONS[@]}" "$@"
  mkdir -p "$OUT/$variant"
  install -m 644 "$dir/bin/opencv.js" "$dir/bin/opencv_js.wasm" "$OUT/$variant/"
}

build scalar
build simd --simd

# Earlier builds go; the worker is pointed at this one.
find "$ROOT/vendor" -maxdepth 1 -type d -name 'opencv-*' ! -name "$BUILD_NAME" -exec rm -rf {} +
sed -i -E "s#^const OPENCV_BUILD = \"[^\"]*\";#const OPENCV_BUILD = \"$BUILD_NAME\";#" "$ROOT/js/scan-worker.js"

ls -l "$OUT"/*/
