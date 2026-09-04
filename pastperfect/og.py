"""Share cards.

A shared result must not spoil the puzzle for whoever receives it, so the card
carries the brand, the puzzle number and the date -- and, as decoration, four
extreme close crops of the day's objects. At that magnification the crops read
as texture and colour: enticing, and useless as a clue.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageStat

from . import config, daily, media, store

WIDTH, HEIGHT = 1200, 630
IVORY = (251, 246, 236)
IVORY_WARM = (245, 237, 223)
INK = (23, 20, 15)
INK_SOFT = (111, 103, 90)
ACCENT = (168, 67, 42)

_FONT_DIRS = [
    Path("/System/Library/Fonts/Supplemental"),
    Path("/System/Library/Fonts"),
    Path("/Library/Fonts"),
    Path("/usr/share/fonts/truetype/dejavu"),
    Path("/usr/share/fonts/truetype/liberation"),
]
_SERIF = ["Georgia.ttf", "Times New Roman.ttf", "DejaVuSerif.ttf", "LiberationSerif-Regular.ttf"]
_SERIF_ITALIC = ["Georgia Italic.ttf", "Times New Roman Italic.ttf", "DejaVuSerif-Italic.ttf"]
_SANS = ["Helvetica.ttc", "Arial.ttf", "DejaVuSans.ttf", "LiberationSans-Regular.ttf"]


def _font(names: list[str], size: int):
    for directory in _FONT_DIRS:
        for name in names:
            path = directory / name
            if path.exists():
                try:
                    return ImageFont.truetype(str(path), size)
                except OSError:
                    continue
    return ImageFont.load_default(size)


#: A crop flatter than this is a patch of empty background -- true to the object
#: and useless as decoration, so we look elsewhere on the same image.
MIN_TILE_VARIANCE = 14


def _crop_tile(path_key: str, size: int, rng: random.Random) -> Image.Image | None:
    """An extreme close crop -- roughly a tenth of each edge, so nothing reads."""
    source = media.open_local(path_key)
    if source is None:
        return None
    with source as image:
        image = image.convert("RGB")
        w, h = image.size
        side = max(24, int(min(w, h) * 0.12))
        best = None
        best_variance = -1.0
        for _ in range(7):
            left = rng.randint(0, max(0, w - side))
            top = rng.randint(0, max(0, h - side))
            tile = image.crop((left, top, left + side, top + side))
            variance = sum(ImageStat.Stat(tile).stddev) / 3
            if variance > best_variance:
                best, best_variance = tile, variance
            if variance >= MIN_TILE_VARIANCE:
                break
        return best.resize((size, size), Image.LANCZOS) if best else None


def _card(day: _dt.date, edition: str = "") -> Image.Image:
    canvas = Image.new("RGB", (WIDTH, HEIGHT), IVORY)
    draw = ImageDraw.Draw(canvas)

    rng = random.Random(
        int.from_bytes(hashlib.sha256(f"og:{edition}:{day}".encode()).digest()[:8], "big")
    )
    rows = daily.questions(day, edition)
    keys: list[str] = []
    if rows:
        ids: list[str] = []
        for row in rows:
            ids.extend([row["left_id"], row["right_id"]])
        objects = store.objects_by_ids(ids)
        keys = [objects[i]["image_key"] for i in ids if i in objects]
    if not keys:
        keys = [row["image_key"] for row in store.featured_objects(limit=8)]
    rng.shuffle(keys)

    # A band of crops across the top, then the type below it.
    tile = 180
    band_top = 108
    gap = 16
    count = 4
    total = count * tile + (count - 1) * gap
    x = (WIDTH - total) // 2
    for key in keys[:count]:
        crop = _crop_tile(key, tile, rng)
        if crop is None:
            draw.rectangle([x, band_top, x + tile, band_top + tile], fill=IVORY_WARM)
        else:
            canvas.paste(crop, (x, band_top))
        draw.rectangle([x, band_top, x + tile, band_top + tile], outline=INK_SOFT)
        x += tile + gap

    serif = _font(_SERIF, 74)
    italic = _font(_SERIF_ITALIC, 34)
    sans = _font(_SANS, 24)

    brand_y = band_top + tile + 44
    _centre(draw, "Past Perfect", serif, brand_y, INK)
    _centre(draw, "Which came first? Trust your eye.", italic, brand_y + 100, ACCENT)

    label = config.MUSEUMS[edition]["short_name"] + " edition" if edition else "Daily Challenge"
    line = f"{label}  ·  #{daily.puzzle_number(day)}  ·  {day.strftime('%-d %B %Y')}"
    _centre(draw, line.upper(), sans, brand_y + 158, INK_SOFT, spacing=2)

    draw.line([(0, HEIGHT - 6), (WIDTH, HEIGHT - 6)], fill=ACCENT, width=12)
    return canvas


def _centre(draw, text: str, font, y: int, fill, spacing: int = 0) -> None:
    if spacing:
        widths = [draw.textlength(ch, font=font) + spacing for ch in text]
        x = (WIDTH - (sum(widths) - spacing)) / 2
        for ch, w in zip(text, widths):
            draw.text((x, y), ch, font=font, fill=fill)
            x += w
        return
    width = draw.textlength(text, font=font)
    draw.text(((WIDTH - width) / 2, y), text, font=font, fill=fill)


def path_for(day: _dt.date, edition: str = "") -> Path:
    return config.OG_DIR / f"daily-{edition or 'mixed'}-{day.isoformat()}.png"


def render(day: _dt.date, edition: str = "", force: bool = False) -> Path:
    target = path_for(day, edition)
    if target.exists() and not force:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    _card(day, edition).save(target, "PNG", optimize=True)
    return target


def default_card(force: bool = False) -> Path:
    target = config.OG_DIR / "default.png"
    if target.exists() and not force:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    _card(daily.today()).save(target, "PNG", optimize=True)
    return target
