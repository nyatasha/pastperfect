"""Shared plumbing for the museum adapters: one record shape, one HTTP client."""

from __future__ import annotations

import hashlib
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field, asdict
from pathlib import Path

from .. import config


@dataclass
class RawObject:
    """One museum object, flattened but not yet judged.

    Adapters fill this in verbatim from the source. Date reconciliation, the
    rights gate and the taxonomy heuristics all happen afterwards in ingest.py,
    so each adapter stays a thin translation layer.
    """

    museum: str
    source_id: str
    title: str
    object_url: str
    image_url: str
    licence_raw: str | None
    rights_basis: str
    date_display: str = ""
    year_start: int | None = None
    year_end: int | None = None
    artist: str | None = None
    artist_note: str | None = None
    medium: str | None = None
    classification: str | None = None
    culture: str | None = None
    department: str | None = None
    credit_line: str | None = None
    extra: dict = field(default_factory=dict)

    @property
    def id(self) -> str:
        return f"{self.museum}:{self.source_id}"

    def as_dict(self) -> dict:
        return asdict(self)


class HttpError(Exception):
    pass


class BlockedError(HttpError):
    """The source is refusing us outright -- rate limit, WAF, or ban.

    Worth its own type: the right response is to stop asking this museum for a
    while, not to retry the next object and collect another few hundred 403s.
    """


_host_locks: dict[str, threading.Lock] = {}
_host_last: dict[str, float] = {}
_locks_guard = threading.Lock()
#: Minimum spacing between requests to the same host. These are free public APIs
#: run by museums; hammering them is rude and gets us blocked -- the Met sits
#: behind a WAF that starts returning 403 well before its documented rate limit.
DEFAULT_INTERVAL = 0.2
HOST_INTERVALS = {
    "collectionapi.metmuseum.org": 1.6,
    "images.metmuseum.org": 0.35,
    "api.artic.edu": 0.25,
    "www.artic.edu": 0.6,
    "api.wellcomecollection.org": 0.25,
    "iiif.wellcomecollection.org": 0.3,
    "data.rijksmuseum.nl": 0.15,
    "id.rijksmuseum.nl": 0.15,
    "iiif.micr.io": 0.15,
}


def _throttle(host: str) -> None:
    with _locks_guard:
        lock = _host_locks.setdefault(host, threading.Lock())
    with lock:
        last = _host_last.get(host, 0.0)
        wait = HOST_INTERVALS.get(host, DEFAULT_INTERVAL) - (time.monotonic() - last)
        if wait > 0:
            time.sleep(wait)
        _host_last[host] = time.monotonic()


#: Headers a particular host needs beyond the defaults. The Art Institute's
#: image host rejects requests that omit the AIC-User-Agent header its API docs
#: ask callers to send -- so we send it, and identify ourselves honestly.
HOST_HEADERS = {
    "www.artic.edu": {"AIC-User-Agent": config.USER_AGENT},
}


def _cache_path(museum: str, url: str) -> Path:
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()
    return config.CACHE_DIR / museum / digest[:2] / f"{digest}.json"


def fetch_json(
    url: str, *, museum: str, use_cache: bool = True, headers: dict | None = None
) -> dict | None:
    """GET JSON with an on-disk cache, polite throttling and retries.

    Returns None for 404/410 so an adapter can skip a withdrawn record. Raises
    HttpError when the request genuinely failed.
    """
    path = _cache_path(museum, url)
    if use_cache and path.exists():
        try:
            return json.loads(path.read_text("utf-8"))
        except (json.JSONDecodeError, OSError):
            path.unlink(missing_ok=True)

    host = urllib.parse.urlparse(url).netloc
    last_error: Exception | None = None
    for attempt in range(config.HTTP_RETRIES):
        _throttle(host)
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": config.USER_AGENT,
                "Accept": "application/json",
                **HOST_HEADERS.get(host, {}),
                **(headers or {}),
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=config.HTTP_TIMEOUT) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(payload), "utf-8")
            return payload
        except urllib.error.HTTPError as exc:
            if exc.code in (404, 410):
                return None
            if exc.code in (401, 403):
                raise BlockedError(f"{host} refused the request ({exc.code})") from exc
            last_error = exc
            if exc.code in (429, 500, 502, 503, 504):
                time.sleep(1.5 * (attempt + 1))
                continue
            break
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
            last_error = exc
            time.sleep(1.0 * (attempt + 1))
    raise HttpError(f"{url}: {last_error}")


def fetch_bytes(url: str, timeout: int | None = None) -> bytes:
    host = urllib.parse.urlparse(url).netloc
    last_error: Exception | None = None
    for attempt in range(config.HTTP_RETRIES):
        _throttle(host)
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": config.USER_AGENT,
                "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
                **HOST_HEADERS.get(host, {}),
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout or config.HTTP_TIMEOUT) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                raise BlockedError(f"{host} refused the request ({exc.code})") from exc
            if exc.code in (404, 410):
                raise HttpError(f"{url}: {exc}") from exc
            last_error = exc
            time.sleep(1.0 * (attempt + 1))
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_error = exc
            time.sleep(1.0 * (attempt + 1))
    raise HttpError(f"{url}: {last_error}")


def clean(text) -> str | None:
    if text is None:
        return None
    value = " ".join(str(text).split()).strip()
    return value or None
