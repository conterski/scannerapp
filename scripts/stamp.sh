#!/usr/bin/env bash
# stamp.sh — points a copy of the site at one exact build: every js/ and css/
# URL in index.html gets ?v=<app stamp>, and sw.js is told both stamps and
# every file it must hold for offline use, spelled as the page will ask for
# them. deploy.sh runs it with stamps taken from the commit being deployed;
# the offline test runs it on a copy of the working tree.
#
#   scripts/stamp.sh <app stamp> <vendor stamp> [site root, default: this repo]
set -euo pipefail

app_stamp=$1
vendor_stamp=$2
root=${3:-$(cd "$(dirname "$0")/.." && pwd)}
cd "$root"

sed -i -E "s#(src=\"js/[A-Za-z0-9_-]+\.js)(\?v=[^\"]*)?\"#\1?v=$app_stamp\"#g" index.html
sed -i -E "s#(href=\"css/[A-Za-z0-9_-]+\.css)(\?v=[^\"]*)?\"#\1?v=$app_stamp\"#g" index.html

# The page, what it links, the app's scripts and styles (the scan worker
# stamps its own and its modules' URLs the same way), and the engines.
precache=$(
  {
    echo index.html
    echo manifest.json
    ls icon-*.png
    find js css -type f \( -name '*.js' -o -name '*.css' \) | sed "s/\$/?v=$app_stamp/"
    find vendor -type f
  } | LC_ALL=C sort | sed 's/.*/  "&",/'
)

BLOCK=$(printf 'const VERSION = "%s";\nconst VENDOR_VERSION = "%s";\nconst PRECACHE = [\n%s\n];' "$app_stamp" "$vendor_stamp" "$precache") \
awk '
  /^\/\/ <stamp>/ { print; print ENVIRON["BLOCK"]; skipping = 1; next }
  /^\/\/ <\/stamp>/ { skipping = 0 }
  !skipping { print }
' sw.js > sw.js.stamped
mv sw.js.stamped sw.js
