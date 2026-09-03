"""Central configuration.

Everything tunable about ingestion, the answer/date logic and the launch mix lives
here so the rules are auditable in one place rather than scattered through the code.
"""

from __future__ import annotations

import datetime as _dt
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
SEED_DIR = DATA_DIR / "seed"
CACHE_DIR = DATA_DIR / "cache"
MEDIA_DIR = DATA_DIR / "media"
OG_DIR = DATA_DIR / "og"
STATIC_DIR = ROOT / "static"
DB_PATH = Path(os.environ.get("PASTPERFECT_DB", DATA_DIR / "pastperfect.db"))

SITE_NAME = "Past Perfect"
TAGLINE = "Which came first? Trust your eye."
SITE_DESCRIPTION = (
    "A daily visual game built from open museum collections. Two objects, "
    "no labels. Guess which one came first."
)
# Absolute base used in canonical URLs, OpenGraph tags and the sitemap.
BASE_URL = os.environ.get("PASTPERFECT_BASE_URL", "http://localhost:8000").rstrip("/")

HOST = os.environ.get("PASTPERFECT_HOST", "127.0.0.1")
PORT = int(os.environ.get("PASTPERFECT_PORT", "8000"))

# Salt for the opaque image keys. Images are served under a hash rather than the
# museum object id so that a curious player cannot look up the answer in devtools.
IMAGE_KEY_SALT = os.environ.get("PASTPERFECT_IMAGE_SALT", "past-perfect-v1")

# --- Launch museum mix ----------------------------------------------------

MUSEUMS = {
    "met": {
        "slug": "met",
        "name": "The Metropolitan Museum of Art",
        "short_name": "The Met",
        "country": "United States",
        "city": "New York",
        "site": "https://www.metmuseum.org/",
        "api_docs": "https://metmuseum.github.io/",
        "data_policy": (
            "The Met releases images of public-domain works under Creative Commons "
            "Zero and publishes the same rights flag through its Collection API."
        ),
        "accent": "#8C3B2B",
    },
    "aic": {
        "slug": "aic",
        "name": "Art Institute of Chicago",
        "short_name": "Art Institute of Chicago",
        "country": "United States",
        "city": "Chicago",
        "site": "https://www.artic.edu/",
        "api_docs": "https://api.artic.edu/docs/",
        "data_policy": (
            "The Art Institute marks public-domain artworks in its API and serves "
            "their images through a IIIF endpoint under CC0."
        ),
        "accent": "#2F5C7A",
    },
    "wellcome": {
        "slug": "wellcome",
        "name": "Wellcome Collection",
        "short_name": "Wellcome Collection",
        "country": "United Kingdom",
        "city": "London",
        "site": "https://wellcomecollection.org/",
        "api_docs": "https://developers.wellcomecollection.org/api/catalogue",
        "data_policy": (
            "Wellcome states a licence per digital location. Only openly licensed "
            "IIIF images are ingested; anything in copyright is skipped."
        ),
        "accent": "#4A5D3A",
    },
    "rijksmuseum": {
        "slug": "rijksmuseum",
        "name": "Rijksmuseum",
        "short_name": "Rijksmuseum",
        "country": "Netherlands",
        "city": "Amsterdam",
        "site": "https://www.rijksmuseum.nl/",
        "api_docs": "https://data.rijksmuseum.nl/docs/search",
        "data_policy": (
            "The Rijksmuseum publishes rights per object as Linked Art. Only "
            "objects whose image carries a public-domain statement are ingested."
        ),
        "accent": "#7A5A2E",
    },
}
MUSEUM_ORDER = ["met", "aic", "wellcome", "rijksmuseum"]

# --- Date / answer logic --------------------------------------------------

#: Objects dated more loosely than this are never played. A 150-year window still
#: pairs safely against a distant object, but anything vaguer is editorially weak.
MAX_OBJECT_SPAN_YEARS = 150

#: Sanity bounds. Anything outside is treated as a bad record, not a very old one.
MIN_YEAR = -4000
MAX_YEAR = _dt.date.today().year + 1

#: A pair is only playable when the two date ranges do not overlap at all, so the
#: correct answer holds no matter where inside each range the true date falls.
MIN_PAIR_GAP_YEARS = 1

#: Questions per daily challenge.
DAILY_QUESTIONS = 10

#: Difficulty curve for the daily: gentle opening, hard finish.
DAILY_DIFFICULTY_CURVE = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]

#: Puzzle numbering origin. Day 1 of Past Perfect.
EPOCH_DATE = _dt.date(2026, 9, 1)

#: A daily set never reuses an object seen in the previous N days.
DAILY_COOLDOWN_DAYS = 14

#: Museum pages only feature objects that are not in a daily set within this
#: window either side of today, so browsing the site cannot spoil the puzzle.
FEATURE_SPOILER_WINDOW_DAYS = 7

#: Percentiles are only shown once a day's sample is big enough to mean anything.
PERCENTILE_MIN_SAMPLE = 20

# --- Rights gate ----------------------------------------------------------

#: Licences we are willing to play. Attribution is always displayed, so CC-BY is
#: fine; NonCommercial and NoDerivatives are excluded because the product intends
#: to carry advertising later, and anything unknown is excluded outright.
ALLOWED_LICENCES = {
    "cc0": ("CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/"),
    "pdm": ("Public Domain Mark 1.0", "https://creativecommons.org/publicdomain/mark/1.0/"),
    "cc-by": ("CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/"),
    "cc-by-sa": ("CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/"),
}

# --- Monetisation ---------------------------------------------------------

#: v0 ships with no advertising at all. The slot machinery exists so the allowed
#: placements are encoded in code rather than in a document, but nothing renders
#: until this is switched on -- and it must not be switched on for UK/EEA traffic
#: before a Google-certified IAB TCF consent platform is in place.
#: https://support.google.com/adsense/answer/13554116?hl=en-GB
ADS_ENABLED = False

#: Placements the PRD permits. Anything not on this list is a bug, not a decision.
AD_PLACEMENTS = {
    "home-below-cta",
    "daily-after-result",
    "endless-interstitial",
    "desktop-rail",
}
#: Rounds a player must finish in endless before an interstitial may appear.
ENDLESS_AD_AFTER_ROUNDS = 10

# --- Retention ------------------------------------------------------------

#: Completed dailies before we are allowed to even offer a reminder opt-in.
REMINDER_OFFER_AFTER_DAILIES = 3
#: Answers required before the Art Eye rating and weak-period insight appear.
ART_EYE_MIN_ANSWERS = 40

# --- Ingestion ------------------------------------------------------------

USER_AGENT = "PastPerfect/0.1 (open museum data game; contact: hello@pastperfect.example)"
HTTP_TIMEOUT = 30
HTTP_RETRIES = 3
INGEST_WORKERS = 4
#: Longest edge of the derivative we store and serve.
IMAGE_LARGE_PX = 1100
IMAGE_THUMB_PX = 480
IMAGE_QUALITY = 82


def museum(slug: str) -> dict:
    return MUSEUMS[slug]


def museum_name(slug: str) -> str:
    m = MUSEUMS.get(slug)
    return m["name"] if m else slug
