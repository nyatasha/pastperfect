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
    # Photographic processes, printed advertising, designed-for-manufacture
    # objects, and materials with a hard modern floor. Deliberately narrow:
    # "furniture" or "geometric" would sweep in baroque cabinets and Islamic
    # tilework, neither of which reads modern to anybody.
    r"photograph|photomechanical|negative|daguerreotype|albumen|gelatin silver|"
    r"calotype|tintype|ambrotype|cyanotype|collotype|"
    r"poster|advertis|typograph|graphic design|industrial design|product design|"
    r"bakelite|plastic|aluminium|aluminum|chromium|chrome-plated|neon|"
    r"abstract",
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
    ("vessel", r"vessel|pitcher|ewer|flask|amphora|beaker|goblet|chalice|urn"),
    ("amulet", r"amulet|talisman|charm"),
    ("stele", r"\bstele|stelae\b"),
    ("architectural fragment", r"architectural|capital \(|column|frieze|lintel"),
    ("mask", r"\bmask\b"),
    ("seal", r"\bseal\b|signet|stamp"),
    ("instrument", r"instrument|violin|flute|drum|lute|guitar"),
    ("weapon", r"weapon|sword|dagger|firearm|pistol|rifle|helmet|shield"),
]

#: Words that describe what a thing is made of, not what it is. A classification
#: reading "limestone" tells a sentence nothing useful.
_MATERIAL_WORDS = {
    "stone", "limestone", "sandstone", "marble", "granite", "wood", "lacquer",
    "ivory", "bone", "glass", "paper", "clay", "bronze", "iron", "gold", "silver",
    "unidentified", "other", "miscellaneous",
}


def region_for(*fields: str | None) -> str:
    text = " ".join(f for f in fields if f).lower()
    if not text.strip():
        return "Unknown"
    for name, pattern in REGIONS:
        if re.search(pattern, text):
            return name
    return "Unknown"


def form_for(*fields: str | None) -> str:
    """A short noun for the object, for use in a sentence."""
    text = " ".join(f for f in fields if f)
    for name, pattern in _FORMS:
        if re.search(pattern, text, re.I):
            return name
    # Nothing matched, so fall back to the museum's own classification when it
    # reads like a thing rather than a substance.
    classification = (fields[1] if len(fields) > 1 else None) or ""
    word = re.sub(r"\(.*?\)", "", classification).strip().lower()
    if word and len(word.split()) <= 2 and word.replace(" ", "").isalpha():
        word = _singular(word)
        if word not in _MATERIAL_WORDS:
            return word
    return "object"


def _singular(word: str) -> str:
    if word.endswith(("ss", "us", "is", "ae")) or not word.endswith("s"):
        return word
    if word.endswith("ies"):
        return word[:-3] + "y"
    return word[:-1]


def reads_modern(*fields: str | None) -> bool:
    """True when the object's form makes it look newer than a museum object 'should'."""
    text = " ".join(f for f in fields if f)
    if _READS_OLD.search(text):
        return False
    return bool(_READS_MODERN.search(text))


def reads_old(*fields: str | None) -> bool:
    text = " ".join(f for f in fields if f)
    return bool(_READS_OLD.search(text))
