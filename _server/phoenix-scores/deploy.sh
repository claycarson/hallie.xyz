#!/bin/sh
# Install or update the Phoenix leaderboard API on the droplet (ssh alias: ocean).
# Safe to re-run. Gets the TLS certificate only once scores.hallie.xyz points
# at the droplet; until then it stops after the HTTP setup.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
DROPLET_IP=157.245.91.181

scp -q "$HERE/scores.py" "$HERE/phoenix-scores.service" "$HERE/nginx.conf" ocean:/tmp/

ssh ocean DROPLET_IP="$DROPLET_IP" sh -s <<'REMOTE'
set -eu
mkdir -p /opt/phoenix-scores
install -m 644 /tmp/scores.py /opt/phoenix-scores/scores.py

# Admin token for deleting entries, made once, readable by root only.
if [ ! -f /etc/phoenix-scores.env ]; then
  ( umask 077; echo "PHX_ADMIN_TOKEN=$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')" > /etc/phoenix-scores.env )
fi

install -m 644 /tmp/phoenix-scores.service /etc/systemd/system/phoenix-scores.service
systemctl daemon-reload
systemctl enable phoenix-scores >/dev/null 2>&1
systemctl restart phoenix-scores

# certbot rewrites this file to add TLS; don't clobber that on re-runs.
if [ ! -f /etc/nginx/sites-available/scores.hallie.xyz ]; then
  install -m 644 /tmp/nginx.conf /etc/nginx/sites-available/scores.hallie.xyz
fi
ln -sf /etc/nginx/sites-available/scores.hallie.xyz /etc/nginx/sites-enabled/scores.hallie.xyz
nginx -t >/dev/null 2>&1 || { nginx -t; exit 1; }
systemctl reload nginx
rm -f /tmp/scores.py /tmp/phoenix-scores.service /tmp/nginx.conf

sleep 1
echo "service: $(systemctl is-active phoenix-scores)"
echo "api:     $(curl -s -H 'Host: scores.hallie.xyz' http://127.0.0.1/api/scores)"

RESOLVED=$(getent ahostsv4 scores.hallie.xyz | awk 'NR==1 {print $1}')
if [ "$RESOLVED" != "$DROPLET_IP" ]; then
  echo "DNS:     scores.hallie.xyz -> ${RESOLVED:-nothing}, not $DROPLET_IP. Fix the Porkbun A record, then re-run for TLS."
  exit 0
fi
if ! grep -q 'listen 443' /etc/nginx/sites-available/scores.hallie.xyz; then
  certbot --nginx -d scores.hallie.xyz --non-interactive --agree-tos --redirect \
    --register-unsafely-without-email >/dev/null 2>&1 \
    || certbot --nginx -d scores.hallie.xyz --non-interactive --redirect
fi
echo "https:   $(curl -s https://scores.hallie.xyz/api/scores)"
REMOTE
