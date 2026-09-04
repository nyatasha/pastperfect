"""WSGI application: routing, static files and the small non-page endpoints."""

from __future__ import annotations

import datetime as _dt
import re

from . import api, config, daily, http, og, render, store, themes, views

IMAGE_KEY = re.compile(r"^[0-9a-f]{20}$")
DATE_PATTERN = r"\d{4}-\d{2}-\d{2}"

router = http.Router()

# --- pages ---------------------------------------------------------------

router.add("GET", "/", views.home)
router.add("GET", "/daily", views.daily_page)
router.add("GET", f"/daily/<date:{DATE_PATTERN}>", views.daily_page)
router.add("GET", "/daily/<edition>", views.daily_page)
router.add("GET", "/endless", views.endless_page)
router.add("GET", "/endless/<museum>", views.endless_page)
router.add("GET", "/museums", views.museums_index)
router.add("GET", "/museum/<slug>", views.museum_page)
router.add("GET", "/how-to-play", views.how_to_play)
router.add("GET", "/about", views.about)
router.add("GET", "/rights", views.rights_page)
router.add("GET", "/stats", views.stats_page)

# --- api -----------------------------------------------------------------

router.add("GET", "/api/round", api.round_handler)
router.add("POST", "/api/answer", api.answer_handler)
router.add("POST", "/api/daily/complete", api.complete_handler)
router.add("POST", "/api/events", api.events_handler)
router.add("GET", "/api/health", api.health_handler)


# --- media ---------------------------------------------------------------


@router.get(r"/img/<key:[0-9a-f]{20}>.jpg")
def image(request: http.Request) -> http.Response:
    key = request.params["key"]
    if not IMAGE_KEY.match(key):
        return views.not_found(request)
    # Content-addressed by an opaque key, so it can be cached indefinitely.
    return http.send_file(media_large(key), cache=31536000, content_type="image/jpeg")


@router.get(r"/img/<key:[0-9a-f]{20}>.t.jpg")
def image_thumb(request: http.Request) -> http.Response:
    from . import media as media_module

    key = request.params["key"]
    if not IMAGE_KEY.match(key):
        return views.not_found(request)
    path = media_module.thumb_path(key)
    if not path.is_file():
        path = media_module.large_path(key)
    return http.send_file(path, cache=31536000, content_type="image/jpeg")


def media_large(key: str):
    from . import media as media_module

    return media_module.large_path(key)


@router.get(f"/og/daily/<date:{DATE_PATTERN}>.png")
def og_daily(request: http.Request) -> http.Response:
    day = daily.parse_date(request.params["date"])
    if day is None:
        return views.not_found(request)
    return http.send_file(og.render(day), cache=86400, content_type="image/png")


@router.get(f"/og/daily/<edition>/<date:{DATE_PATTERN}>.png")
def og_edition(request: http.Request) -> http.Response:
    edition = request.params["edition"]
    day = daily.parse_date(request.params["date"])
    if day is None or edition not in config.MUSEUMS:
        return views.not_found(request)
    return http.send_file(og.render(day, edition), cache=86400, content_type="image/png")


@router.get("/og/default.png")
def og_default(request: http.Request) -> http.Response:
    return http.send_file(og.default_card(), cache=86400, content_type="image/png")


@router.get(r"/static/<path:.+>")
def static_file(request: http.Request) -> http.Response:
    relative = request.params["path"]
    target = (config.STATIC_DIR / relative).resolve()
    # Refuse anything that escapes the static directory.
    if not str(target).startswith(str(config.STATIC_DIR.resolve())):
        return views.not_found(request)
    return http.send_file(target, cache=3600)


# --- site plumbing -------------------------------------------------------


@router.get("/robots.txt")
def robots(request: http.Request) -> http.Response:
    body = (
        "User-agent: *\n"
        "Allow: /\n"
        "Disallow: /api/\n"
        "Disallow: /stats\n"
        f"Sitemap: {config.BASE_URL}/sitemap.xml\n"
    )
    return http.text(body, cache=3600)


