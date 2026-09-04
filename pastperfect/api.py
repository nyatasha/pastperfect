"""The JSON API the game client talks to.

Two rules shape this module.

First, a question payload contains no title, no maker, no date and no museum --
only two opaque image URLs. Everything that would give the answer away arrives
after the player commits, from POST /api/answer.

Second, the answer itself is computed here from stored date intervals. There is
no model in this path, and there is no network call in this path.
"""

from __future__ import annotations

import re

from . import config, daily, dates, http, store, views

QID = re.compile(r"^([0-9a-f]{16})\.([01])$")
SESSION = re.compile(r"^[A-Za-z0-9_-]{6,64}$")
MAX_ENDLESS_PAGE = 400
ENDLESS_PAGE_SIZE = 8


def _session(value) -> str:
    value = str(value or "")
    return value if SESSION.match(value) else ""


def _side(row: dict) -> dict:
    """What a player may see *before* answering."""
    return {
        "img": f"/img/{row['image_key']}.jpg",
        "w": row["image_w"],
        "h": row["image_h"],
    }


def _revealed(row: dict) -> dict:
    """What a player may see *after* answering."""
    museum = config.MUSEUMS.get(row["museum"], {})
    approximate = row["date_precision"] != "year"
    return {
        "title": row["title"],
        "artist": row["artist"],
        "artistNote": row["artist_note"],
        "date": views.display_date(row),
        "year": row["year_mid"],
        "yearText": views.headline_date(row),
        "approximate": approximate,
        "century": dates.century_label(row["year_mid"]),
        "medium": row["medium"],
        "museum": row["museum"],
        "museumName": museum.get("short_name", row["museum"]),
        "museumPath": f"/museum/{row['museum']}",
        "credit": row["credit_line"],
        "objectUrl": row["object_url"],
        "licence": row["license_label"],
        "licenceUrl": row["license_url"],
    }


def _questions(rows: list[dict]) -> list[dict]:
    """Turn stored pairs into spoiler-free questions."""
    ids: list[str] = []
    for row in rows:
        ids.extend([row["left_id"], row["right_id"]])
    objects = store.objects_by_ids(ids)
    out: list[dict] = []
    for index, row in enumerate(rows):
        left, right = objects.get(row["left_id"]), objects.get(row["right_id"])
        if not left or not right:
            continue
        flipped = bool(row.get("flipped", 0))
        first, second = (right, left) if flipped else (left, right)
        out.append({
            "id": f"{row['id']}.{int(flipped)}",
            "n": index + 1,
            "a": _side(first),
            "b": _side(second),
        })
    return out


# --- endpoints ------------------------------------------------------------


def round_handler(request: http.Request) -> http.Response:
    mode = request.get("mode", "daily")
    if mode == "endless":
        return _endless_round(request)
    return _daily_round(request)


def _daily_round(request: http.Request) -> http.Response:
    edition = request.get("edition", daily.MIXED)
    if edition and edition not in config.MUSEUMS:
        return http.json_response({"error": "unknown edition"}, "404 Not Found")
    day = daily.parse_date(request.get("date", "")) or daily.today()
    if not daily.playable_day(day):
        return http.json_response(
            {"error": "closed", "message": "That puzzle has closed.", "today": daily.today().isoformat()},
            "410 Gone",
        )
    rows = daily.questions(day, edition)
    if not rows:
        return http.json_response({"error": "not ready"}, "503 Service Unavailable")
    return http.json_response({
        "mode": "daily",
        "edition": edition,
        "date": day.isoformat(),
        "puzzle": daily.puzzle_number(day),
        "total": len(rows),
        "questions": _questions(rows),
    })


