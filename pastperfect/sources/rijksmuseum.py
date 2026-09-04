"""Rijksmuseum — Linked Art data service.

https://data.rijksmuseum.nl/docs/search — no key required. The collection is
published as Linked Art, so a single object takes three hops: the object record
names a VisualItem, which carries the rights statement and names a DigitalObject,
which finally carries the IIIF image URL. Responses are cached on disk, so the
cost is paid once per object.
"""

from __future__ import annotations

import re
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
                    item.get("id") for item in _dicts(payload or {}, "orderedItems")
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


def _as_list(value) -> list:
    """Linked Art serialises a single value as an object, not a one-item array.

    Every traversal below goes through this, so a record with one title behaves
    exactly like a record with three.
    """
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def _dicts(node, key: str) -> list[dict]:
    if not isinstance(node, dict):
        return []
    return [item for item in _as_list(node.get(key)) if isinstance(item, dict)]


def _notation(node, prefer_en: bool = True) -> str | None:
    if not isinstance(node, dict):
        return clean(node) if isinstance(node, str) else None
    values = _as_list(node.get("notation"))
    if not values:
        return clean(node.get("_label"))
    english = [v for v in values if isinstance(v, dict) and v.get("@language") == "en"]
    pool = english if (prefer_en and english) else values
    for value in pool:
        if isinstance(value, dict) and clean(value.get("@value")):
            return clean(value.get("@value"))
        if isinstance(value, str) and clean(value):
            return clean(value)
    return None


def _is_english(node: dict) -> bool:
    return any(lang.get("id") == AAT_EN for lang in _dicts(node, "language"))


def _classified(node: dict, aat: str) -> bool:
    return any(c.get("id") == aat for c in _dicts(node, "classified_as"))


def _title(obj: dict) -> str | None:
    names = [n for n in _dicts(obj, "identified_by") if n.get("type") == "Name"]
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


def _referred(obj, aat: str) -> str | None:
    notes = [n for n in _dicts(obj, "referred_to_by") if _classified(n, aat)]
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


def _productions(obj: dict) -> list[dict]:
    produced = obj.get("produced_by")
    produced = produced if isinstance(produced, dict) else {}
    return [produced, *_dicts(produced, "part")] if produced else []


#: Names that mean "we do not know", which the interface should leave blank
#: rather than print as though somebody were called this.
_UNNAMED = {"anonymous", "anoniem", "onbekend", "unknown", "unidentified"}


def _creator(obj: dict) -> str | None:
    for production in _productions(obj):
        for actor in _dicts(production, "carried_out_by"):
            name = _notation(actor)
            if name:
                return name
    produced = obj.get("produced_by")
    return _referred(produced, AAT_DESCRIPTION) if isinstance(produced, dict) else None


def _page_url(obj: dict) -> str | None:
    for note in _dicts(obj, "subject_of"):
        for carrier in _dicts(note, "digitally_carried_by"):
            if carrier.get("format") != "text/html":
                continue
            for point in _dicts(carrier, "access_point"):
                url = clean(point.get("id"))
                if url:
                    return url
    return None


def _artist_name(obj: dict) -> str | None:
    name = clean(re.sub(
        r"\s*\((?:mentioned on object|possibly|attributed to)[^)]*\)", "", _creator(obj) or ""
    ))
    if not name or name.lower() in _UNNAMED:
        return None
    return name


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

    visual_ids = [v.get("id") for v in _dicts(obj, "shows") if v.get("id")]
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
    for right in _dicts(visual, "subject_to"):
        for kind in _dicts(right, "classified_as"):
            if "creativecommons.org" in str(kind.get("id", "")):
                licence_raw = kind.get("id")
                break
    digital_ids = [d.get("id") for d in _dicts(visual, "digitally_shown_by") if d.get("id")]
    if not digital_ids:
        return None
    try:
        digital = fetch_json(digital_ids[0], museum=MUSEUM)
    except BlockedError:
        raise
    except Exception:
        return None
    image_url = None
    for point in _dicts(digital or {}, "access_point"):
        if clean(point.get("id")):
            image_url = clean(point.get("id"))
            break
    if not image_url:
        return None
    # The IIIF endpoint serves any width; ask for something a browser can use.
    image_url = image_url.replace("/full/max/", "/full/1100,/")

    produced = obj.get("produced_by")
    produced = produced if isinstance(produced, dict) else {}
    timespan = produced.get("timespan")
    timespan = timespan if isinstance(timespan, dict) else {}
    date_display = ""
    for name in _dicts(timespan, "identified_by"):
        if clean(name.get("content")):
            date_display = clean(name.get("content")) or ""
            break

    object_type = None
    for kind in _dicts(obj, "classified_as"):
        object_type = _notation(kind) or object_type
    materials = [m for m in (_notation(x) for x in _dicts(obj, "made_of")) if m]
    place = None
    for production in _productions(obj):
        for spot in _dicts(production, "took_place_at"):
            place = place or _notation(spot, prefer_en=False)

    source_id = str(object_id).rstrip("/").rsplit("/", 1)[-1]
    page = _page_url(obj) or f"https://id.rijksmuseum.nl/{source_id}"
    page = page.replace("rijksmuseum.nl/nl/", "rijksmuseum.nl/en/")
    return RawObject(
        museum=MUSEUM,
        source_id=source_id,
        title=title,
        object_url=page,
        image_url=image_url,
        licence_raw=licence_raw,
        rights_basis="rights statement on the object's VisualItem in the Rijksmuseum Linked Art data",
        date_display=date_display,
        year_start=_year(timespan.get("begin_of_the_begin")),
        year_end=_year(timespan.get("end_of_the_end")),
        artist=_artist_name(obj),
        artist_note=None,
        medium=", ".join(materials[:3]) or None,
        classification=object_type,
        culture=place,
        department=None,
        credit_line=_referred(obj, AAT_CREDIT) or "Rijksmuseum, Amsterdam",
        extra={},
    )
