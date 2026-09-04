"""SQLite schema and access helpers.

One writer (the ingest/build CLI) and many readers (the web app), so WAL mode
plus a short busy timeout is all the concurrency control this needs.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS objects (
    id              TEXT PRIMARY KEY,
    museum          TEXT NOT NULL,
    source_id       TEXT NOT NULL,
    title           TEXT NOT NULL,
    artist          TEXT,
    artist_note     TEXT,
    date_display    TEXT NOT NULL,
    year_start      INTEGER NOT NULL,
    year_end        INTEGER NOT NULL,
    year_mid        INTEGER NOT NULL,
    date_precision  TEXT NOT NULL,
    medium          TEXT,
    classification  TEXT,
    culture         TEXT,
    department      TEXT,
    region          TEXT,
    credit_line     TEXT,
    object_url      TEXT NOT NULL,
    image_url       TEXT NOT NULL,
    image_key       TEXT NOT NULL UNIQUE,
    image_w         INTEGER,
    image_h         INTEGER,
    local_image     INTEGER NOT NULL DEFAULT 0,
    license_id      TEXT NOT NULL,
    license_label   TEXT NOT NULL,
    license_url     TEXT NOT NULL,
    rights_basis    TEXT NOT NULL,
    looks_modern    INTEGER NOT NULL DEFAULT 0,
    playable        INTEGER NOT NULL DEFAULT 1,
    exclude_reason  TEXT,
    ingested_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_objects_museum ON objects(museum, playable);
CREATE INDEX IF NOT EXISTS idx_objects_year   ON objects(year_mid);

CREATE TABLE IF NOT EXISTS pairs (
    id              TEXT PRIMARY KEY,
    left_id         TEXT NOT NULL REFERENCES objects(id),
    right_id        TEXT NOT NULL REFERENCES objects(id),
    earlier         TEXT NOT NULL CHECK (earlier IN ('left', 'right')),
    guaranteed_gap  INTEGER NOT NULL,
    display_gap     INTEGER NOT NULL,
    approximate     INTEGER NOT NULL,
    difficulty      INTEGER NOT NULL,
    surprise        INTEGER NOT NULL,
    insight         TEXT NOT NULL,
    museums         TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pairs_difficulty ON pairs(difficulty);
CREATE INDEX IF NOT EXISTS idx_pairs_museums    ON pairs(museums);

CREATE TABLE IF NOT EXISTS daily_sets (
    date        TEXT NOT NULL,
    edition     TEXT NOT NULL DEFAULT '',
    position    INTEGER NOT NULL,
    pair_id     TEXT NOT NULL REFERENCES pairs(id),
    flipped     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, edition, position)
);

CREATE TABLE IF NOT EXISTS daily_results (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL,
    edition     TEXT NOT NULL DEFAULT '',
    session     TEXT NOT NULL,
    score       INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE (date, edition, session)
);

-- Aggregate right/wrong counts so a question can honestly say how many
-- players got it. Nothing here identifies a player.
CREATE TABLE IF NOT EXISTS pair_stats (
    pair_id     TEXT PRIMARY KEY REFERENCES pairs(id),
    shown       INTEGER NOT NULL DEFAULT 0,
    correct     INTEGER NOT NULL DEFAULT 0
);

-- One row the first time a session answers a given pair. It keeps the
-- "how many players got this" figure honest and stops a reloaded page from
-- counting twice. No IP address, no cookie, no identity -- just a random id
-- the browser made up for itself.
CREATE TABLE IF NOT EXISTS answer_log (
    session     TEXT NOT NULL,
    pair_id     TEXT NOT NULL,
    correct     INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (session, pair_id)
);

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    session     TEXT NOT NULL,
    props       TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_name ON events(name, created_at);

CREATE TABLE IF NOT EXISTS meta (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL
);
"""

_local = threading.local()


def connect(path: Path | None = None) -> sqlite3.Connection:
    """Per-thread connection; the web server is threaded."""
    target = str(path or config.DB_PATH)
    conn = getattr(_local, "conn", None)
    if conn is not None and getattr(_local, "path", None) == target:
        return conn
    Path(target).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(target, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    _local.conn = conn
    _local.path = target
    return conn


def reset_connection() -> None:
    conn = getattr(_local, "conn", None)
    if conn is not None:
        conn.close()
    _local.conn = None
    _local.path = None


def init(path: Path | None = None) -> sqlite3.Connection:
    conn = connect(path)
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


@contextmanager
def write(path: Path | None = None):
    conn = connect(path)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def set_meta(key: str, value) -> None:
    with write() as conn:
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value)),
        )


def get_meta(key: str, default=None):
    row = connect().execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def table_exists(name: str) -> bool:
    row = connect().execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


def counts() -> dict:
    conn = connect()

    def one(sql: str) -> int:
        return conn.execute(sql).fetchone()[0]

    return {
        "objects": one("SELECT COUNT(*) FROM objects"),
        "playable": one("SELECT COUNT(*) FROM objects WHERE playable = 1"),
        "pairs": one("SELECT COUNT(*) FROM pairs"),
        "daily_days": one("SELECT COUNT(DISTINCT date) FROM daily_sets"),
        "results": one("SELECT COUNT(*) FROM daily_results"),
        "events": one("SELECT COUNT(*) FROM events"),
    }
