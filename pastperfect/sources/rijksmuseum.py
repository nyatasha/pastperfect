"""Rijksmuseum — Linked Art data service.

https://data.rijksmuseum.nl/docs/search — no key required. The collection is
published as Linked Art, so a single object takes three hops: the object record
names a VisualItem, which carries the rights statement and names a DigitalObject,
which finally carries the IIIF image URL. Responses are cached on disk, so the
cost is paid once per object.
"""

from __future__ import annotations

from collections.abc import Iterator

from .base import BlockedError, RawObject, clean, fetch_json

MUSEUM = "rijksmuseum"
SEARCH = "https://data.rijksmuseum.nl/search/collection"

AAT_EN = "http://vocab.getty.edu/aat/300388277"
AAT_TITLE = "http://vocab.getty.edu/aat/300404670"
AAT_CREDIT = "http://vocab.getty.edu/aat/300026687"
AAT_DESCRIPTION = "http://vocab.getty.edu/aat/300435416"
AAT_WEBPAGE = "http://vocab.getty.edu/aat/300264578"

#: A spread of object types, so the game is not all prints. Rijksmuseum search
#: accepts English or Dutch terms for these.
TYPES = [
    "painting", "drawing", "photograph", "sculpture", "furniture", "print",
    "glass", "textile", "jewellery", "silver", "ceramic", "costume",
]


def _centuries(windows: list[tuple[int, int]]) -> list[str]:
    """Rijksmuseum search filters dates by wildcard, so windows become centuries."""
    out: list[str] = []
    for begin, end in windows:
        for year in range(max(begin, 1000), min(end, 2100), 100):
            token = f"{year // 100:02d}??"
            if token not in out:
                out.append(token)
    return out


def harvest(windows: list[tuple[int, int]], per_window: int, seed: int = 7) -> Iterator[RawObject]:
    """Round-robin across century x object-type, stopping at the overall target.

    Each object costs three requests, so the walk is breadth-first: one pass
    takes a couple of objects from every combination before any combination gets
    a second look. That keeps a small quota spread across the whole collection.
    """
    total = max(1, per_window * len(windows))
    combos = [(century, kind) for century in _centuries(windows) for kind in TYPES]
    if not combos:
        return
    listings: dict[tuple[str, str], list[str]] = {}
    yielded = 0
    per_pass = 2
    offset = 0
    while yielded < total and offset < 40:
        progressed = False
        for combo in combos:
            if yielded >= total:
                return
            if combo not in listings:
                century, kind = combo
                url = f"{SEARCH}?type={kind}&imageAvailable=True&creationDate={century}"
                try:
                    payload = fetch_json(url, museum=MUSEUM)
                except BlockedError:
                    raise
                except Exception:
                    listings[combo] = []
                    continue
                listings[combo] = [
                    item.get("id") for item in (payload or {}).get("orderedItems") or []
                    if item.get("id")
                ]
            ids = listings[combo][offset : offset + per_pass]
            for object_id in ids:
                progressed = True
                record = _load_object(object_id)
                if record is None:
                    continue
                yielded += 1
                yield record
                if yielded >= total:
                    return
        if not progressed:
            return
        offset += per_pass


# --- Linked Art helpers ---------------------------------------------------


def _notation(node: dict, prefer_en: bool = True) -> str | None:
    values = node.get("notation")
    if values is None:
        return clean(node.get("_label"))
    if isinstance(values, dict):
        values = [values]
    english = [v for v in values if isinstance(v, dict) and v.get("@language") == "en"]
    pool = english if (prefer_en and english) else values
    for value in pool:
        if isinstance(value, dict) and clean(value.get("@value")):
            return clean(value.get("@value"))
        if isinstance(value, str) and clean(value):
            return clean(value)
    return None


def _is_english(node: dict) -> bool:
    return any(lang.get("id") == AAT_EN for lang in node.get("language") or [])


def _classified(node: dict, aat: str) -> bool:
    return any(c.get("id") == aat for c in node.get("classified_as") or [])


def _title(obj: dict) -> str | None:
    names = [n for n in obj.get("identified_by") or [] if n.get("type") == "Name"]
    for wanted_english in (True, False):
        for name in names:
            if not _classified(name, AAT_TITLE):
                continue
            if wanted_english and not _is_english(name):
                continue
            if clean(name.get("content")):
                return clean(name.get("content"))
    for name in names:
        if clean(name.get("content")):
            return clean(name.get("content"))
    return None


