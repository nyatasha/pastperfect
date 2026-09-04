"""Turning museum date strings into intervals we can reason about.

Everything the game asserts about "which came first" is derived from the
intervals produced here, so the parser is deliberately pessimistic: when a label
is vague the interval gets wider, and a wider interval simply means the object
pairs with fewer partners. It never means the game guesses.

Years use the historical convention -- 500 BC is -500 and there is no year zero.
The one-year discrepancy that introduces across the era boundary is irrelevant to
a game about which of two objects came first.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from . import config

# Precision, loosest last. Used for display wording and for deciding whether the
# museum's own structured begin/end fields should be widened by the label.
PRECISION_ORDER = ["year", "range", "circa", "decade", "century", "unknown"]

#: How much wider than the structured range a *numeric* label may be before we
#: treat the extra years as context ("border added 1888-89") rather than as a
#: claim about this object.
DISPLAY_WIDEN_LIMIT = 60

#: Padding applied when a label hedges but the resulting range is a single year.
CIRCA_PAD_YEARS = 5

_DASH = re.compile(r"[‐-―−]")
_CIRCA = re.compile(
    r"\b(c|ca|circa|about|approx|approximately|probably|possibly|perhaps|"
    r"attributed|presumably|likely|est|estimated)\b\.?",
    re.I,
)
_UNKNOWN = re.compile(
    r"\b(n\.?\s?d\.?|no date|undated|date unknown|unknown date|not dated|"
    r"date not recorded)\b",
    re.I,
)
_BCE = re.compile(r"\b(b\.?\s?c\.?(?:\s?e\.?)?)(?![a-z])", re.I)
_CE_MARK = re.compile(r"\b(a\.?\s?d\.?|c\.?\s?e\.?)(?![a-z])", re.I)
#: "Edo period (1615-1868)" -- those years describe the period, not the object.
_PERIOD_PAREN = re.compile(
    r"\b(period|dynasty|era|kingdom|reign|empire|republic|style)\b[^()]*\(([^)]*)\)",
    re.I,
)
#: "first half", "last quarter" -- these name a slice of a century, and their
#: ordinal words must not be mistaken for the century number itself.
_FRACTION = re.compile(
    r"\b(first|second|third|fourth|last|latter|final)[\s-]+(half|third|quarter)\b", re.I
)

_ORDINAL_WORDS = {
    "eleventh": 11, "twelfth": 12, "thirteenth": 13, "fourteenth": 14,
    "fifteenth": 15, "sixteenth": 16, "seventeenth": 17, "eighteenth": 18,
    "nineteenth": 19, "twentieth": 20, "twenty-first": 21, "first": 1,
    "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6,
    "seventh": 7, "eighth": 8, "ninth": 9, "tenth": 10,
}

#: Offsets into a century, as (first year, last year) counted from its start.
_QUALIFIERS = {
    "early": (0, 32), "mid": (33, 66), "late": (67, 99),
    "first half": (0, 49), "second half": (50, 99), "latter half": (50, 99),
    "first third": (0, 32), "second third": (33, 66), "last third": (67, 99),
    "first quarter": (0, 24), "second quarter": (25, 49),
    "third quarter": (50, 74), "fourth quarter": (75, 99), "last quarter": (75, 99),
}


@dataclass(frozen=True)
class DateEstimate:
    """The years an object could have been made, inclusive at both ends."""

    start: int
    end: int
    precision: str
    display: str

    @property
    def span(self) -> int:
        return self.end - self.start

    @property
    def midpoint(self) -> int:
        return (self.start + self.end) // 2

    @property
    def is_exact(self) -> bool:
        return self.precision == "year" and self.span == 0

    def playable(self) -> bool:
        return (
            self.start <= self.end
            and self.span <= config.MAX_OBJECT_SPAN_YEARS
            and config.MIN_YEAR <= self.start
            and self.end <= config.MAX_YEAR
        )


def _looser(a: str, b: str) -> str:
    return a if PRECISION_ORDER.index(a) >= PRECISION_ORDER.index(b) else b


def _normalise(text: str) -> str:
    text = _DASH.sub("-", text or "")
    return re.sub(r"\s+", " ", text).strip()


def _find_qualifier(lower: str) -> tuple[int, int] | None:
    for phrase in ("first half", "second half", "latter half", "first third",
                   "second third", "last third", "first quarter", "second quarter",
                   "third quarter", "fourth quarter", "last quarter"):
        if phrase in lower or phrase.replace(" ", "-") in lower:
            return _QUALIFIERS[phrase]
    if re.search(r"\b(early|beginning of)\b", lower):
        return _QUALIFIERS["early"]
    if re.search(r"\b(late|end of)\b", lower):
        return _QUALIFIERS["late"]
    if re.search(r"\b(mid|middle)\b", lower):
        return _QUALIFIERS["mid"]
    return None


def _century_bounds(n: int, offsets: tuple[int, int] | None, bce: bool) -> tuple[int, int]:
    """17th century -> 1600-1699, the convention museums index on.

    For BCE the pair returned counts *years before the era*, so the 1st century
    BC comes back as 1-100 and negating it later yields -100..-1.
    """
    lo_off, hi_off = offsets or (0, 99)
    base = (n - 1) * 100
    if bce:
        # Counting backwards, the earlier part of a century is the higher number.
        return base + (100 - hi_off), base + (100 - lo_off)
    return base + lo_off, base + hi_off


def _years_in(text: str) -> list[int]:
    """Years mentioned in a label, expanding abbreviated ranges like 1884-86.

    Only 3- and 4-digit numbers count. Bare short numbers in museum labels are
    volumes, plates and sheet counts far more often than they are dates.
    """
    out: list[int] = []
    consumed: list[tuple[int, int]] = []
    for m in re.finditer(r"(?<!\d)(\d{3,4})\s*[-/]\s*(\d{1,4})(?!\d)", text):
        a, b = m.group(1), m.group(2)
        ai = int(a)
        if len(b) < len(a):  # 1884-86 -> 1884-1886
            bi = int(a[: len(a) - len(b)] + b)
            if bi < ai:
                bi += 10 ** len(b)
        else:
            bi = int(b)
        out.extend([ai, bi])
        consumed.append(m.span())
    for m in re.finditer(r"(?<!\d)(\d{3,4})(?!\d)", text):
        if not any(s <= m.start() < e for s, e in consumed):
            out.append(int(m.group(1)))
    return sorted(set(out))


def parse_display(text: str) -> DateEstimate | None:
    """Best-effort interval for a human-written date label, or None."""
    raw = _normalise(text)
    if not raw or _UNKNOWN.search(raw):
        return None

    # Drop period parentheticals before looking for years.
    work = _PERIOD_PAREN.sub(lambda m: m.group(0).split("(")[0], raw)
    work = work.replace("[", " ").replace("]", " ")

    bce = bool(_BCE.search(work))
    # Strip era markers first: "B.C." would otherwise trip the circa "c" pattern.
    work = _CE_MARK.sub(" ", _BCE.sub(" ", work))
    circa = bool(_CIRCA.search(work)) or "?" in work
    lower = work.lower()

    def finish(start: int, end: int, precision: str) -> DateEstimate:
        if bce:
            start, end = -max(start, end), -min(start, end)
        if circa:
            precision = _looser(precision, "circa")
            if end - start < CIRCA_PAD_YEARS * 2:
                start -= CIRCA_PAD_YEARS
                end += CIRCA_PAD_YEARS
        return DateEstimate(start, end, precision, raw)

    # --- century ---------------------------------------------------------
    if "centur" in lower:
        offsets = _find_qualifier(lower)
        hunt = _FRACTION.sub(" ", lower)  # "first half" must not read as century 1
        cents = [int(m) for m in re.findall(r"(?<!\d)(\d{1,2})(?:st|nd|rd|th)\b", hunt)]
        if not cents:
            cents = [n for w, n in _ORDINAL_WORDS.items() if re.search(rf"\b{re.escape(w)}\b", hunt)]
        cents = [c for c in cents if 1 <= c <= 21]
        if cents:
            single = len(set(cents)) == 1
            bounds = [_century_bounds(c, offsets if single else None, bce) for c in set(cents)]
            return finish(min(b[0] for b in bounds), max(b[1] for b in bounds), "century")

    # --- open decade / century shorthand: 18--, 19??, 185- ---------------
    m = re.search(r"(?<!\d)(\d{2})[-?]{2}\??(?!\d)", work)
    if m:
        base = int(m.group(1)) * 100
        return finish(base, base + 99, "century")
    m = re.search(r"(?<!\d)(\d{3})[-?](?!\d)", work)
    if m:
        base = int(m.group(1)) * 10
        return finish(base, base + 9, "decade")

    # --- decade or century written as 1890s / 1500s ----------------------
    m = re.search(r"(?<!\d)(\d{3,4})0s\b", lower)
    if m:
        base = int(m.group(1)) * 10
        # "1500s" reads as either the decade or the whole century. Take the wider
        # reading; a wider interval can only make the game more careful.
        if base % 100 == 0:
            return finish(base, base + 99, "century")
        return finish(base, base + 9, "decade")

    years = _years_in(work)
    if not years:
        return None

    # --- open-ended labels -----------------------------------------------
    if re.search(r"\b(before|prior to|not after|ante)\b", lower):
        end = max(years)
        return finish(end - 25, end, "circa")
    if re.search(r"\b(after|not before|post)\b", lower) and len(years) == 1:
        return finish(years[0], years[0] + 25, "circa")

    lo, hi = min(years), max(years)
    return finish(lo, hi, "year" if lo == hi else "range")


def estimate(display: str | None, start: int | None, end: int | None) -> DateEstimate | None:
    """Reconcile a museum's structured begin/end fields with its date label.

    The structured fields are the museum's authoritative per-object claim. The
    label fills in when they are missing, and widens them when it openly states
    vagueness -- "19th century" against a structured 1850-1850.
    """
    label = _normalise(display or "")
    parsed = parse_display(label) if label else None

    structured: DateEstimate | None = None
    if start is not None and end is not None:
        s, e = int(start), int(end)
        if s > e:
            s, e = e, s
        if config.MIN_YEAR <= s and e <= config.MAX_YEAR:
            structured = DateEstimate(s, e, "year" if s == e else "range", label)

    if structured is None:
        return parsed
    if parsed is None:
        return structured

    precision = _looser(structured.precision, parsed.precision)
    if parsed.precision in ("century", "decade", "circa"):
        # The label admits it is vague; honour that even when the museum's
        # numeric fields look confident.
        lo, hi = min(structured.start, parsed.start), max(structured.end, parsed.end)
    elif parsed.span - structured.span > DISPLAY_WIDEN_LIMIT:
        # A far wider numeric label is context, not a claim about this object.
        return structured
    else:
        lo, hi = min(structured.start, parsed.start), max(structured.end, parsed.end)

    return DateEstimate(lo, hi, precision, label)


def representative_year(estimate: DateEstimate) -> int:
    """The single year we print and measure gaps from.

    Prefer the year the museum actually wrote down, whenever its label names one
    and that year sits inside the interval. The interval stays as wide as the
    evidence demands -- that is what the answer is derived from -- but the number
    a player reads is then the museum's own claim rather than our arithmetic.
    """
    parsed = parse_display(estimate.display) if estimate.display else None
    if parsed and parsed.precision == "year" and parsed.span == 0:
        if estimate.start <= parsed.start <= estimate.end:
            return parsed.start
    return estimate.midpoint


# --- presentation ---------------------------------------------------------


def format_year(year: int) -> str:
    return f"{abs(year)} BC" if year < 0 else str(year)


def _ordinal(n: int) -> str:
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def century_label(year: int) -> str:
    if year < 0:
        return f"{_ordinal((abs(year) - 1) // 100 + 1)} century BC"
    return f"{_ordinal(year // 100 + 1)} century"


def century_key(year: int) -> int:
    """Signed century bucket, used for the weak-period insight."""
    return year // 100 if year >= 0 else -((abs(year) - 1) // 100 + 1)


def headline(row: dict) -> str:
    """The short date to print for an object.

    Derived from the museum's own label wherever that label names a year or a
    century, so nothing we print ever claims more precision than the museum did.
    A range stays a range: an object the Art Institute dates 1700-50 is never
    described as being from 1725.
    """
    parsed = parse_display(row.get("date_display") or "")
    if parsed and parsed.precision == "year" and parsed.span == 0:
        return format_year(parsed.start)
    if row.get("date_precision") == "century":
        return century_label(row.get("year_mid", 0))
    start, end = row.get("year_start"), row.get("year_end")
    if start is None or end is None or start == end:
        return format_year(row.get("year_mid", 0))
    return f"{format_year(start)}\u2013{format_year(end)}"


def is_exact(row: dict) -> bool:
    return row.get("date_precision") == "year" and row.get("year_start") == row.get("year_end")


def describe_gap(years: int, approximate: bool) -> str:
    if years <= 0:
        return "the same year"
    if years == 1:
        return "1 year apart"
    prefix = "about " if approximate else ""
    if years >= 1000:
        return f"{prefix}{round(years / 100) * 100:,} years apart"
    if years >= 100:
        return f"{prefix}{round(years / 10) * 10} years apart"
    return f"{prefix}{years} years apart"
