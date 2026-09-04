"""A small synthetic collection, so tests never depend on a live harvest."""

from __future__ import annotations

import datetime as _dt
import tempfile
from pathlib import Path

from PIL import Image

from pastperfect import config, db, ingest, media

MUSEUMS = ["met", "aic", "wellcome", "rijksmuseum"]

SPECIMENS = [
    # (title, artist, date label, start, end, medium, classification, culture)
    ("Kneeling bull", None, "ca. 3000 BC", -3005, -2995, "Silver", "Sculpture", "Iran"),
    ("Funerary stele", None, "1st century", 0, 99, "Limestone", "Sculpture", "Egypt"),
    ("Reliquary cross", None, "ca. 1050", 1045, 1055, "Gilded silver", "Metalwork", "Germany"),
    ("Book of hours", None, "1420", 1420, 1420, "Vellum", "Manuscript", "France"),
    ("Portrait of a lady", "Anon", "ca. 1510", 1505, 1515, "Oil on panel", "Painting", "Netherlands"),
    ("Still life with lemons", "Claesz", "1642", 1642, 1642, "Oil on canvas", "Painting", "Netherlands"),
    ("Kabuki actor", "Toyokuni", "1795", 1795, 1795, "Woodblock print", "Print", "Japan"),
    ("View of the harbour", "Turner", "1830", 1830, 1830, "Watercolour", "Drawing", "England"),
    ("Portrait of a surgeon", "Hill", "1845", 1845, 1845, "Calotype", "Photograph", "Scotland"),
    ("Seated woman", "Cameron", "1867", 1867, 1867, "Albumen silver print", "Photograph", "England"),
    ("Poster for a revue", "Cheret", "1893", 1893, 1893, "Colour lithograph", "Poster", "France"),
    ("Side chair", "Rietveld", "1918", 1918, 1918, "Painted wood", "Furniture", "Netherlands"),
    ("Study in grey", "Anon", "1955", 1955, 1955, "Gelatin silver print", "Photograph", "United States"),
    ("Woven hanging", None, "1972", 1972, 1972, "Wool", "Textile", "Peru"),
]


#: Enough further objects that a full ten-question day, with distinct objects
#: and a working cooldown, is actually possible. Generated rather than written
#: out so the interesting hand-made cases above stay easy to read.
def _generated() -> list[tuple]:
    forms = [
        ("Oil on canvas", "Painting"), ("Engraving", "Print"), ("Watercolour", "Drawing"),
        ("Marble", "Sculpture"), ("Porcelain", "Ceramic"), ("Silk", "Textile"),
        ("Silver", "Metalwork"), ("Albumen silver print", "Photograph"),
    ]
    places = ["France", "Japan", "Netherlands", "England", "Mexico", "Iran", "United States", "Italy"]
    out = []
    for index in range(96):
        year = 1400 + index * 6
        medium, classification = forms[index % len(forms)]
        # Keep photographs plausible: the process did not exist before 1839.
        if classification == "Photograph" and year < 1840:
            medium, classification = forms[0]
        out.append((
            f"Specimen {index:02d}", f"Maker {index % 11}", str(year), year, year,
            medium, classification, places[index % len(places)],
        ))
    return out


def build(tmp: Path) -> None:
    """Point config at a temporary tree and fill it with the specimens above."""
    config.DB_PATH = tmp / "test.db"
    config.MEDIA_DIR = tmp / "media"
    config.OG_DIR = tmp / "og"
    config.CACHE_DIR = tmp / "cache"
    db.reset_connection()
    db.init()

    now = _dt.datetime.now(_dt.UTC).isoformat(timespec="seconds")
    rows = []
    for index, spec in enumerate(SPECIMENS + _generated()):
        title, artist, label, start, end, medium, classification, culture = spec
        museum = MUSEUMS[index % len(MUSEUMS)]
        object_id = f"{museum}:test{index}"
        key = media.image_key(object_id)
        _write_image(key)
        rows.append({
            "id": object_id, "museum": museum, "source_id": f"test{index}",
            "title": title, "artist": artist, "artist_note": None,
            "date_display": label, "year_start": start, "year_end": end,
            "year_mid": (start + end) // 2,
            "date_precision": "year" if start == end else "range",
            "medium": medium, "classification": classification, "culture": culture,
            "department": None,
            "region": __import__("pastperfect.taxonomy", fromlist=["x"]).region_for(culture),
            "credit_line": "Test collection", "object_url": f"https://example.org/{object_id}",
            "image_url": f"https://example.org/{object_id}.jpg", "image_key": key,
            "image_w": 400, "image_h": 300, "local_image": 1,
            "license_id": "cc0", "license_label": "CC0 1.0",
            "license_url": "https://creativecommons.org/publicdomain/zero/1.0/",
            "rights_basis": "test fixture",
            "looks_modern": int(__import__("pastperfect.taxonomy", fromlist=["x"])
                                .reads_modern(medium, classification, title)),
            "playable": 1, "exclude_reason": None, "ingested_at": now,
        })
    ingest.store(rows)


def _write_image(key: str) -> None:
    path = media.large_path(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (400, 300), (200, 190, 170)).save(path, "JPEG")
    Image.new("RGB", (240, 180), (200, 190, 170)).save(media.thumb_path(key), "JPEG")


class Sandbox:
    """Context manager giving each test module its own database and media tree."""

    def __enter__(self):
        self._saved = (config.DB_PATH, config.MEDIA_DIR, config.OG_DIR, config.CACHE_DIR)
        self._tmp = tempfile.TemporaryDirectory()
        build(Path(self._tmp.name))
        return Path(self._tmp.name)

    def __exit__(self, *exc):
        db.reset_connection()
        (config.DB_PATH, config.MEDIA_DIR, config.OG_DIR, config.CACHE_DIR) = self._saved
        self._tmp.cleanup()
        return False
