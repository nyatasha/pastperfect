"""Alternate visual directions, previewable on the live site.

Each theme is a stylesheet layered over app.css, which already keeps its colour,
type and spacing decisions in custom properties. A theme overrides those tokens
and, where the direction demands it, a handful of component rules.

Preview one by appending ?theme=<slug> to any page. The choice is carried across
internal links so a whole direction can be played, not just looked at.
"""

from __future__ import annotations

THEMES = {
    "publication": {
        "name": "Museum Publication",
        "line": "Warm ivory, editorial serif, generous margins.",
        "css": None,  # the default in app.css
    },
    "gallery": {
        "name": "Gallery Dark",
        "line": "A darkened exhibition room; the objects are lit, nothing else is.",
        "css": "/static/css/themes/gallery.css",
    },
    "archive": {
        "name": "Archive",
        "line": "Swiss grid, hard rules, monospace metadata, electric blue.",
        "css": "/static/css/themes/archive.css",
    },
    "puzzle": {
        "name": "Puzzle Room",
        "line": "Soft cream, rounded shapes, chunky type — the daily-game convention.",
        "css": "/static/css/themes/puzzle.css",
    },
    "cinema": {
        "name": "Cinema",
        "line": "Edge-to-edge split screen, chrome floated over the artwork.",
        "css": "/static/css/themes/cinema.css",
    },
}

DEFAULT = "publication"


def resolve(slug: str | None) -> str | None:
    """A known theme slug, or None. Never trusts the query string directly."""
    return slug if slug in THEMES and slug != DEFAULT else None


def stylesheet(slug: str | None) -> str | None:
    theme = THEMES.get(slug or "")
    return theme["css"] if theme else None
