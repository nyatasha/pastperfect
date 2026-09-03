"""Wellcome Collection — Catalogue API.

https://developers.wellcomecollection.org/api/catalogue — no key required.
Unlike the Met and the Art Institute, Wellcome states a licence per digital
location, and a lot of the catalogue is in copyright, so the licence is read off
the actual IIIF image location rather than assumed.
"""

from __future__ import annotations

from collections.abc import Iterator

from .. import config
from .base import BlockedError, RawObject, clean, fetch_json

MUSEUM = "wellcome"
API = "https://api.wellcomecollection.org/catalogue/v2"
INCLUDE = "production,items,contributors,subjects,genres"
#: Pictures and 3-D objects. The rest of the catalogue is books and archives,
#: which do not make a visual game.
WORK_TYPES = "k,r"
PAGE_SIZE = 100
MAX_PAGE = 12


def harvest(windows: list[tuple[int, int]], per_window: int, seed: int = 7) -> Iterator[RawObject]:
    for begin, end in windows:
        if end < 1:
            continue  # the catalogue does not describe BCE material
        collected = 0
        for page in range(1, MAX_PAGE + 1):
            if collected >= per_window:
                break
            query = (
                f"include={INCLUDE}"
                "&items.locations.license=cc0,pdm"
                "&items.locations.locationType=iiif-image"
                f"&workType={WORK_TYPES}"
                f"&production.dates.from={max(begin, 1):04d}-01-01"
                f"&production.dates.to={end:04d}-12-31"
                f"&pageSize={PAGE_SIZE}&page={page}"
            )
            try:
                payload = fetch_json(f"{API}/works?{query}", museum=MUSEUM)
            except BlockedError:
                raise
            except Exception:
                break
            rows = (payload or {}).get("results") or []
            if not rows:
                break
            for row in rows:
                if collected >= per_window:
                    break
                record = _to_record(row)
                if record is None:
                    continue
                collected += 1
                yield record


def _image_location(row: dict) -> dict | None:
    for item in row.get("items") or []:
        for location in item.get("locations") or []:
            if (location.get("locationType") or {}).get("id") == "iiif-image":
                return location
    return None


def _to_record(row: dict) -> RawObject | None:
    location = _image_location(row)
    title = clean(row.get("title"))
    if not location or not title:
        return None
    url = clean(location.get("url")) or ""
    if not url.endswith("/info.json"):
        return None
    image_base = url[: -len("/info.json")]

    date_display = ""
    place = None
    for production in row.get("production") or []:
        for date in production.get("dates") or []:
            if clean(date.get("label")):
                date_display = clean(date.get("label")) or ""
                break
        for p in production.get("places") or []:
            place = place or clean(p.get("label"))
        if date_display:
            break
    if not date_display:
        return None

    contributors = [
        clean((c.get("agent") or {}).get("label")) for c in row.get("contributors") or []
    ]
    contributors = [c for c in contributors if c]
    genres = [clean(g.get("label")) for g in row.get("genres") or []]
    genres = [g for g in genres if g]
    subjects = [clean(s.get("label")) for s in row.get("subjects") or []]
    subjects = [s for s in subjects if s]

    licence = (location.get("license") or {}).get("id")
    return RawObject(
        museum=MUSEUM,
        source_id=str(row.get("id")),
        title=title,
        object_url=f"https://wellcomecollection.org/works/{row.get('id')}",
        image_url=f"{image_base}/full/{config.IMAGE_LARGE_PX},/0/default.jpg",
        licence_raw=licence,
        rights_basis=f"licence '{licence}' stated on the IIIF image location in the Wellcome catalogue",
        date_display=date_display,
        year_start=None,
        year_end=None,
        artist=contributors[0] if contributors else None,
        artist_note=", ".join(contributors[1:3]) or None,
        medium=", ".join(genres[:2]) or clean(row.get("physicalDescription")),
        classification=(row.get("workType") or {}).get("label"),
        culture=place,
        department=None,
        credit_line=clean(location.get("credit")) or "Wellcome Collection",
        extra={"subjects": subjects[:4], "genres": genres[:4]},
    )
