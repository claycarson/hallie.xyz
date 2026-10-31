# phoenix-scores

Public leaderboard API for `games/phoenix`, at `https://scores.hallie.xyz/api/scores`.
hallie.xyz is GitHub Pages (static only), so this runs on the droplet. The `_`
folder name keeps it off the Pages site (Jekyll skips `_` folders).

- `scores.py`: stdlib Python + SQLite. Boards: `champions` (finished games, by
  Phoenix's score) and `furthest` (every run, by level then cash). Names are
  A–Z/0–9/space, 10 chars max, with a word filter; 20 posts per IP per 10 minutes.
- `phoenix-scores.service`: systemd unit. Code at `/opt/phoenix-scores/scores.py`,
  data at `/var/lib/phoenix-scores/scores.db`.
- `nginx.conf`: `scores.hallie.xyz` → 127.0.0.1:8811, `/api/` only.

## Run locally

    PHX_DB=/tmp/scores.db PHX_HOST=0.0.0.0 \
    PHX_ORIGINS=http://127.0.0.1:8765,http://192.168.0.100:8765 \
    python3 -I scores.py

The page uses `http://<page host>:8811/api/scores` anywhere but hallie.xyz.

## Deploy (droplet)

1. Porkbun: `A  scores  →  157.245.91.181` on hallie.xyz.
2. Run `./deploy.sh`. It copies the files, installs the systemd unit and the
   nginx site, makes `/etc/phoenix-scores.env` with an admin token once, and
   runs certbot when the DNS points at the droplet. Safe to re-run (it keeps
   certbot's nginx edits). Code: `/opt/phoenix-scores/`, data:
   `/var/lib/phoenix-scores/scores.db`.

Admin token: `ssh ocean cat /etc/phoenix-scores.env`.

## Moderate

    curl -s https://scores.hallie.xyz/api/scores            # find the id
    curl -X DELETE -H "X-Admin-Token: …" https://scores.hallie.xyz/api/scores/<id>
