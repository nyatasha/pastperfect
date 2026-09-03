"""The per-object image rights gate.

Rights are evaluated object by object, never museum by museum. A record only
becomes playable when the source states a licence we recognise *and* that licence
is on the allow list. Anything ambiguous -- a missing statement, an unfamiliar
identifier, a NonCommercial or NoDerivatives term -- is excluded rather than
guessed at, because the product intends to carry advertising later and an
unclear licence is not a licence.
"""

from __future__ import annotations

import re

from . import config

#: Maps the many ways the four sources spell a licence onto our canonical ids.
_ALIASES = {
    "cc0": "cc0",
    "cc-zero": "cc0",
    "cc0-1.0": "cc0",
    "publicdomain/zero/1.0": "cc0",
    "creativecommons.org/publicdomain/zero": "cc0",
    "pdm": "pdm",
    "public domain": "pdm",
    "public domain mark": "pdm",
    "publicdomain/mark/1.0": "pdm",
    "creativecommons.org/publicdomain/mark": "pdm",
    "cc-by": "cc-by",
    "cc-by-4.0": "cc-by",
    "licenses/by/4.0": "cc-by",
    "cc-by-sa": "cc-by-sa",
    "licenses/by-sa/4.0": "cc-by-sa",
}

#: Recognised but deliberately refused, so the reason we skipped is specific.
_REFUSED = {
    "cc-by-nc": "NonCommercial",
    "cc-by-nc-sa": "NonCommercial",
    "cc-by-nc-nd": "NonCommercial + NoDerivatives",
    "cc-by-nd": "NoDerivatives",
    "inc": "in copyright",
    "inc-edu": "in copyright, educational use only",
    "ogl": "Open Government Licence (not reviewed)",
    "opl": "Open Parliament Licence (not reviewed)",
}


def normalise(raw: str | None) -> str | None:
    """Canonical licence id for an identifier or URL, or None if unrecognised."""
    if not raw:
        return None
    text = str(raw).strip().lower().rstrip("/")
    if text in _ALIASES:
        return _ALIASES[text]
    if text in _REFUSED or text in config.ALLOWED_LICENCES:
        return text
    for needle, canonical in _ALIASES.items():
        if needle in text:
            return canonical
    m = re.search(r"licenses/(by(?:-[a-z]{2})*)/", text)
    if m:
        return f"cc-{m.group(1)}"
    return None


def evaluate(licence_raw: str | None, basis: str) -> tuple[bool, str, dict]:
    """Decide whether an object's image may be used.

    Returns (allowed, reason, details). ``basis`` records *how* the source told
    us, so a rights question about any object can be answered from the database
    alone.
    """
    canonical = normalise(licence_raw)
    if canonical is None:
        return False, f"no recognised licence statement ({licence_raw or 'absent'})", {}
    if canonical in _REFUSED:
        return False, f"licence excluded: {_REFUSED[canonical]}", {}
    if canonical not in config.ALLOWED_LICENCES:
        return False, f"licence not on the allow list: {canonical}", {}
    label, url = config.ALLOWED_LICENCES[canonical]
    return True, "", {
        "license_id": canonical,
        "license_label": label,
        "license_url": url,
        "rights_basis": basis,
    }


def allowed_summary() -> list[dict]:
    return [
        {"id": key, "label": label, "url": url}
        for key, (label, url) in config.ALLOWED_LICENCES.items()
    ]


def refused_summary() -> list[dict]:
    return [{"id": key, "reason": reason} for key, reason in sorted(_REFUSED.items())]