def _endless_round(request: http.Request) -> http.Response:
    museum = request.get("museum", "") or None
    if museum and museum not in config.MUSEUMS:
        return http.json_response({"error": "unknown museum"}, "404 Not Found")
    seed = _session(request.get("seed", "")) or "anonymous-seed"
    page = request.int_param("page", 0, 0, MAX_ENDLESS_PAGE)
    picks = store.endless_page(seed, museum, page, ENDLESS_PAGE_SIZE)
    if not picks:
        return http.json_response({"mode": "endless", "questions": [], "exhausted": True})
    rows = []
    for offset, pick in enumerate(picks):
        row = store.pair(pick["id"])
        if row:
            row["flipped"] = (page * ENDLESS_PAGE_SIZE + offset + hash(seed)) % 2
            rows.append(row)
    return http.json_response({
        "mode": "endless",
        "museum": museum or "",
        "page": page,
        "questions": _questions(rows),
        "adAfterRounds": config.ENDLESS_AD_AFTER_ROUNDS,
    })


def answer_handler(request: http.Request) -> http.Response:
    payload = request.json()
    match = QID.match(str(payload.get("q", "")))
    choice = payload.get("choice")
    if not match or choice not in ("a", "b"):
        return http.json_response({"error": "bad request"}, "400 Bad Request")

    pair_id, flipped = match.group(1), bool(int(match.group(2)))
    row = store.pair(pair_id)
    if not row:
        return http.json_response({"error": "unknown question"}, "404 Not Found")

    objects = store.objects_by_ids([row["left_id"], row["right_id"]])
    left, right = objects.get(row["left_id"]), objects.get(row["right_id"])
    if not left or not right:
        return http.json_response({"error": "unknown question"}, "404 Not Found")

    # The answer is a comparison of two stored intervals that provably do not
    # overlap. Nothing else feeds into it.
    first, second = (right, left) if flipped else (left, right)
    earlier_row = left if row["earlier"] == "left" else right
    earlier_side = "a" if earlier_row is first else "b"
    correct = choice == earlier_side

    session = _session(payload.get("session"))
    store.record_answer(session, pair_id, correct)

    return http.json_response({
        "correct": correct,
        "earlier": earlier_side,
        "gap": row["display_gap"],
        "gapText": dates.describe_gap(row["display_gap"], bool(row["approximate"])),
        "approximate": bool(row["approximate"]),
        "insight": row["insight"],
        "surprise": bool(row["surprise"]),
        "difficulty": row["difficulty"],
        "successRate": store.pair_success(pair_id),
        "a": _revealed(first),
        "b": _revealed(second),
    })


def complete_handler(request: http.Request) -> http.Response:
    payload = request.json()
    day = daily.parse_date(str(payload.get("date", "")))
    edition = str(payload.get("edition", "") or "")
    if day is None or (edition and edition not in config.MUSEUMS):
        return http.json_response({"error": "bad request"}, "400 Bad Request")
    try:
        score = int(payload.get("score"))
    except (TypeError, ValueError):
        return http.json_response({"error": "bad request"}, "400 Bad Request")
    if not 0 <= score <= config.DAILY_QUESTIONS:
        return http.json_response({"error": "bad request"}, "400 Bad Request")

    standing = store.record_daily(_session(payload.get("session")), day.isoformat(), edition, score)
    return http.json_response({
        "date": day.isoformat(),
        "puzzle": daily.puzzle_number(day),
        "score": score,
        "minSample": config.PERCENTILE_MIN_SAMPLE,
        **standing,
    })


def events_handler(request: http.Request) -> http.Response:
    payload = request.json()
    props = payload.get("props")
    store.log_event(
        str(payload.get("name", "")),
        _session(payload.get("session")),
        props if isinstance(props, dict) else None,
    )
    return http.Response(b"", "204 No Content", "text/plain")


def health_handler(request: http.Request) -> http.Response:
    from . import db

    stats = store.overall_stats()
    return http.json_response({
        "ok": stats["objects"] > 0 and stats["pairs"] > 0,
        "objects": stats["objects"],
        "pairs": stats["pairs"],
        "dailyDays": len(daily.available_days()),
        "today": daily.today().isoformat(),
        "puzzle": daily.puzzle_number(daily.today()),
        "lastIngest": db.get_meta("last_ingest"),
        "adsEnabled": config.ADS_ENABLED,
    })
