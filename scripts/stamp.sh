#!/usr/bin/env bash
# stamp.sh — points a copy of the site at one exact build: every js/ and css/
# URL in index.html gets ?v=<app stamp> and every top-level vendor script
# ?v=<vendor stamp>, and sw.js is told both stamps and every file it must
# hold for offline use, spelled as the page will ask for them. deploy.sh runs
# it on the repository with stamps taken from the commit being deployed; the
# offline test runs it on a copy of the working tree.
#
#   scripts/stamp.sh <app stamp> <vendor stamp> [site root, default: this repo]
set -euo pipefail

app_stamp=$1
vendor_stamp=$2
root=$(cd "${3:-$(dirname "$0")/..}" && pwd)
cd "$root"

sed -i -E "s#(src=\"js/[A-Za-z0-9_-]+\.js)(\?v=[^\"]*)?\"#\1?v=$app_stamp\"#g" index.html
sed -i -E "s#(href=\"css/[A-Za-z0-9_-]+\.css)(\?v=[^\"]*)?\"#\1?v=$app_stamp\"#g" index.html
sed -i -E "s#(src=\"vendor/[A-Za-z0-9_.-]+\.js)(\?v=[^\"]*)?\"#\1?v=$vendor_stamp\"#g" index.html

# The files being deployed: the commit's, where this is the repository — a
# file left uncommitted or ignored (a .DS_Store) is not on the server, and one
# missing file fails the whole offline install — or else all of the copy's.
if [ "$(git rev-parse --show-toplevel 2>/dev/null)" = "$root" ]; then
  files=$(git ls-tree -r --name-only HEAD)
else
  files=$(find . -type f | sed 's#^\./##')
fi

# The page, what it links, the app's scripts and styles (the scan worker
# stamps its own and its modules' URLs the same way), and the engines: the
# top-level ones stamped as index.html now asks for them, OpenCV's in its
# build-named folder as the worker asks for them.
precache=$(
  printf '%s\n' "$files" | LC_ALL=C sort | awk -v app="$app_stamp" -v vendor="$vendor_stamp" '
    /^(index\.html|manifest\.json|icon-[^\/]*\.png)$/ { print; next }
    /^(js\/.*\.js|css\/.*\.css)$/                     { print $0 "?v=" app; next }
    /^vendor\/[^\/]*\.js$/                            { print $0 "?v=" vendor; next }
    /^vendor\/opencv-[^\/]*\//                        { print }
  ' | sed 's/.*/  "&",/'
)

BLOCK=$(printf 'const VERSION = "%s";\nconst VENDOR_VERSION = "%s";\nconst PRECACHE = [\n%s\n];' "$app_stamp" "$vendor_stamp" "$precache") \
awk '
  /^\/\/ <stamp>/ { print; print ENVIRON["BLOCK"]; skipping = 1; next }
  /^\/\/ <\/stamp>/ { skipping = 0 }
  !skipping { print }
' sw.js > sw.js.stamped
mv sw.js.stamped sw.js
