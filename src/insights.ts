/**
 * The one-line caption shown at reveal.
 *
 * The PRD gives AI an offline job here: "generate concise grounded
 * explanations". Grounded is the operative word, so every sentence below is
 * assembled from fields that are already in the database -- dates, regions,
 * object types, makers. Nothing is invented, nothing is fetched at play time,
 * and the caption never carries any weight in deciding the answer.
 *
 * Replacing this with an offline model pass means changing one function; the
 * rest of the codebase only ever reads the `insight` column.
 */

import * as dates from "./dates.ts";
import * as taxonomy from "./taxonomy.ts";

export interface InsightRow extends dates.DatedRow {
  title: string;
  artist?: string | null;
  medium?: string | null;
  classification?: string | null;
  region?: string | null;
  looks_modern?: number | boolean | null;
  year_mid?: number | null;
}

const form = (row: InsightRow): string =>
  taxonomy.formFor(row.medium, row.classification, row.title);

const place = (row: InsightRow): string | null => {
  const region = row.region;
  return !region || region === "Unknown" ? null : region;
};

const decade = (row: InsightRow): string => `${Math.floor((row.year_mid ?? 0) / 10) * 10}s`;

function surname(name: string | null | undefined): string | null {
  if (!name) return null;
  const cleaned = name.split("(")[0]!.trim().replace(/,+$/, "");
  return cleaned || null;
}

/**
 * The date to name in a sentence -- the museum's claim, not our midpoint.
 *
 * Same value the card prints, with the article a sentence needs: a card says
 * "6th century", a sentence says "the 6th century".
 */
function when(row: InsightRow): string {
  const text = dates.headline(row);
  return text.endsWith("century") || text.endsWith("century BC") ? `the ${text}` : text;
}

/** Build the reveal caption for one pair. */
export function forPair(
  earlier: InsightRow,
  later: InsightRow,
  gap: number,
  approximate: boolean,
): string {
  const gapText = dates.describeGap(gap, approximate);
  const earlyForm = form(earlier);
  const lateForm = form(later);
  const earlyPlace = place(earlier);
  const latePlace = place(later);
  const earlyYear = when(earlier);
  const lateYear = when(later);
  const earlyMaker = surname(earlier.artist);
  const lateMaker = surname(later.artist);

  // The genuinely surprising case: the older object is the one that looks new.
  if (earlier.looks_modern && !later.looks_modern) {
    return (
      `The ${earlyForm} is the older of the two — ${gapText}, ` +
      "even though it reads as the more modern object."
    );
  }

  if (gap <= 3) {
    const both = earlyForm === lateForm ? `two ${earlyForm}s` : `a ${earlyForm} and a ${lateForm}`;
    if (earlyPlace && latePlace && earlyPlace !== latePlace) {
      return `Near-contemporaries: ${both}, made in ${earlyPlace} and ${latePlace} ${gapText}.`;
    }
    return `Near-contemporaries: ${both}, ${gapText}.`;
  }

  if (earlyMaker && lateMaker && earlyMaker === lateMaker) {
    return `Both by ${earlyMaker}, ${gapText} — the ${earlyForm} came first.`;
  }

  if (gap >= 500) {
    return (
      `${dates.centuryLabel(earlier.year_mid ?? 0)} against ` +
      `${dates.centuryLabel(later.year_mid ?? 0)}: ${gapText}.`
    );
  }

  if (earlyPlace && latePlace && earlyPlace !== latePlace) {
    return `${earlyPlace}, ${earlyYear} against ${latePlace}, ${lateYear} — ${gapText}.`;
  }

  if (earlyForm === lateForm) {
    return `Two ${earlyForm}s ${gapText}: ${earlyYear}, then ${lateYear}.`;
  }

  if (
    dates.isExact(earlier) &&
    dates.isExact(later) &&
    Math.floor((earlier.year_mid ?? 0) / 10) === Math.floor((later.year_mid ?? 0) / 10)
  ) {
    return `Both ${decade(earlier)} work — the ${earlyForm} came first, ${gapText}.`;
  }

  if (earlyForm === "object" || lateForm === "object") {
    // Naming a shape we could not identify adds nothing; let the dates speak.
    const opening = earlyYear.charAt(0).toUpperCase() + earlyYear.slice(1);
    return `${opening}, then ${lateYear} — ${gapText}.`;
  }
  return `The ${earlyForm} of ${earlyYear}, then the ${lateForm} of ${lateYear} — ${gapText}.`;
}
