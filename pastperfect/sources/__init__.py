"""Adapters that turn each museum's API into one normalised record shape."""

from . import aic, met, rijksmuseum, wellcome

ADAPTERS = {
    "met": met,
    "aic": aic,
    "wellcome": wellcome,
    "rijksmuseum": rijksmuseum,
}

__all__ = ["ADAPTERS", "met", "aic", "wellcome", "rijksmuseum"]
