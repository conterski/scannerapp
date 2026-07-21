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

sha=$(git rev-parse HEAD)

if [ -n "$(git status --porcelain)" ]; then
  echo "WARNING: uncommitted changes present — deploying HEAD ($sha) without them" >&2
fi

git push

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
