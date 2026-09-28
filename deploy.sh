#!/usr/bin/env bash
# deploy.sh — push HEAD and wait until GitHub Pages has built exactly that
# commit. One command, one line of output on success.
#
#   ./deploy.sh
#
# Requires: gh CLI authenticated for github.com/conterski/scannerapp.
set -euo pipefail

REPO="conterski/scannerapp"
URL="https://conterski.github.io/scannerapp/"

# Cache busting. Pages serves everything with max-age=600, so for ten minutes
# after a deploy a browser can pair a fresh index.html with a stale app.js.
# Stamping every js/ and css/ URL with a hash of the app makes each
# index.html ask for exactly the bundle it was built against, so only
# self-consistent versions can be served. The same stamp keys the service
# worker's offline copy of the app, so it covers everything that copy holds —
# the page, the manifest and the icons too, or a change to only those would
# never reach it. The engines are keyed by a hash of vendor/ instead
# (scripts/stamp.sh writes both into index.html and sw.js).
#
# The hashes come from HEAD, not the working copy: they must describe what is
# actually being deployed, and must not change when this script rewrites
# index.html and sw.js a moment later — so the page is hashed with its stamps
# taken out, and deploying the same commit twice stamps it the same.
page=$(git show "HEAD:index.html" | sed -E 's/\?v=[^"]*"/"/g' | git hash-object --stdin)
stamp=$({ git rev-parse "HEAD:js" "HEAD:css" "HEAD:manifest.json" "HEAD:icon-180.png" "HEAD:icon-512.png"; echo "$page"; } |
  git hash-object --stdin | cut -c1-10)
vendor_stamp=$(git rev-parse "HEAD:vendor" | cut -c1-10)
"$(dirname "$0")/scripts/stamp.sh" "$stamp" "$vendor_stamp"

# Folded into the commit being deployed, so history stays one commit per
# change. Only ever reached when a stamp actually moved, which means the app
# or vendor/ changed, which means this commit is new and not yet on the remote.
amended=0
if ! git diff --quiet -- index.html sw.js; then
  git add index.html sw.js
  git commit --amend --no-edit
  amended=1
fi

sha=$(git rev-parse HEAD)

if [ -n "$(git status --porcelain)" ]; then
  echo "WARNING: uncommitted changes present — deploying HEAD ($sha) without them" >&2
fi

if [ "$amended" = 1 ]; then
  git push --force-with-lease   # the amend replaced the tip
else
  git push
fi

last=""
for _ in $(seq 1 60); do
  last=$(gh api "repos/$REPO/pages/builds/latest" \
    --jq '.status + " " + .commit' 2>/dev/null || echo "api-error")
  if [ "$last" = "built $sha" ]; then
    echo "DEPLOYED: $sha live at $URL"
    exit 0
  fi
  case "$last" in errored*)
    echo "FAILED: Pages build errored for $sha" >&2
    exit 1
  ;; esac
  sleep 10
done

echo "TIMEOUT: Pages build not confirmed after 10 min (last status: $last)" >&2
exit 1
