"""The Metropolitan Museum of Art — Collection API.

https://metmuseum.github.io/ — no key required. Rights come from the API's own
``isPublicDomain`` flag, which the Met sets on the objects it has released under
Creative Commons Zero.
"""

from __future__ import annotations

import random
from collections.abc import Iterator

from .base import BlockedError, RawObject, clean, fetch_json

MUSEUM = "met"
API = "https://collectionapi.metmuseum.org/public/collection/v1"


#: How many candidate ids to try per window before giving up. Without a cap a
#: source that starts refusing requests would be walked to the end of a 15,000
#: item result list one 403 at a time.
CANDIDATE_FACTOR = 5


def _search(begin: int, end: int) -> list[int]:
    url = (
        f"{API}/search?hasImages=true&isPublicDomain=true"
        f"&dateBegin={begin}&dateEnd={end}&q=*"
    )
    payload = fetch_json(url, museum=MUSEUM) or {}
    return payload.get("objectIDs") or []


def harvest(windows: list[tuple[int, int]], per_window: int, seed: int = 7) -> Iterator[RawObject]:
    rng = random.Random(seed)
    for begin, end in windows:
        ids = _search(begin, end)
        if not ids:
            continue
        rng.shuffle(ids)
        wanted = 0
        for object_id in ids[: per_window * CANDIDATE_FACTOR]:
            if wanted >= per_window:
                break
            try:
                data = fetch_json(f"{API}/objects/{object_id}", museum=MUSEUM)
            except BlockedError:
                raise
            except Exception:
                continue
            if not data:
                continue
            record = _to_record(data)
            if record is None:
                continue
            wanted += 1
            yield record


def _to_record(data: dict) -> RawObject | None:
    image = clean(data.get("primaryImageSmall")) or clean(data.get("primaryImage"))
    title = clean(data.get("title"))
    if not image or not title:
        return None
    return RawObject(
        museum=MUSEUM,
        source_id=str(data.get("objectID")),
        title=title,
        object_url=clean(data.get("objectURL")) or "",
        image_url=image,
        licence_raw="cc0" if data.get("isPublicDomain") else None,
        rights_basis="isPublicDomain flag on the Met Collection API object record",
        date_display=clean(data.get("objectDate")) or "",
        year_start=data.get("objectBeginDate"),
        year_end=data.get("objectEndDate"),
        artist=clean(data.get("artistDisplayName")),
        artist_note=clean(data.get("artistDisplayBio")),
        medium=clean(data.get("medium")),
        classification=clean(data.get("classification")),
        culture=clean(data.get("culture")) or clean(data.get("country")),
        department=clean(data.get("department")),
        credit_line=clean(data.get("creditLine")),
        extra={"gallery": clean(data.get("GalleryNumber"))},
    )
