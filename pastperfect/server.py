"""The development server.

A threaded WSGI server from the standard library. It is enough to serve the
site, and it means running Past Perfect locally needs nothing installed.
"""

from __future__ import annotations

import os
import socket
import socketserver
import sys
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

from . import config, daily, db, store
from .app import application


class QuietHandler(WSGIRequestHandler):
    def log_message(self, fmt, *args):  # noqa: A003
        status = args[1] if len(args) > 1 else ""
        if status.startswith(("4", "5")):
            sys.stderr.write(f"  {self.requestline}  -> {status}\n")


class ThreadedServer(socketserver.ThreadingMixIn, WSGIServer):
    daemon_threads = True
    allow_reuse_address = True


def _in_use(port: int) -> bool:
    """True if anything is already listening, on either stack.

    Binding is not a reliable test here: another server holding [::]:8000 leaves
    127.0.0.1:8000 bindable, and the result is two different sites answering on
    the same port depending on how the browser resolves "localhost".
    """
    for family, address in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as probe:
                probe.settimeout(0.25)
                if probe.connect_ex((address, port)) == 0:
                    return True
        except OSError:
            continue
    return False


def free_port(host: str, preferred: int, attempts: int = 20) -> int:
    for offset in range(attempts):
        candidate = preferred + offset
        if _in_use(candidate):
            continue
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind((host, candidate))
            except OSError:
                continue
        return candidate
    raise SystemExit(f"no free port between {preferred} and {preferred + attempts}")


def serve(host: str | None = None, port: int | None = None) -> None:
    host = host or config.HOST
    wanted = port or config.PORT
    chosen = free_port(host, wanted)
    if chosen != wanted and "PASTPERFECT_BASE_URL" not in os.environ:
        # Canonical links, OpenGraph tags and the sitemap all hang off BASE_URL.
        # If we had to move ports, move those with us so what the browser sees
        # matches where the site actually is.
        config.BASE_URL = f"http://localhost:{chosen}"
    db.init()
    counts = db.counts()
    stats = store.overall_stats()

    base = f"http://localhost:{chosen}"
    print(f"\n  {config.SITE_NAME} — {config.TAGLINE}")
    print(f"  {base}\n")
    print(f"  {stats['objects']:,} objects in play · {counts['pairs']:,} questions · "
          f"{counts['daily_days']} daily sets")
    print(f"  today is puzzle #{daily.puzzle_number(daily.today())} ({daily.today()})")
    if counts["pairs"] == 0:
        print("\n  ! No questions yet. Run: python3 -m pastperfect build")
    print("\n  Ctrl-C to stop\n")

    if chosen != (port or config.PORT):
        print(f"  (port {port or config.PORT} was busy, using {chosen})\n")

    httpd = make_server(host, chosen, application, ThreadedServer, QuietHandler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped\n")
    finally:
        httpd.server_close()
