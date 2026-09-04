"""A very small WSGI toolkit.

Past Perfect serves a handful of routes and a JSON API. That does not warrant a
framework, and the standard library already ships everything needed to do it
properly, so this module supplies the three things that would otherwise be
copied around: a request wrapper, a response builder and a pattern router.
"""

from __future__ import annotations

import json
import mimetypes
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qs

MAX_BODY = 64 * 1024


@dataclass
class Request:
    method: str
    path: str
    query: dict[str, str]
    headers: dict[str, str]
    body: bytes = b""
    params: dict[str, str] = field(default_factory=dict)

    def json(self) -> dict:
        if not self.body:
            return {}
        try:
            payload = json.loads(self.body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}
        return payload if isinstance(payload, dict) else {}

    def get(self, key: str, default: str = "") -> str:
        return self.query.get(key, default)

    def int_param(self, key: str, default: int, low: int, high: int) -> int:
        try:
            value = int(self.query.get(key, default))
        except (TypeError, ValueError):
            return default
        return max(low, min(high, value))

    @property
    def is_json(self) -> bool:
        return "application/json" in self.headers.get("CONTENT_TYPE", "")


@dataclass
class Response:
    body: bytes = b""
    status: str = "200 OK"
    content_type: str = "text/html; charset=utf-8"
    headers: list[tuple[str, str]] = field(default_factory=list)

    def wsgi(self, start_response):
        head = [("Content-Type", self.content_type), ("Content-Length", str(len(self.body)))]
        head.extend(self.headers)
        start_response(self.status, head)
        return [self.body]


def html(markup: str, status: str = "200 OK", cache: int = 0) -> Response:
    headers = [("Cache-Control", f"public, max-age={cache}" if cache else "no-store")]
    return Response(markup.encode("utf-8"), status, "text/html; charset=utf-8", headers)


def json_response(payload, status: str = "200 OK", cache: int = 0) -> Response:
    headers = [("Cache-Control", f"public, max-age={cache}" if cache else "no-store")]
    return Response(
        json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        status,
        "application/json; charset=utf-8",
        headers,
    )


def text(body: str, status: str = "200 OK", content_type: str = "text/plain; charset=utf-8",
         cache: int = 0) -> Response:
    headers = [("Cache-Control", f"public, max-age={cache}")] if cache else []
    return Response(body.encode("utf-8"), status, content_type, headers)


def redirect(location: str, permanent: bool = False) -> Response:
    status = "301 Moved Permanently" if permanent else "302 Found"
    return Response(b"", status, "text/plain", [("Location", location)])


def send_file(path: Path, cache: int = 3600, content_type: str | None = None) -> Response:
    if not path.is_file():
        return text("Not found", "404 Not Found")
    guessed = content_type or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return Response(
        path.read_bytes(),
        "200 OK",
        guessed,
        [("Cache-Control", f"public, max-age={cache}")],
    )


class Router:
    """Routes like ``/museum/<slug>`` and ``/daily/<date:\\d{4}-\\d{2}-\\d{2}>``."""

    def __init__(self) -> None:
        self._routes: list[tuple[str, re.Pattern, callable]] = []

    def add(self, method: str, pattern: str, handler) -> None:
        self._routes.append((method.upper(), self._compile(pattern), handler))

    def get(self, pattern: str):
        def decorate(handler):
            self.add("GET", pattern, handler)
            return handler
        return decorate

    def post(self, pattern: str):
        def decorate(handler):
            self.add("POST", pattern, handler)
            return handler
        return decorate

    @staticmethod
    def _compile(pattern: str) -> re.Pattern:
        def replace(match: re.Match) -> str:
            name, _, custom = match.group(1).partition(":")
            return f"(?P<{name}>{custom or '[^/]+'})"

        return re.compile("^" + re.sub(r"<([^>]+)>", replace, pattern) + "$")

    def resolve(self, method: str, path: str):
        allowed = False
        for verb, pattern, handler in self._routes:
            match = pattern.match(path)
            if not match:
                continue
            if verb != method:
                allowed = True
                continue
            return handler, match.groupdict()
        return (None, {}) if not allowed else ("405", {})


def build_request(environ) -> Request:
    length = 0
    try:
        length = min(int(environ.get("CONTENT_LENGTH") or 0), MAX_BODY)
    except ValueError:
        length = 0
    body = environ["wsgi.input"].read(length) if length else b""
    raw_query = parse_qs(environ.get("QUERY_STRING", ""), keep_blank_values=True)
    return Request(
        method=environ.get("REQUEST_METHOD", "GET").upper(),
        path=environ.get("PATH_INFO", "/") or "/",
        query={k: v[0] for k, v in raw_query.items()},
        headers={k: v for k, v in environ.items() if isinstance(v, str)},
        body=body,
    )
