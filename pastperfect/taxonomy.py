"""Offline classification of museum metadata.

These are the signals the PRD assigns to AI: what part of the world an object
comes from, and whether it *reads* older or newer than it is. They are computed
once, at ingest time, from metadata only -- never during play, and never as an
input to the answer itself.

The rules below are deliberately transparent keyword heuristics. They are the
seam where an offline model pass would slot in later; the rest of the codebase
only consumes the columns they write.
"""

from __future__ import annotations

import re

REGIONS = [
    ("East Asia", r"china|chinese|japan|japanese|korea|korean|tibet|mongolia|qing|ming|edo|meiji"),
    ("South Asia", r"india|indian|nepal|pakistan|sri lanka|bengal|mughal|gandhara"),
    ("Southeast Asia", r"thai|thailand|vietnam|cambodia|indonesia|java|burma|myanmar|philippin"),
    ("Middle East", r"iran|persia|persian|turkey|turkish|ottoman|syria|iraq|arab|islamic|levant|anatolia"),
    ("Africa", r"egypt|nubia|nigeria|ghana|congo|mali|ethiopia|morocco|benin|yoruba|african"),
    ("Oceania", r"australia|new zealand|maori|polynes|melanes|hawai|papua|oceania"),
    ("Latin America", r"mexico|mexican|peru|peruvian|brazil|maya|aztec|inca|colombia|argentin|chile|peruvian"),
    ("North America", r"united states|american|america|canada|canadian|navajo|hopi|new york|boston|chicago"),
    ("Europe", r"france|french|italy|italian|netherland|dutch|holland|german|britain|british|england|english|"
               r"spain|spanish|belgi|flemish|austria|swiss|switzerland|sweden|swedish|denmark|danish|norway|"
               r"russia|russian|poland|polish|greece|greek|roman|scotland|scottish|ireland|irish|portug|hungar|czech"),
]

#: Object types that most people file mentally under "modern", whatever their
#: actual date. A daguerreotype from 1845 reads newer than a 1600s panel painting
#: to almost every player, and that mismatch is what makes a pair surprising.
_READS_MODERN = re.compile(
    r"photograph|photo|negative|daguerreotype|albumen|gelatin silver|calotype|"
    r"poster|advertis|typograph|graphic design|industrial design|product design|"
    r"furniture|chair|lamp|appliance|machine|camera|abstract|geometric",
    re.I,
)
#: Types that read old regardless of date -- a 1930s icon still looks medieval.
_READS_OLD = re.compile(
    r"icon|illuminat|manuscript|fresco|altarpiece|reliquar|tapestr|vellum|parchment|"
    r"papyrus|amphora|sarcophag|mosaic|panel painting|tempera",
    re.I,
)

#: Short human labels for the object's form, used in the reveal one-liner.
_FORMS = [
    ("photograph", r"photograph|daguerreotype|albumen|gelatin silver|negative|calotype"),
    ("print", r"\bprint\b|etching|engraving|lithograph|woodcut|woodblock|aquatint|mezzotint"),
    ("drawing", r"drawing|sketch|watercolou?r|gouache|pastel|charcoal|graphite|chalk"),
    ("painting", r"painting|oil on|tempera|canvas|panel|fresco"),
    ("sculpture", r"sculpture|statue|bronze|marble|carving|relief|terracotta figure"),
    ("textile", r"textile|tapestr|embroider|silk|cotton|weaving|quilt|costume|dress|garment"),
    ("ceramic", r"ceramic|porcelain|stoneware|earthenware|pottery|vase|jar|bowl|plate"),
    ("book or manuscript", r"manuscript|book|folio|album|codex|illuminat|page[s]? "),
    ("furniture", r"furniture|chair|table|cabinet|desk|chest"),
    ("metalwork", r"silver|gold|pewter|iron|steel|brass|jewel|armou?r|coin|medal"),
    ("poster", r"poster|placard|broadside"),
    ("map", r"\bmap\b|chart|atlas|cartograph"),
]


def region_for(*fields: str | None) -> str:
    text = " ".join(f for f in fields if f).lower()
    if not text.strip():
        return "Unknown"
    for name, pattern in REGIONS:
        if re.search(pattern, text):
            return name
    return "Unknown"


def form_for(*fields: str | None) -> str:
    text = " ".join(f for f in fields if f)
    for name, pattern in _FORMS:
        if re.search(pattern, text, re.I):
            return name
    return "object"


def reads_modern(*fields: str | None) -> bool:
    """True when the object's form makes it look newer than a museum object 'should'."""
    text = " ".join(f for f in fields if f)
    if _READS_OLD.search(text):
        return False
    return bool(_READS_MODERN.search(text))


def reads_old(*fields: str | None) -> bool:
    text = " ".join(f for f in fields if f)
    return bool(_READS_OLD.search(text))
