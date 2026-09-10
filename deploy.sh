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
# Stamping every js/ and css/ URL with a hash of those trees makes each
# index.html ask for exactly the bundle it was built against, so only
# self-consistent versions can be served.
#
# The hash comes from HEAD's trees, not the working copy: it must describe what
# is actually being deployed, and it must not change when this script rewrites
# index.html a moment later.
stamp=$(git rev-parse "HEAD:js" "HEAD:css" | git hash-object --stdin | cut -c1-10)
sed -i -E "s#(src=\"js/[A-Za-z0-9_-]+\.js)(\?v=[^\"]*)?\"#\1?v=$stamp\"#g" index.html
sed -i -E "s#(href=\"css/[A-Za-z0-9_-]+\.css)(\?v=[^\"]*)?\"#\1?v=$stamp\"#g" index.html

# Folded into the commit being deployed, so history stays one commit per
# change. Only ever reached when the stamp actually moved, which means js/ or
# css/ changed, which means this commit is new and not yet on the remote.
amended=0
if ! git diff --quiet -- index.html; then
  git add index.html
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
