"""Art Institute of Chicago — public API.

https://api.artic.edu/docs/ — no key required, but the docs ask callers to
identify themselves with an ``AIC-User-Agent`` header. Rights come from the
API's ``is_public_domain`` flag; images are served over IIIF.
"""

from __future__ import annotations

from collections.abc import Iterator

from .. import config
from .base import BlockedError, RawObject, clean, fetch_json

MUSEUM = "aic"
API = "https://api.artic.edu/api/v1"
IIIF = "https://www.artic.edu/iiif/2"
#: The size the Art Institute documents and keeps warm. Asking for anything
#: larger makes the server derive a fresh image and the request simply hangs.
IIIF_WIDTH = 843
HEADERS = {"AIC-User-Agent": config.USER_AGENT}

FIELDS = ",".join([
    "id", "title", "artist_display", "artist_title", "date_display", "date_start",
    "date_end", "image_id", "is_public_domain", "credit_line", "medium_display",
    "classification_title", "place_of_origin", "department_title", "artwork_type_title",
])
#: The search endpoint refuses deep pagination, so each window is sampled shallowly
#: and variety comes from having many windows rather than many pages.
MAX_PAGE = 15
PAGE_SIZE = 100


def harvest(windows: list[tuple[int, int]], per_window: int, seed: int = 7) -> Iterator[RawObject]:
    for begin, end in windows:
        collected = 0
        for page in range(1, MAX_PAGE + 1):
            if collected >= per_window:
                break
            query = (
                "query[bool][must][0][term][is_public_domain]=true"
                f"&query[bool][must][1][range][date_start][gte]={begin}"
                f"&query[bool][must][2][range][date_end][lte]={end}"
                "&query[bool][must][3][exists][field]=image_id"
                f"&fields={FIELDS}&limit={PAGE_SIZE}&page={page}"
            )
            try:
                payload = fetch_json(f"{API}/artworks/search?{query}", museum=MUSEUM, headers=HEADERS)
            except BlockedError:
                raise
            except Exception:
                break
            rows = (payload or {}).get("data") or []
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


def _to_record(row: dict) -> RawObject | None:
    image_id = clean(row.get("image_id"))
    title = clean(row.get("title"))
    if not image_id or not title:
        return None
    artist = clean(row.get("artist_title"))
    artist_display = clean(row.get("artist_display"))
    note = None
    if artist_display and artist and artist_display.startswith(artist):
        note = clean(artist_display[len(artist):].lstrip(" ,"))
    elif artist_display and not artist:
        artist = artist_display.split("\n")[0]
    return RawObject(
        museum=MUSEUM,
        source_id=str(row.get("id")),
        title=title,
        object_url=f"https://www.artic.edu/artworks/{row.get('id')}",
        image_url=f"{IIIF}/{image_id}/full/{IIIF_WIDTH},/0/default.jpg",
        licence_raw="cc0" if row.get("is_public_domain") else None,
        rights_basis="is_public_domain flag on the Art Institute of Chicago API record",
        date_display=clean(row.get("date_display")) or "",
        year_start=row.get("date_start"),
        year_end=row.get("date_end"),
        artist=artist,
        artist_note=note,
        medium=clean(row.get("medium_display")),
        classification=clean(row.get("classification_title")) or clean(row.get("artwork_type_title")),
        culture=clean(row.get("place_of_origin")),
        department=clean(row.get("department_title")),
        credit_line=clean(row.get("credit_line")),
        extra={"image_id": image_id},
    )
