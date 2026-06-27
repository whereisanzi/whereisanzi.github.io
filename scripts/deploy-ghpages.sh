#!/usr/bin/env bash
#
# Deploy the built site to GitHub Pages via the gh-pages branch.
#
# This exists because GitHub Actions is currently blocked on the account
# (billing). The native Pages builder (deploy-from-branch) still works, so we
# build locally and publish dist/ to the gh-pages branch, then ask Pages to
# rebuild. When Actions is unblocked, switch Pages back to "GitHub Actions"
# and this script is no longer needed.
#
# Usage: bash scripts/deploy-ghpages.sh
set -euo pipefail

REPO="whereisanzi/whereisanzi.github.io"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Building site"
npm run build

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Staging dist/ into a fresh gh-pages tree"
cp -r dist/. "$WORK/"
touch "$WORK/.nojekyll"

cd "$WORK"
git init -q
git checkout -q -b gh-pages
git -c user.name="whereisanzi" -c user.email="anderson.anzileiro@gmail.com" add -A
git -c user.name="whereisanzi" -c user.email="anderson.anzileiro@gmail.com" \
  commit -q -m "Deploy $(cd "$ROOT" && git rev-parse --short HEAD)"
git push -f "https://github.com/${REPO}.git" gh-pages

echo "==> Triggering Pages rebuild"
gh api -X POST "repos/${REPO}/pages/builds" >/dev/null

echo "==> Done. Site: https://whereisanzi.github.io"
