"""Read and write queries shared by the pages and the JSON API."""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import random

from . import config, daily, db

#: Everything the reveal is allowed to say about an object.
REVEAL_FIELDS = (
    "id, museum, title, artist, artist_note, date_display, year_start, year_end, "
    "year_mid, date_precision, medium, classification, culture, credit_line, "
    "object_url, image_key, image_w, image_h, license_label, license_url, license_id"
)


def _now() -> str:
    return _dt.datetime.now(_dt.UTC).isoformat(timespec="seconds")


def in_play_clause() -> str:
    """An object is in play only when its rights, its date and its image all pass."""
    return "playable = 1 AND local_image = 1"


# --- collection ----------------------------------------------------------


def overall_stats() -> dict:
    conn = db.connect()
    row = conn.execute(
        f"SELECT COUNT(*) AS objects, MIN(year_start) AS earliest, MAX(year_end) AS latest "
        f"FROM objects WHERE {in_play_clause()}"
    ).fetchone()
    pairs = conn.execute("SELECT COUNT(*) AS n FROM pairs").fetchone()["n"]
    return {
        "objects": row["objects"] or 0,
        "earliest": row["earliest"],
        "latest": row["latest"],
        "pairs": pairs,
        "museums": len(config.MUSEUM_ORDER),
    }


def museum_stats(slug: str) -> dict:
    conn = db.connect()
    row = conn.execute(
        f"SELECT COUNT(*) AS objects, MIN(year_start) AS earliest, MAX(year_end) AS latest "
        f"FROM objects WHERE museum = ? AND {in_play_clause()}",
        (slug,),
    ).fetchone()
    licences = [
        dict(r)
        for r in conn.execute(
            f"SELECT license_label AS label, license_url AS url, COUNT(*) AS n FROM objects "
            f"WHERE museum = ? AND {in_play_clause()} GROUP BY license_label, license_url "
            "ORDER BY n DESC",
            (slug,),
        )
    ]
    forms = [
        dict(r)
        for r in conn.execute(
            f"SELECT COALESCE(NULLIF(classification, ''), 'Other') AS label, COUNT(*) AS n "
            f"FROM objects WHERE museum = ? AND {in_play_clause()} "
            "GROUP BY label ORDER BY n DESC LIMIT 6",
            (slug,),
        )
    ]
    pairs = conn.execute(
        "SELECT COUNT(*) AS n FROM pairs WHERE museums = ?", (slug,)
    ).fetchone()["n"]
    return {
        **dict(row),
        "licences": licences,
        "forms": forms,
        "own_pairs": pairs,
        "excluded": (db.get_meta("ingest_report", {}) or {}).get(slug, {}).get("excluded", {}),
    }


def _spoiler_object_ids() -> set[str]:
    """Objects appearing in a daily set near today, which must not be shown off-game."""
    today = daily.today()
    window = _dt.timedelta(days=config.FEATURE_SPOILER_WINDOW_DAYS)
    conn = db.connect()
    rows = conn.execute(
        "SELECT p.left_id, p.right_id FROM daily_sets d JOIN pairs p ON p.id = d.pair_id "
        "WHERE d.date BETWEEN ? AND ?",
        ((today - window).isoformat(), (today + window).isoformat()),
    )
    out: set[str] = set()
    for row in rows:
        out.add(row["left_id"])
        out.add(row["right_id"])
    return out


def featured_objects(museum: str | None = None, limit: int = 8) -> list[dict]:
    """A stable daily selection to illustrate a page.

    Anything scheduled in a nearby daily set is held back: a museum page that
    quietly shows you today's answer would be a bad museum page.
    """
    conn = db.connect()
    sql = f"SELECT {REVEAL_FIELDS} FROM objects WHERE {in_play_clause()}"
    params: tuple = ()
    if museum:
        sql += " AND museum = ?"
        params = (museum,)
    rows = [dict(r) for r in conn.execute(sql + " ORDER BY id", params)]
    blocked = _spoiler_object_ids()
    rows = [r for r in rows if r["id"] not in blocked] or rows
    seed = f"{daily.today().isoformat()}:{museum or 'all'}"
    rng = random.Random(int.from_bytes(hashlib.sha256(seed.encode()).digest()[:8], "big"))
    rng.shuffle(rows)
    if not museum:
        # Spread the strip across the launch mix rather than whichever museum
        # happens to sort first.
        picked: list[dict] = []
        by_museum: dict[str, list[dict]] = {}
        for row in rows:
            by_museum.setdefault(row["museum"], []).append(row)
        while len(picked) < limit and any(by_museum.values()):
            for slug in config.MUSEUM_ORDER:
                bucket = by_museum.get(slug) or []
                if bucket and len(picked) < limit:
                    picked.append(bucket.pop())
        return picked
    return rows[:limit]


def objects_by_ids(ids: list[str]) -> dict[str, dict]:
    if not ids:
        return {}
    marks = ",".join("?" for _ in ids)
    conn = db.connect()
    return {
        row["id"]: dict(row)
        for row in conn.execute(
            f"SELECT {REVEAL_FIELDS} FROM objects WHERE id IN ({marks})", ids
        )
    }


