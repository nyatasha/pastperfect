"""Building the Daily Challenge.

Everybody gets the same ten questions on the same day, so the set has to be a
stored artefact rather than something regenerated per request. It is derived
from a seed made of the date, which keeps regeneration reproducible, and then
written to the database, which keeps it stable even if the pair pool changes
underneath it.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import os
import random

from . import config, db

MIXED = ""  # the edition key for the all-museums daily


def today() -> _dt.date:
    """The canonical puzzle day.

    UTC, deliberately: the puzzle number in a shared result has to mean the same
    thing to the person who receives it as to the person who sent it.
    """
    return _dt.datetime.now(_dt.UTC).date()


def puzzle_number(day: _dt.date) -> int:
    return (day - config.EPOCH_DATE).days + 1


def parse_date(text: str) -> _dt.date | None:
    try:
        return _dt.date.fromisoformat(text)
    except (ValueError, TypeError):
        return None


def archive_open() -> bool:
    """Past puzzles stay closed in v0; the archive is a paid feature later."""
    return os.environ.get("PASTPERFECT_ALLOW_ARCHIVE") == "1"


def playable_day(day: _dt.date) -> bool:
    return day == today() or (archive_open() and day <= today())


def _seed(day: _dt.date, edition: str) -> random.Random:
    digest = hashlib.sha256(f"past-perfect-daily-v1:{edition}:{day.isoformat()}".encode()).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


def _pool(edition: str) -> list[dict]:
    conn = db.connect()
    sql = (
        "SELECT p.id, p.difficulty, p.left_id, p.right_id, "
        "       l.museum AS left_museum, r.museum AS right_museum "
        "FROM pairs p "
        "JOIN objects l ON l.id = p.left_id "
        "JOIN objects r ON r.id = p.right_id"
    )
    params: tuple = ()
    if edition != MIXED:
        sql += " WHERE l.museum = ? AND r.museum = ?"
        params = (edition, edition)
    return [dict(row) for row in conn.execute(sql, params)]


def _recent_objects(day: _dt.date, edition: str) -> set[str]:
    """Objects used in this edition within the cooldown window."""
    since = (day - _dt.timedelta(days=config.DAILY_COOLDOWN_DAYS)).isoformat()
    conn = db.connect()
    rows = conn.execute(
        "SELECT p.left_id, p.right_id FROM daily_sets d JOIN pairs p ON p.id = d.pair_id "
        "WHERE d.edition = ? AND d.date >= ? AND d.date < ?",
        (edition, since, day.isoformat()),
    )
    used: set[str] = set()
    for row in rows:
        used.add(row["left_id"])
        used.add(row["right_id"])
    return used


def build_day(day: _dt.date, edition: str = MIXED, pool: list[dict] | None = None) -> list[tuple]:
    """Pick the day's questions. Returns rows ready for insertion."""
    pool = pool if pool is not None else _pool(edition)
    if len(pool) < config.DAILY_QUESTIONS:
        return []

    rng = _seed(day, edition)
    cooling = _recent_objects(day, edition)
    by_difficulty: dict[int, list[dict]] = {}
    for pair in pool:
        by_difficulty.setdefault(pair["difficulty"], []).append(pair)
    for bucket in by_difficulty.values():
        rng.shuffle(bucket)

    used_objects: set[str] = set()
    seen_museums: set[str] = set()
    rows: list[tuple] = []

    for position, target in enumerate(config.DAILY_DIFFICULTY_CURVE[: config.DAILY_QUESTIONS]):
        chosen = None
        # Walk outwards from the intended difficulty rather than failing: a thin
        # pool should soften the curve, not leave a hole in the puzzle.
        for level in _nearby(target):
            candidates = [
                pair for pair in by_difficulty.get(level, [])
                if pair["left_id"] not in used_objects
                and pair["right_id"] not in used_objects
            ]
            fresh = [
                pair for pair in candidates
                if pair["left_id"] not in cooling and pair["right_id"] not in cooling
            ]
            candidates = fresh or candidates
            if not candidates:
                continue
            if edition == MIXED and len(seen_museums) < len(config.MUSEUM_ORDER):
                widening = [
                    pair for pair in candidates
                    if {pair["left_museum"], pair["right_museum"]} - seen_museums
                ]
                candidates = widening or candidates
            chosen = rng.choice(candidates)
            break
        if chosen is None:
            break
        used_objects.update({chosen["left_id"], chosen["right_id"]})
        seen_museums.update({chosen["left_museum"], chosen["right_museum"]})
        rows.append((day.isoformat(), edition, position, chosen["id"], int(rng.random() < 0.5)))

    return rows


def _nearby(target: int) -> list[int]:
    order = [target]
    for step in (1, 2, 3, 4):
        for level in (target - step, target + step):
            if 1 <= level <= 5 and level not in order:
                order.append(level)
    return order


def ensure(days: int = 45, start: _dt.date | None = None, editions: list[str] | None = None,
           log=print) -> int:
    """Precompute daily sets for a window of days, for every edition."""
    db.init()
    first = start or (today() - _dt.timedelta(days=2))
    editions = editions if editions is not None else [MIXED, *config.MUSEUM_ORDER]
    written = 0
    for edition in editions:
        pool = _pool(edition)
        if len(pool) < config.DAILY_QUESTIONS:
            log(f"  {edition or 'mixed':14} skipped — only {len(pool)} pairs available")
            continue
        made = 0
        for offset in range(days):
            day = first + _dt.timedelta(days=offset)
            existing = db.connect().execute(
                "SELECT COUNT(*) FROM daily_sets WHERE date = ? AND edition = ?",
                (day.isoformat(), edition),
            ).fetchone()[0]
            if existing >= config.DAILY_QUESTIONS:
                continue
            rows = build_day(day, edition, pool)
            if not rows:
                continue
            with db.write() as conn:
                conn.execute(
                    "DELETE FROM daily_sets WHERE date = ? AND edition = ?",
                    (day.isoformat(), edition),
                )
                conn.executemany(
                    "INSERT INTO daily_sets (date, edition, position, pair_id, flipped) "
                    "VALUES (?,?,?,?,?)",
                    rows,
                )
            made += 1
            written += len(rows)
        log(f"  {edition or 'mixed':14} {made} days generated")
    return written


def questions(day: _dt.date, edition: str = MIXED) -> list[dict]:
    """The stored questions for a day, joined to everything the reveal needs."""
    conn = db.connect()
    rows = conn.execute(
        "SELECT d.position, d.flipped, p.*, p.id AS pair_id FROM daily_sets d "
        "JOIN pairs p ON p.id = d.pair_id "
        "WHERE d.date = ? AND d.edition = ? ORDER BY d.position",
        (day.isoformat(), edition),
    )
    return [dict(row) for row in rows]


def available_days(edition: str = MIXED) -> list[str]:
    conn = db.connect()
    return [
        row["date"]
        for row in conn.execute(
            "SELECT DISTINCT date FROM daily_sets WHERE edition = ? ORDER BY date",
            (edition,),
        )
    ]
