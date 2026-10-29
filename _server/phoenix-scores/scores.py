#!/usr/bin/env python3
"""Public leaderboard for Phoenix on hallie.xyz (games/phx), served at
https://scores.hallie.xyz from the droplet (hallie.xyz itself is GitHub Pages,
which can't run this). Lives in _server/ so Jekyll leaves it off the site.

Stdlib only: http.server + sqlite3. Two boards:
  champions  finished games, ranked by Phoenix's own score
  furthest   every run, ranked by level reached, then cash

  GET    /api/scores        top entries of both boards
  POST   /api/scores        {name, level, cash, difficulty, score?}
  DELETE /api/scores/<id>   header X-Admin-Token

Environment:
  PHX_DB           sqlite path            (default ./scores.db)
  PHX_HOST         listen address         (default 127.0.0.1, behind nginx)
  PHX_PORT         listen port            (default 8811)
  PHX_ORIGINS      allowed CORS origins, comma-separated
  PHX_ADMIN_TOKEN  enables DELETE when set
"""

import json
import os
import re
import sqlite3
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB_PATH = os.environ.get("PHX_DB", "scores.db")
HOST = os.environ.get("PHX_HOST", "127.0.0.1")
PORT = int(os.environ.get("PHX_PORT", "8811"))
ORIGINS = {o.strip() for o in os.environ.get(
    "PHX_ORIGINS", "https://hallie.xyz,https://www.hallie.xyz").split(",") if o.strip()}
ADMIN_TOKEN = os.environ.get("PHX_ADMIN_TOKEN", "")

TOP = 25
NAME_RE = re.compile(r"^[A-Z0-9 ]{1,10}$")  # Phoenix's own name field is 10 chars
# Matched against the name with spaces and digit look-alikes folded away.
BLOCKED = ("FUCK", "FUK", "SHIT", "CUNT", "DICK", "COCK", "PUSSY", "BITCH",
           "ASSHOLE", "SLUT", "WHORE", "FAG", "NIGG", "NIGA", "RAPIST", "PORN",
           "PENIS", "VAGINA", "BOOB", "NAZI", "KKK", "SEX")
# Kept off the list because real names contain them: HELL (MICHELLE),
# RAPE (GRAPE). Anything that slips through: DELETE with the admin token.
LOOKALIKE = str.maketrans("013457", "OIEAST")

RATE_WINDOW, RATE_MAX = 600, 20  # 20 submissions per IP per 10 minutes
_hits = defaultdict(deque)
_lock = threading.Lock()


def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    with db() as con:
        con.execute("""CREATE TABLE IF NOT EXISTS runs (
            id         INTEGER PRIMARY KEY,
            board      TEXT NOT NULL CHECK (board IN ('champions', 'furthest')),
            name       TEXT NOT NULL,
            score      INTEGER,
            level      INTEGER NOT NULL,
            cash       INTEGER NOT NULL,
            difficulty INTEGER NOT NULL,
            created    TEXT NOT NULL)""")


def clean_name(raw):
    name = re.sub(r"\s+", " ", str(raw or "")).strip().upper()
    if not NAME_RE.match(name):
        return None
    folded = name.replace(" ", "").translate(LOOKALIKE)
    if any(word in folded for word in BLOCKED):
        return None
    return name


def int_in(value, lo, hi):
    if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
        raise ValueError
    return value


def rate_ok(ip):
    now = time.monotonic()
    with _lock:
        q = _hits[ip]
        while q and now - q[0] > RATE_WINDOW:
            q.popleft()
        if len(q) >= RATE_MAX:
            return False
        q.append(now)
        return True


def board(con, name):
    order = "score DESC, created" if name == "champions" else "level DESC, cash DESC, created"
    rows = con.execute(
        f"SELECT id, name, score, level, cash, difficulty, created FROM runs "
        f"WHERE board = ? ORDER BY {order} LIMIT ?", (name, TOP)).fetchall()
    return [dict(r) for r in rows]


def rank(con, name, row_id):
    ids = [r["id"] for r in board(con, name)]
    return ids.index(row_id) + 1 if row_id in ids else None


class Handler(BaseHTTPRequestHandler):
    server_version = "phoenix-scores"

    def route(self):
        return self.path.split("?", 1)[0].rstrip("/")

    def client_ip(self):
        # nginx passes the real address; only trust it from localhost.
        if self.client_address[0] in ("127.0.0.1", "::1"):
            return self.headers.get("X-Real-IP") or self.client_address[0]
        return self.client_address[0]

    def cors(self):
        origin = self.headers.get("Origin")
        if origin and origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self):
        if self.route() != "/api/scores":
            return self.reply(404, {"error": "not found"})
        with db() as con:
            self.reply(200, {"champions": board(con, "champions"),
                             "furthest": board(con, "furthest")})

    def do_POST(self):
        if self.route() != "/api/scores":
            return self.reply(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 1024:
                raise ValueError
            body = json.loads(self.rfile.read(length))
            name = clean_name(body.get("name"))
            if not name:
                return self.reply(400, {"error": "name"})
            level = int_in(body.get("level"), 1, 99)
            cash = int_in(body.get("cash"), 0, 65535)
            difficulty = int_in(body.get("difficulty"), 0, 2)
            score = body.get("score")
            score = None if score is None else int_in(score, 0, 65535)
        except (ValueError, TypeError, json.JSONDecodeError):
            return self.reply(400, {"error": "bad request"})
        if not rate_ok(self.client_ip()):
            return self.reply(429, {"error": "slow down"})

        created = datetime.now(timezone.utc).isoformat(timespec="seconds")
        ranks = {}
        with db() as con:
            boards = ["furthest"] + (["champions"] if score is not None else [])
            for b in boards:
                cur = con.execute(
                    "INSERT INTO runs (board, name, score, level, cash, difficulty, created) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (b, name, score if b == "champions" else None, level, cash, difficulty, created))
                ranks[b] = rank(con, b, cur.lastrowid)
        self.reply(201, {"ok": True, "name": name, "ranks": ranks})

    def do_DELETE(self):
        m = re.fullmatch(r"/api/scores/(\d+)", self.route())
        if not m:
            return self.reply(404, {"error": "not found"})
        if not ADMIN_TOKEN or self.headers.get("X-Admin-Token") != ADMIN_TOKEN:
            return self.reply(403, {"error": "forbidden"})
        with db() as con:
            gone = con.execute("DELETE FROM runs WHERE id = ?", (int(m[1]),)).rowcount
        self.reply(200, {"deleted": gone})

    def log_message(self, fmt, *args):
        pass  # no per-request logging (keeps IPs out of the journal)


if __name__ == "__main__":
    init_db()
    print(f"phoenix-scores on {HOST}:{PORT}, db {DB_PATH}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
