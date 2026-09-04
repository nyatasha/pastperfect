"""Server-rendered HTML.

Every page a search engine or a share preview might land on is rendered here,
in full, before any JavaScript runs. The game itself hydrates on top of that
shell -- but the homepage, the museum pages and the explanatory pages are
complete documents on their own.
"""

from __future__ import annotations

import html
import json

from . import config

ADS_NOTE = "v0 ships without advertising; see config.ADS_ENABLED."

#: Runs before the stylesheet paints, so a returning player never sees a flash of
#: the theme they did not choose. Absent a stored choice the page falls through
#: to the operating system's preference, handled entirely in CSS.
THEME_BOOTSTRAP = (
    "(function(){try{var t=localStorage.getItem('pastperfect.theme');"
    "if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}"
    "catch(e){}})();"
)

THEME_TOGGLE = """<button class="theme-toggle" id="theme-toggle" type="button"
  aria-label="Switch colour theme" title="Switch colour theme">
  <svg class="icon-light" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4.2"/>
    <path d="M12 2.4v2.2M12 19.4v2.2M4.2 12H2M22 12h-2.2M5.9 5.9 4.4 4.4M19.6 19.6l-1.5-1.5M18.1 5.9l1.5-1.5M4.4 19.6l1.5-1.5"/>
  </svg>
  <svg class="icon-dark" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1Z"/>
  </svg>
</button>"""


def esc(value) -> str:
    return html.escape("" if value is None else str(value), quote=True)


def attr(name: str, value) -> str:
    return f' {name}="{esc(value)}"' if value else ""


def nav(active: str = "") -> str:
    items = [
        ("/daily", "Daily", "daily"),
        ("/endless", "Endless", "endless"),
        ("/museums", "Museums", "museums"),
        ("/stats", "Your stats", "stats"),
    ]
    links = "".join(
        f'<a href="{href}"{" class=is-active" if key == active else ""}>{label}</a>'
        for href, label, key in items
    )
    links += THEME_TOGGLE
    return f"""<header class="site-head">
  <a class="wordmark" href="/" aria-label="{esc(config.SITE_NAME)} home">
    <span class="wordmark-past">Past</span> <span class="wordmark-perfect">Perfect</span>
  </a>
  <nav class="site-nav" aria-label="Main">{links}</nav>
</header>"""


def footer() -> str:
    museums = " · ".join(
        f'<a href="/museum/{slug}">{esc(config.MUSEUMS[slug]["short_name"])}</a>'
        for slug in config.MUSEUM_ORDER
    )
    return f"""<footer class="site-foot">
  <p class="foot-museums">Objects and images from {museums}.</p>
  <p class="foot-links">
    <a href="/how-to-play">How to play</a>
    <a href="/about">About</a>
    <a href="/rights">Image rights</a>
  </p>
  <p class="foot-fine">Every image is used under an open licence stated by the
  museum that holds the object. Past Perfect is not affiliated with, and does not
  imply endorsement by, any of these institutions.</p>
</footer>"""


def ad_slot(placement: str) -> str:
    """Render an advertising slot -- which, in v0, means rendering nothing.

    The PRD is specific about where advertising may eventually go and, more
    importantly, where it may not: never between a question and its answer, and
    never over an artwork. Keeping the permitted placements in code means a
    future change has to name a placement that already passed that review, and
    means personalised ads cannot quietly precede a consent platform.
    """
    if placement not in config.AD_PLACEMENTS:
        raise ValueError(f"{placement!r} is not a reviewed ad placement")
    if not config.ADS_ENABLED:
        return f"<!-- ad slot {placement}: {ADS_NOTE} -->"
    return f'<div class="ad-slot" data-placement="{esc(placement)}"></div>'


def json_ld(payload: dict) -> str:
    return (
        '<script type="application/ld+json">'
        + json.dumps(payload, separators=(",", ":"))
        + "</script>"
    )


def page(
    *,
    title: str,
    description: str,
    body: str,
    path: str = "/",
    active: str = "",
    og_image: str | None = None,
    og_type: str = "website",
    scripts: tuple[str, ...] = (),
    structured: list[dict] | None = None,
    head_extra: str = "",
    body_class: str = "",
    robots: str = "index, follow",
) -> str:
    canonical = f"{config.BASE_URL}{path}"
    image = og_image or "/og/default.png"
    if image.startswith("/"):
        image = f"{config.BASE_URL}{image}"
    full_title = title if title == config.SITE_NAME else f"{title} · {config.SITE_NAME}"
    script_tags = "".join(f'<script src="{esc(src)}" defer></script>' for src in scripts)
    structured_tags = "".join(json_ld(item) for item in structured or [])

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<script>{THEME_BOOTSTRAP}</script>
<title>{esc(full_title)}</title>
<meta name="description" content="{esc(description)}">
<meta name="robots" content="{esc(robots)}">
<link rel="canonical" href="{esc(canonical)}">
<meta property="og:site_name" content="{esc(config.SITE_NAME)}">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(description)}">
<meta property="og:type" content="{esc(og_type)}">
<meta property="og:url" content="{esc(canonical)}">
<meta property="og:image" content="{esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{esc(title)}">
<meta name="twitter:description" content="{esc(description)}">
<meta name="twitter:image" content="{esc(image)}">
<meta name="theme-color" content="#FBF6EC" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#100F0D" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/static/img/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/static/img/icon-180.png">
<link rel="stylesheet" href="/static/css/app.css?v={config.CSS_VERSION}">
{structured_tags}
{head_extra}
</head>
<body class="{esc(body_class)}">
{nav(active)}
<main id="main">{body}</main>
{footer()}
<script src="/static/js/app.js" defer></script>
{script_tags}
</body>
</html>"""
