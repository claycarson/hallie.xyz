#!/bin/sh
# Copy this folder to the HTTPS dev copy on the droplet (PLAN §2.5): https://dev.hallie.xyz
# Only the game's own files go; never live main. Run from anywhere.
set -eu
cd "$(dirname "$0")/.."
rsync -az --delete \
  --exclude node_modules --exclude tests --exclude tools --exclude package.json --exclude package-lock.json \
  --exclude '.*' --exclude '*.md' --exclude '*.glb' --exclude '*.usdz' --exclude '*.zip' \
  ./ ocean:/var/www/dev.hallie.xyz/
printf 'User-agent: *\nDisallow: /\n' | ssh ocean 'cat > /var/www/dev.hallie.xyz/robots.txt'
curl -sI https://dev.hallie.xyz/ | grep -iE '^HTTP|x-robots-tag'