def pair(pair_id: str) -> dict | None:
    row = db.connect().execute("SELECT * FROM pairs WHERE id = ?", (pair_id,)).fetchone()
    return dict(row) if row else None


# --- endless -------------------------------------------------------------


def endless_page(seed: str, museum: str | None, page: int, size: int) -> list[dict]:
    """A deterministic, never-repeating walk through the pair pool.

    The client holds only a seed and a page number, so there is no server-side
    session to keep and no growing list of "already seen" ids to send up.
    """
    conn = db.connect()
    if museum:
        rows = conn.execute(
            "SELECT p.id, p.difficulty FROM pairs p "
            "JOIN objects l ON l.id = p.left_id JOIN objects r ON r.id = p.right_id "
            "WHERE l.museum = ? AND r.museum = ? ORDER BY p.id",
            (museum, museum),
        )
    else:
        rows = conn.execute("SELECT id, difficulty FROM pairs ORDER BY id")
    pool = [dict(r) for r in rows]
    if not pool:
        return []
    rng = random.Random(int.from_bytes(hashlib.sha256(seed.encode()).digest()[:8], "big"))
    # Endless opens gently and stays mixed, so order by difficulty band first and
    # shuffle inside each band.
    banded: dict[int, list[dict]] = {}
    for item in pool:
        banded.setdefault(item["difficulty"], []).append(item)
    for bucket in banded.values():
        rng.shuffle(bucket)
    ordered: list[dict] = []
    cursor = {level: 0 for level in banded}
    rotation = [1, 2, 3, 2, 4, 3, 5, 4, 2, 5, 3, 4]
    while any(cursor[level] < len(banded[level]) for level in banded):
        for level in rotation:
            bucket = banded.get(level) or []
            index = cursor.get(level, 0)
            if index < len(bucket):
                ordered.append(bucket[index])
                cursor[level] = index + 1
    start = page * size
    return ordered[start : start + size]


# --- play records --------------------------------------------------------


def record_answer(session: str, pair_id: str, correct: bool) -> None:
    """Count a session's first answer to a pair, and only its first."""
    if not session:
        return
    with db.write() as conn:
        changed = conn.execute(
            "INSERT OR IGNORE INTO answer_log (session, pair_id, correct, created_at) "
            "VALUES (?,?,?,?)",
            (session, pair_id, int(correct), _now()),
        ).rowcount
        if changed:
            conn.execute(
                "INSERT INTO pair_stats (pair_id, shown, correct) VALUES (?, 1, ?) "
                "ON CONFLICT(pair_id) DO UPDATE SET shown = shown + 1, "
                "correct = correct + excluded.correct",
                (pair_id, int(correct)),
            )


def pair_success(pair_id: str) -> int | None:
    """Share of players who answered this pair correctly, once it means anything."""
    row = db.connect().execute(
        "SELECT shown, correct FROM pair_stats WHERE pair_id = ?", (pair_id,)
    ).fetchone()
    if not row or row["shown"] < config.PERCENTILE_MIN_SAMPLE:
        return None
    return round(100 * row["correct"] / row["shown"])


def record_daily(session: str, date: str, edition: str, score: int) -> dict:
    if session:
        with db.write() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO daily_results (date, edition, session, score, created_at) "
                "VALUES (?,?,?,?,?)",
                (date, edition, session, score, _now()),
            )
    return daily_standing(date, edition, score)


def daily_standing(date: str, edition: str, score: int) -> dict:
    conn = db.connect()
    rows = conn.execute(
        "SELECT score FROM daily_results WHERE date = ? AND edition = ?", (date, edition)
    ).fetchall()
    scores = [r["score"] for r in rows]
    players = len(scores)
    distribution = [scores.count(n) for n in range(config.DAILY_QUESTIONS + 1)]
    percentile = None
    if players >= config.PERCENTILE_MIN_SAMPLE:
        at_or_below = sum(1 for s in scores if s <= score)
        percentile = round(100 * at_or_below / players)
    return {"players": players, "percentile": percentile, "distribution": distribution}


def log_event(name: str, session: str, props: dict | None) -> None:
    """First-party, cookieless analytics.

    The PRD asks for analytics, not for surveillance: this stores an event name,
    the browser's own random session id and a small bag of properties. No IP
    address is written, and nothing here can be joined back to a person.
    """
    if not name or len(name) > 64:
        return
    payload = json.dumps(props or {}, separators=(",", ":"))[:1000]
    with db.write() as conn:
        conn.execute(
            "INSERT INTO events (name, session, props, created_at) VALUES (?,?,?,?)",
            (name[:64], (session or "anon")[:64], payload, _now()),
        )


def event_summary(days: int = 7) -> list[dict]:
    since = (_dt.datetime.now(_dt.UTC) - _dt.timedelta(days=days)).isoformat(timespec="seconds")
    return [
        dict(row)
        for row in db.connect().execute(
            "SELECT name, COUNT(*) AS n, COUNT(DISTINCT session) AS sessions FROM events "
            "WHERE created_at >= ? GROUP BY name ORDER BY n DESC",
            (since,),
        )
    ]
