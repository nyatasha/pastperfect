"""Local image derivatives.

Images are fetched once at ingest time and served from disk under an opaque key.
Two reasons: the game stays fast and works without reaching back out to four
museums on every round, and the URL a player sees in devtools reveals nothing
about which object they are looking at.
"""

from __future__ import annotations

import hashlib
import io
from pathlib import Path

from PIL import Image, ImageOps

from . import config
from .sources.base import HttpError, fetch_bytes

Image.MAX_IMAGE_PIXELS = 200_000_000


def image_key(object_id: str) -> str:
    digest = hashlib.sha256(f"{config.IMAGE_KEY_SALT}:{object_id}".encode("utf-8"))
    return digest.hexdigest()[:20]


def large_path(key: str) -> Path:
    return config.MEDIA_DIR / key[:2] / f"{key}.jpg"


def thumb_path(key: str) -> Path:
    return config.MEDIA_DIR / key[:2] / f"{key}.t.jpg"


def has_local(key: str) -> bool:
    return large_path(key).exists()


def _flatten(image: Image.Image) -> Image.Image:
    image = ImageOps.exif_transpose(image)
    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGBA")
        canvas = Image.new("RGB", image.size, (255, 255, 255))
        canvas.paste(image, mask=image.split()[-1])
        return canvas
    if image.mode != "RGB":
        return image.convert("RGB")
    return image


def _save(image: Image.Image, longest: int, path: Path) -> tuple[int, int]:
    copy = image.copy()
    copy.thumbnail((longest, longest), Image.LANCZOS)
    path.parent.mkdir(parents=True, exist_ok=True)
    copy.save(path, "JPEG", quality=config.IMAGE_QUALITY, optimize=True, progressive=True)
    return copy.size


def ensure(key: str, url: str, force: bool = False) -> tuple[int, int] | None:
    """Download and derive the two sizes we serve. Returns the large size."""
    target = large_path(key)
    if target.exists() and not force:
        try:
            with Image.open(target) as existing:
                return existing.size
        except OSError:
            target.unlink(missing_ok=True)
    try:
        payload = fetch_bytes(url, timeout=60)
    except HttpError:
        return None
    try:
        with Image.open(io.BytesIO(payload)) as source:
            source.load()
            flat = _flatten(source)
    except Exception:
        return None
    if min(flat.size) < 200:
        return None  # too small to look like anything on a big screen
    size = _save(flat, config.IMAGE_LARGE_PX, target)
    _save(flat, config.IMAGE_THUMB_PX, thumb_path(key))
    return size


def open_local(key: str, thumb: bool = False) -> Image.Image | None:
    path = thumb_path(key) if thumb else large_path(key)
    if not path.exists():
        path = large_path(key)
    if not path.exists():
        return None
    return Image.open(path)


def disk_usage() -> int:
    if not config.MEDIA_DIR.exists():
        return 0
    return sum(p.stat().st_size for p in config.MEDIA_DIR.rglob("*.jpg"))