@router.get("/sitemap.xml")
def sitemap(request: http.Request) -> http.Response:
    today = daily.today().isoformat()
    entries = [
        ("/", "daily", "1.0"),
        ("/daily", "daily", "0.9"),
        ("/endless", "weekly", "0.8"),
        ("/museums", "weekly", "0.7"),
        ("/how-to-play", "monthly", "0.5"),
        ("/about", "monthly", "0.4"),
        ("/rights", "monthly", "0.4"),
    ]
    entries += [(f"/museum/{slug}", "weekly", "0.7") for slug in config.MUSEUM_ORDER]
    entries += [(f"/daily/{slug}", "daily", "0.6") for slug in config.MUSEUM_ORDER]
    entries += [(f"/endless/{slug}", "weekly", "0.5") for slug in config.MUSEUM_ORDER]
    urls = "".join(
        f"<url><loc>{config.BASE_URL}{path}</loc><lastmod>{today}</lastmod>"
        f"<changefreq>{freq}</changefreq><priority>{priority}</priority></url>"
        for path, freq, priority in entries
    )
    body = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        f"{urls}</urlset>"
    )
    return http.text(body, content_type="application/xml; charset=utf-8", cache=3600)


@router.get("/manifest.webmanifest")
def manifest(request: http.Request) -> http.Response:
    import json

    payload = {
        "name": config.SITE_NAME,
        "short_name": config.SITE_NAME,
        "description": config.SITE_DESCRIPTION,
        "start_url": "/daily",
        "scope": "/",
        "display": "standalone",
        "background_color": "#FBF6EC",
        "theme_color": "#FBF6EC",
        "orientation": "portrait-primary",
        "categories": ["games", "education"],
        "icons": [
            {"src": "/static/img/icon.svg", "sizes": "any", "type": "image/svg+xml",
             "purpose": "any"},
            {"src": "/static/img/icon-180.png", "sizes": "180x180", "type": "image/png"},
            {"src": "/static/img/icon-512.png", "sizes": "512x512", "type": "image/png",
             "purpose": "any maskable"},
        ],
        "shortcuts": [
            {"name": "Daily Challenge", "url": "/daily"},
            {"name": "Endless", "url": "/endless"},
        ],
    }
    return http.Response(
        json.dumps(payload).encode("utf-8"), "200 OK",
        "application/manifest+json; charset=utf-8",
        [("Cache-Control", "public, max-age=3600")],
    )


@router.get("/sw.js")
def service_worker(request: http.Request) -> http.Response:
    # Served from the root so its scope covers the whole site.
    return http.send_file(config.STATIC_DIR / "js" / "sw.js", cache=0,
                          content_type="application/javascript; charset=utf-8")


# --- WSGI ----------------------------------------------------------------


def application(environ, start_response):
    request = http.build_request(environ)
    path = request.path
    if len(path) > 1 and path.endswith("/"):
        return http.redirect(path.rstrip("/"), permanent=True).wsgi(start_response)

    render.active_theme.set(themes.resolve(request.get("theme")))
    handler, params = router.resolve(request.method, path)
    if handler == "405":
        return http.text("Method not allowed", "405 Method Not Allowed").wsgi(start_response)
    if handler is None:
        return views.not_found(request).wsgi(start_response)

    request.params = params
    try:
        response = handler(request)
    except Exception:  # noqa: BLE001 - never leak a stack trace to a player
        import traceback

        traceback.print_exc()
        if path.startswith("/api/"):
            response = http.json_response({"error": "internal"}, "500 Internal Server Error")
        else:
            response = http.html(
                views.page_error(), status="500 Internal Server Error"
            ) if hasattr(views, "page_error") else http.text(
                "Something went wrong.", "500 Internal Server Error"
            )
    response.headers.extend([
        ("X-Content-Type-Options", "nosniff"),
        ("Referrer-Policy", "strict-origin-when-cross-origin"),
        ("X-Frame-Options", "SAMEORIGIN"),
    ])
    return response.wsgi(start_response)
