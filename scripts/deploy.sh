#!/usr/bin/env bash
# Build and publish dist/ to the gh-pages branch (until Actions CI is enabled).
set -euo pipefail
cd "$(dirname "$0")/.."

yarn build
cd dist
git init -q -b gh-pages
git add -A
git commit -q -m "deploy $(git -C .. rev-parse --short HEAD)"
git push -f https://github.com/HakonHaralds/meetpoint.git gh-pages
rm -rf .git
echo "Deployed."
