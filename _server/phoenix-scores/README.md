# phoenix-scores

Public leaderboard API for `games/phx`, at `https://scores.hallie.xyz/api/scores`.
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

1. Porkbun: `A  scores  →  <droplet IP>` on hallie.xyz.
2. `sudo mkdir -p /opt/phoenix-scores && sudo cp scores.py /opt/phoenix-scores/`
3. Optional admin token: `echo PHX_ADMIN_TOKEN=… | sudo tee /etc/phoenix-scores.env`
   (`sudo chmod 600` it).
4. `sudo cp phoenix-scores.service /etc/systemd/system/ && sudo systemctl enable --now phoenix-scores`
5. `sudo cp nginx.conf /etc/nginx/sites-available/scores.hallie.xyz`, symlink into
   `sites-enabled`, `sudo nginx -t && sudo systemctl reload nginx`
6. `sudo certbot --nginx -d scores.hallie.xyz`

## Moderate

    curl -s https://scores.hallie.xyz/api/scores            # find the id
    curl -X DELETE -H "X-Admin-Token: …" https://scores.hallie.xyz/api/scores/<id>
