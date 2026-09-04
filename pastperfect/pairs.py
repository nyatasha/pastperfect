"""Precomputing the question pool.

A pair is only a question if its answer is provable. That means the two date
intervals must not overlap: whatever the true date of each object is inside its
range, one is unambiguously earlier. Overlapping ranges are not "close calls",
they are unanswerable, and the game never asks them.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import random
import re

from . import config, db, insights

#: Buckets on the *provable* gap. Sampling a few partners from each bucket for
#: every object is what gives the pool a full difficulty range instead of a heap
#: of easy thousand-year questions.
GAP_BUCKETS = [(1, 15), (15, 40), (40, 100), (100, 200), (200, 500), (500, 10_000)]
PER_BUCKET = 4

OBJECT_FIELDS = (
    "id, museum, title, artist, year_start, year_end, year_mid, date_precision, "
    "medium, classification, region, looks_modern"
)


def pair_id(left: str, right: str) -> str:
    return hashlib.sha1(f"{left}|{right}".encode("utf-8")).hexdigest()[:16]


def _normalise_title(title: str) -> str:
    text = re.sub(r"[^a-z0-9 ]+", " ", (title or "").lower())
    text = re.sub(r"\b(plate|pl|no|number|fig|figure|vol|volume|part|pt)\b\.?\s*\d+", " ", text)
    return " ".join(text.split())


def _too_similar(a: dict, b: dict) -> bool:
    """Reject near-duplicates -- two plates from one series make a poor question."""
    if a.get("artist") and a.get("artist") == b.get("artist"):
        ta, tb = _normalise_title(a["title"]), _normalise_title(b["title"])
        if ta and tb and (ta == tb or ta.startswith(tb) or tb.startswith(ta)):
            return True
    return False


def difficulty_for(earlier: dict, later: dict, gap: int) -> tuple[int, bool]:
    """Score 1 (gentle) to 5 (cruel), plus whether the pair is visually deceptive."""
    if gap >= 300:
        score = 1
    elif gap >= 150:
        score = 2
    elif gap >= 60:
        score = 3
    elif gap >= 20:
        score = 4
    else:
        score = 5

    surprise = bool(earlier["looks_modern"]) and not bool(later["looks_modern"])
    if surprise:
        # The visual cue points the wrong way, which is the whole trick.
        score += 1
    elif bool(later["looks_modern"]) and not bool(earlier["looks_modern"]):
        # The cue points the right way, so the question gets easier.
        score -= 1

    regions = {earlier["region"], later["region"]}
    if "Unknown" not in regions and len(regions) == 2:
        # Most players hold one mental timeline. Crossing regions breaks it.
        score += 1

    return max(1, min(5, score)), surprise


def _candidates(rows: list[dict], index: int, rng: random.Random) -> list[dict]:
    """Partners for rows[index], spread across the gap buckets."""
    subject = rows[index]
    chosen: list[dict] = []
    for low, high in GAP_BUCKETS:
        bucket = [
            other for other in rows
            if other["id"] != subject["id"]
            and low <= _guaranteed_gap(subject, other) < high
        ]
        if not bucket:
            continue
        rng.shuffle(bucket)
        chosen.extend(bucket[:PER_BUCKET])
    return chosen


def _guaranteed_gap(a: dict, b: dict) -> int:
    """Smallest possible number of years between them, or 0 if ranges overlap."""
    if a["year_end"] < b["year_start"]:
        return b["year_start"] - a["year_end"]
    if b["year_end"] < a["year_start"]:
        return a["year_start"] - b["year_end"]
    return 0


def build(seed: int = 11, log=print) -> int:
    conn = db.init()
    rows = [
        dict(r)
        for r in conn.execute(
            f"SELECT {OBJECT_FIELDS} FROM objects "
            "WHERE playable = 1 AND local_image = 1 ORDER BY year_mid, id"
        )
    ]
    log(f"  {len(rows)} playable objects with images")
    if len(rows) < 2:
        return 0

    rng = random.Random(seed)
    now = _dt.datetime.now(_dt.UTC).isoformat(timespec="seconds")
    seen: set[str] = set()
    records: list[tuple] = []

    for index, subject in enumerate(rows):
        for other in _candidates(rows, index, rng):
            if _too_similar(subject, other):
                continue
            left, right = sorted((subject, other), key=lambda r: r["id"])
            key = pair_id(left["id"], right["id"])
            if key in seen:
                continue
            gap = _guaranteed_gap(left, right)
            if gap < config.MIN_PAIR_GAP_YEARS:
                continue
            earlier_side = "left" if left["year_end"] < right["year_start"] else "right"
            earlier = left if earlier_side == "left" else right
            later = right if earlier_side == "left" else left

            approximate = (
                earlier["date_precision"] != "year" or later["date_precision"] != "year"
            )
            display_gap = abs(later["year_mid"] - earlier["year_mid"])
            score, surprise = difficulty_for(earlier, later, gap)
            seen.add(key)
            records.append((
                key, left["id"], right["id"], earlier_side, gap, display_gap,
                int(approximate), score, int(surprise),
                insights.for_pair(earlier, later, display_gap, approximate),
                "|".join(sorted({left["museum"], right["museum"]})),
                now,
            ))

    with db.write() as conn:
        conn.execute("DELETE FROM daily_sets")
        conn.execute("DELETE FROM pair_stats")
        conn.execute("DELETE FROM pairs")
        conn.executemany(
            "INSERT INTO pairs (id, left_id, right_id, earlier, guaranteed_gap, "
            "display_gap, approximate, difficulty, surprise, insight, museums, "
            "created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            records,
        )
    db.set_meta("last_pair_build", now)
    log(f"  {len(records)} pairs built")
    return len(records)


def distribution() -> list[dict]:
    conn = db.connect()
    return [
        dict(r)
        for r in conn.execute(
            "SELECT difficulty, COUNT(*) AS n, SUM(surprise) AS surprising, "
            "MIN(guaranteed_gap) AS min_gap, MAX(guaranteed_gap) AS max_gap "
            "FROM pairs GROUP BY difficulty ORDER BY difficulty"
        )
    ]