def _referred(obj: dict, aat: str) -> str | None:
    notes = [n for n in obj.get("referred_to_by") or [] if _classified(n, aat)]
    for wanted_english in (True, False):
        for note in notes:
            if wanted_english and not _is_english(note):
                continue
            if clean(note.get("content")):
                return clean(note.get("content"))
    return None


def _year(iso: str | None) -> int | None:
    if not iso:
        return None
    text = str(iso)
    negative = text.startswith("-")
    digits = text.lstrip("-").split("-")[0]
    if not digits.isdigit():
        return None
    return -int(digits) if negative else int(digits)


def _creator(obj: dict) -> str | None:
    produced = obj.get("produced_by") or {}
    for production in [produced, *(produced.get("part") or [])]:
        for actor in production.get("carried_out_by") or []:
            name = _notation(actor)
            if name:
                return name
    return _referred(produced, AAT_DESCRIPTION)


def _page_url(obj: dict) -> str | None:
    for note in obj.get("subject_of") or []:
        for carrier in note.get("digitally_carried_by") or []:
            if carrier.get("format") != "text/html":
                continue
            for point in carrier.get("access_point") or []:
                url = clean(point.get("id"))
                if url:
                    return url
    return None


def _load_object(object_id: str | None) -> RawObject | None:
    if not object_id:
        return None
    try:
        obj = fetch_json(object_id, museum=MUSEUM)
    except BlockedError:
        raise
    except Exception:
        return None
    if not obj:
        return None

    title = _title(obj)
    if not title:
        return None

    visual_ids = [v.get("id") for v in obj.get("shows") or [] if v.get("id")]
    if not visual_ids:
        return None
    try:
        visual = fetch_json(visual_ids[0], museum=MUSEUM)
    except BlockedError:
        raise
    except Exception:
        return None
    if not visual:
        return None

    licence_raw = None
    for right in visual.get("subject_to") or []:
        for kind in right.get("classified_as") or []:
            if "creativecommons.org" in str(kind.get("id", "")):
                licence_raw = kind.get("id")
                break
    digital_ids = [d.get("id") for d in visual.get("digitally_shown_by") or [] if d.get("id")]
    if not digital_ids:
        return None
    try:
        digital = fetch_json(digital_ids[0], museum=MUSEUM)
    except BlockedError:
        raise
    except Exception:
        return None
    image_url = None
    for point in (digital or {}).get("access_point") or []:
        if clean(point.get("id")):
            image_url = clean(point.get("id"))
            break
    if not image_url:
        return None
    # The IIIF endpoint serves any width; ask for something a browser can use.
    image_url = image_url.replace("/full/max/", "/full/1100,/")

    produced = obj.get("produced_by") or {}
    timespan = produced.get("timespan") or {}
    date_display = ""
    for name in timespan.get("identified_by") or []:
        if clean(name.get("content")):
            date_display = clean(name.get("content")) or ""
            break

    object_type = None
    for kind in obj.get("classified_as") or []:
        object_type = _notation(kind) or object_type
    materials = [m for m in (_notation(x) for x in obj.get("made_of") or []) if m]
    place = None
    for production in [produced, *(produced.get("part") or [])]:
        for spot in production.get("took_place_at") or []:
            place = place or _notation(spot, prefer_en=False)

    source_id = str(object_id).rstrip("/").rsplit("/", 1)[-1]
    return RawObject(
        museum=MUSEUM,
        source_id=source_id,
        title=title,
        object_url=_page_url(obj) or f"https://id.rijksmuseum.nl/{source_id}",
        image_url=image_url,
        licence_raw=licence_raw,
        rights_basis="rights statement on the object's VisualItem in the Rijksmuseum Linked Art data",
        date_display=date_display,
        year_start=_year(timespan.get("begin_of_the_begin")),
        year_end=_year(timespan.get("end_of_the_end")),
        artist=_creator(obj),
        artist_note=None,
        medium=", ".join(materials[:3]) or None,
        classification=object_type,
        culture=place,
        department=None,
        credit_line=_referred(obj, AAT_CREDIT) or "Rijksmuseum, Amsterdam",
        extra={},
    )
