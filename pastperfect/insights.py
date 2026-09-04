"""The one-line caption shown at reveal.

The PRD gives AI an offline job here: "generate concise grounded explanations".
Grounded is the operative word, so every sentence below is assembled from fields
that are already in the database -- dates, regions, object types, makers. Nothing
is invented, nothing is fetched at play time, and the caption never carries any
weight in deciding the answer.

Replacing this with an offline model pass means changing one function; the rest
of the codebase only ever reads the ``insight`` column.
"""

from __future__ import annotations

from . import dates, taxonomy


def _form(row: dict) -> str:
    return taxonomy.form_for(row.get("medium"), row.get("classification"), row.get("title"))


def _place(row: dict) -> str | None:
    region = row.get("region")
    return None if not region or region == "Unknown" else region


def _decade(row: dict) -> str:
    return f"{row['year_mid'] // 10 * 10}s"


def _surname(name: str | None) -> str | None:
    if not name:
        return None
    cleaned = name.split("(")[0].strip().rstrip(",")
    return cleaned or None


def for_pair(earlier: dict, later: dict, gap: int, approximate: bool) -> str:
    """Build the reveal caption for one pair."""
    gap_text = dates.describe_gap(gap, approximate)
    early_form, late_form = _form(earlier), _form(later)
    early_place, late_place = _place(earlier), _place(later)
    early_year = dates.format_year(earlier["year_mid"])
    late_year = dates.format_year(later["year_mid"])
    early_maker = _surname(earlier.get("artist"))
    late_maker = _surname(later.get("artist"))

    # The genuinely surprising case: the older object is the one that looks new.
    if earlier.get("looks_modern") and not later.get("looks_modern"):
        return (
            f"The {early_form} is the older of the two — {gap_text}, "
            f"even though it reads as the more modern object."
        )

    if gap <= 3:
        both = (
            f"two {early_form}s" if early_form == late_form
            else f"a {early_form} and a {late_form}"
        )
        if early_place and late_place and early_place != late_place:
            return f"Near-contemporaries: {both}, made in {early_place} and {late_place} {gap_text}."
        return f"Near-contemporaries: {both}, {gap_text}."

    if early_maker and late_maker and early_maker == late_maker:
        return f"Both by {early_maker}, {gap_text} — the {early_form} came first."

    if gap >= 500:
        return (
            f"{dates.century_label(earlier['year_mid'])} against "
            f"{dates.century_label(later['year_mid'])}: {gap_text}."
        )

    if early_place and late_place and early_place != late_place:
        return (
            f"{early_place}, {early_year} against {late_place}, {late_year} — {gap_text}."
        )

    if early_form == late_form:
        return f"Two {early_form}s {gap_text}: {early_year}, then {late_year}."

    if earlier["year_mid"] // 10 == later["year_mid"] // 10:
        return f"Both {_decade(earlier)} work — the {early_form} came first, {gap_text}."

    return f"The {early_form} of {early_year}, then the {late_form} of {late_year} — {gap_text}."
