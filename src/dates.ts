/**
 * Turning museum date strings into intervals we can reason about.
 *
 * Everything the game asserts about "which came first" is derived from the
 * intervals produced here, so the parser is deliberately pessimistic: when a
 * label is vague the interval gets wider, and a wider interval simply means the
 * object pairs with fewer partners. It never means the game guesses.
 *
 * Years use the historical convention -- 500 BC is -500 and there is no year
 * zero. The one-year discrepancy that introduces across the era boundary is
 * irrelevant to a game about which of two objects came first.
 */

import * as config from "./config.ts";

/** Loosest last. Drives display wording and how much a label may widen a range. */
export const PRECISION_ORDER = ["year", "range", "circa", "decade", "century", "unknown"] as const;
export type Precision = (typeof PRECISION_ORDER)[number];

/**
 * How much wider than the structured range a *numeric* label may be before we
 * treat the extra years as context ("border added 1888-89", "Edo period
 * (1615-1868)") rather than as a claim about this object.
 */
export const DISPLAY_WIDEN_LIMIT = 60;

/** Padding applied when a label hedges but the resulting range is one year. */
export const CIRCA_PAD_YEARS = 5;

const DASH = /[‐-―−]/g;
const CIRCA =
  /\b(c|ca|circa|about|approx|approximately|probably|possibly|perhaps|attributed|presumably|likely|est|estimated)\b\.?/i;
const UNKNOWN =
  /\b(n\.?\s?d\.?|no date|undated|date unknown|unknown date|not dated|date not recorded)\b/i;
const BCE = /\b(b\.?\s?c\.?(?:\s?e\.?)?)(?![a-z])/gi;
const CE_MARK = /\b(a\.?\s?d\.?|c\.?\s?e\.?)(?![a-z])/gi;
/** "Edo period (1615-1868)" -- those years describe the period, not the object. */
const PERIOD_PAREN = /\b(period|dynasty|era|kingdom|reign|empire|republic|style)\b[^()]*\(([^)]*)\)/gi;
/**
 * "first half", "last quarter" -- these name a slice of a century, and their
 * ordinal words must not be mistaken for the century number itself.
 */
const FRACTION = /\b(first|second|third|fourth|last|latter|final)[\s-]+(half|third|quarter)\b/gi;

const ORDINAL_WORDS: ReadonlyArray<readonly [string, number]> = [
  ["eleventh", 11], ["twelfth", 12], ["thirteenth", 13], ["fourteenth", 14],
  ["fifteenth", 15], ["sixteenth", 16], ["seventeenth", 17], ["eighteenth", 18],
  ["nineteenth", 19], ["twentieth", 20], ["twenty-first", 21], ["first", 1],
  ["second", 2], ["third", 3], ["fourth", 4], ["fifth", 5], ["sixth", 6],
  ["seventh", 7], ["eighth", 8], ["ninth", 9], ["tenth", 10],
];

/** Offsets into a century, as [first year, last year] counted from its start. */
const QUALIFIERS: Record<string, readonly [number, number]> = {
  early: [0, 32], mid: [33, 66], late: [67, 99],
  "first half": [0, 49], "second half": [50, 99], "latter half": [50, 99],
  "first third": [0, 32], "second third": [33, 66], "last third": [67, 99],
  "first quarter": [0, 24], "second quarter": [25, 49],
  "third quarter": [50, 74], "fourth quarter": [75, 99], "last quarter": [75, 99],
};

/** The years an object could have been made, inclusive at both ends. */
export interface DateEstimate {
  readonly start: number;
  readonly end: number;
  readonly precision: Precision;
  readonly display: string;
}

export const span = (e: DateEstimate): number => e.end - e.start;
export const midpoint = (e: DateEstimate): number => Math.floor((e.start + e.end) / 2);
export const isExactEstimate = (e: DateEstimate): boolean =>
  e.precision === "year" && span(e) === 0;

export function playable(e: DateEstimate): boolean {
  return (
    e.start <= e.end &&
    span(e) <= config.MAX_OBJECT_SPAN_YEARS &&
    config.MIN_YEAR <= e.start &&
    e.end <= config.MAX_YEAR
  );
}

function looser(a: Precision, b: Precision): Precision {
  return PRECISION_ORDER.indexOf(a) >= PRECISION_ORDER.indexOf(b) ? a : b;
}

function normalise(text: string): string {
  return (text ?? "").replace(DASH, "-").replace(/\s+/g, " ").trim();
}

function findQualifier(lower: string): readonly [number, number] | null {
  const phrases = [
    "first half", "second half", "latter half", "first third", "second third",
    "last third", "first quarter", "second quarter", "third quarter",
    "fourth quarter", "last quarter",
  ];
  for (const phrase of phrases) {
    if (lower.includes(phrase) || lower.includes(phrase.replace(" ", "-"))) {
      return QUALIFIERS[phrase]!;
    }
  }
  if (/\b(early|beginning of)\b/.test(lower)) return QUALIFIERS["early"]!;
  if (/\b(late|end of)\b/.test(lower)) return QUALIFIERS["late"]!;
  if (/\b(mid|middle)\b/.test(lower)) return QUALIFIERS["mid"]!;
  return null;
}

/**
 * 17th century -> 1600-1699, the convention museums index on.
 *
 * For BCE the pair returned counts *years before the era*, so the 1st century
 * BC comes back as 1-100 and negating it later yields -100..-1.
 */
function centuryBounds(
  n: number,
  offsets: readonly [number, number] | null,
  bce: boolean,
): [number, number] {
  const [loOff, hiOff] = offsets ?? [0, 99];
  const base = (n - 1) * 100;
  if (bce) {
    // Counting backwards, the earlier part of a century is the higher number.
    return [base + (100 - hiOff), base + (100 - loOff)];
  }
  return [base + loOff, base + hiOff];
}

/**
 * Years mentioned in a label, expanding abbreviated ranges like 1884-86.
 *
 * Both dash and slash separate a range: the Met writes "1884-86" and the Art
 * Institute writes "1630/36" for the same idea. Only 3- and 4-digit numbers
 * count as years -- bare short numbers in museum labels are volumes, plates and
 * sheet counts far more often than they are dates, which is also why "14/3/94"
 * yields nothing rather than a spurious range.
 */
function yearsIn(text: string): number[] {
  const out: number[] = [];
  const consumed: Array<[number, number]> = [];

  for (const m of text.matchAll(/(?<!\d)(\d{3,4})\s*[-/]\s*(\d{1,4})(?!\d)/g)) {
    const a = m[1]!;
    const b = m[2]!;
    const ai = Number(a);
    let bi: number;
    if (b.length < a.length) {
      bi = Number(a.slice(0, a.length - b.length) + b);
      if (bi < ai) bi += 10 ** b.length;
    } else {
      bi = Number(b);
    }
    out.push(ai, bi);
    consumed.push([m.index, m.index + m[0].length]);
  }

  for (const m of text.matchAll(/(?<!\d)(\d{3,4})(?!\d)/g)) {
    if (!consumed.some(([s, e]) => s <= m.index && m.index < e)) out.push(Number(m[1]!));
  }
  return [...new Set(out)].sort((x, y) => x - y);
}

/** Best-effort interval for a human-written date label, or null. */
export function parseDisplay(text: string): DateEstimate | null {
  const raw = normalise(text);
  if (!raw || UNKNOWN.test(raw)) return null;

  // Drop period parentheticals before looking for years.
  let work = raw.replace(PERIOD_PAREN, (m) => m.split("(")[0]!);
  work = work.replace(/\[/g, " ").replace(/\]/g, " ");

  const bce = new RegExp(BCE.source, "i").test(work);
  // Strip era markers first: "B.C." would otherwise trip the circa "c" pattern.
  work = work.replace(BCE, " ").replace(CE_MARK, " ");
  const circa = CIRCA.test(work) || work.includes("?");
  const lower = work.toLowerCase();

  const finish = (start: number, end: number, precision: Precision): DateEstimate => {
    let [s, e] = bce ? [-Math.max(start, end), -Math.min(start, end)] : [start, end];
    let p = precision;
    if (circa) {
      p = looser(p, "circa");
      if (e - s < CIRCA_PAD_YEARS * 2) {
        s -= CIRCA_PAD_YEARS;
        e += CIRCA_PAD_YEARS;
      }
    }
    return { start: s, end: e, precision: p, display: raw };
  };

  // --- century ---------------------------------------------------------
  if (lower.includes("centur")) {
    const offsets = findQualifier(lower);
    const hunt = lower.replace(FRACTION, " "); // "first half" must not read as century 1
    let cents = [...hunt.matchAll(/(?<!\d)(\d{1,2})(?:st|nd|rd|th)\b/g)].map((m) => Number(m[1]!));
    if (cents.length === 0) {
      cents = ORDINAL_WORDS.filter(([w]) => new RegExp(`\\b${w}\\b`).test(hunt)).map(([, n]) => n);
    }
    cents = cents.filter((c) => c >= 1 && c <= 21);
    if (cents.length > 0) {
      const unique = [...new Set(cents)];
      const bounds = unique.map((c) => centuryBounds(c, unique.length === 1 ? offsets : null, bce));
      return finish(
        Math.min(...bounds.map((b) => b[0])),
        Math.max(...bounds.map((b) => b[1])),
        "century",
      );
    }
  }

  // --- open decade / century shorthand: 18--, 19??, 185- ---------------
  const openCentury = work.match(/(?<!\d)(\d{2})[-?]{2}\??(?!\d)/);
  if (openCentury) {
    const base = Number(openCentury[1]!) * 100;
    return finish(base, base + 99, "century");
  }
  const openDecade = work.match(/(?<!\d)(\d{3})[-?](?!\d)/);
  if (openDecade) {
    const base = Number(openDecade[1]!) * 10;
    return finish(base, base + 9, "decade");
  }

  // --- decade or century written as 1890s / 1500s ----------------------
  const sForm = lower.match(/(?<!\d)(\d{3,4})0s\b/);
  if (sForm) {
    const base = Number(sForm[1]!) * 10;
    // "1500s" reads as either the decade or the whole century. Take the wider
    // reading; a wider interval can only make the game more careful.
    if (base % 100 === 0) return finish(base, base + 99, "century");
    return finish(base, base + 9, "decade");
  }

  const years = yearsIn(work);
  if (years.length === 0) return null;

  // --- open-ended labels -----------------------------------------------
  if (/\b(before|prior to|not after|ante)\b/.test(lower)) {
    const end = Math.max(...years);
    return finish(end - 25, end, "circa");
  }
  if (/\b(after|not before|post)\b/.test(lower) && years.length === 1) {
    return finish(years[0]!, years[0]! + 25, "circa");
  }

  const lo = Math.min(...years);
  const hi = Math.max(...years);
  return finish(lo, hi, lo === hi ? "year" : "range");
}

/**
 * Reconcile a museum's structured begin/end fields with its date label.
 *
 * The structured fields are the museum's authoritative per-object claim. The
 * label fills in when they are missing, and widens them when it openly states
 * vagueness -- "19th century" against a structured 1850-1850.
 */
export function estimate(
  display: string | null | undefined,
  start: number | null | undefined,
  end: number | null | undefined,
): DateEstimate | null {
  const label = normalise(display ?? "");
  const parsed = label ? parseDisplay(label) : null;

  let structured: DateEstimate | null = null;
  if (start !== null && start !== undefined && end !== null && end !== undefined) {
    let s = Math.trunc(start);
    let e = Math.trunc(end);
    if (s > e) [s, e] = [e, s];
    if (config.MIN_YEAR <= s && e <= config.MAX_YEAR) {
      structured = { start: s, end: e, precision: s === e ? "year" : "range", display: label };
    }
  }

  if (!structured) return parsed;
  if (!parsed) return structured;

  let precision = looser(structured.precision, parsed.precision);
  let lo: number;
  let hi: number;
  if (parsed.precision === "century" || parsed.precision === "decade" || parsed.precision === "circa") {
    // The label admits it is vague; honour that even when the museum's numeric
    // fields look confident.
    lo = Math.min(structured.start, parsed.start);
    hi = Math.max(structured.end, parsed.end);
  } else if (span(parsed) - span(structured) > DISPLAY_WIDEN_LIMIT) {
    // A far wider numeric label is context, not a claim about this object.
    return structured;
  } else {
    lo = Math.min(structured.start, parsed.start);
    hi = Math.max(structured.end, parsed.end);
  }
  return { start: lo, end: hi, precision, display: label };
}

/**
 * The single year we print and measure gaps from.
 *
 * Prefer the year the museum actually wrote down, whenever its label names one
 * and that year sits inside the interval. The interval stays as wide as the
 * evidence demands -- that is what the answer is derived from -- but the number
 * a player reads is then the museum's own claim rather than our arithmetic.
 */
export function representativeYear(e: DateEstimate): number {
  const parsed = e.display ? parseDisplay(e.display) : null;
  if (parsed && parsed.precision === "year" && span(parsed) === 0) {
    if (e.start <= parsed.start && parsed.start <= e.end) return parsed.start;
  }
  return midpoint(e);
}

// --- presentation ---------------------------------------------------------

export function formatYear(year: number): string {
  return year < 0 ? `${Math.abs(year)} BC` : String(year);
}

function ordinal(n: number): string {
  const suffix =
    n % 100 >= 10 && n % 100 <= 20 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th");
  return `${n}${suffix}`;
}

export function centuryLabel(year: number): string {
  if (year < 0) return `${ordinal(Math.floor((Math.abs(year) - 1) / 100) + 1)} century BC`;
  return `${ordinal(Math.floor(year / 100) + 1)} century`;
}

/** Signed century bucket, used for the weak-period insight. */
export function centuryKey(year: number): number {
  return year >= 0 ? Math.floor(year / 100) : -(Math.floor((Math.abs(year) - 1) / 100) + 1);
}

export function describeGap(years: number, approximate: boolean): string {
  if (years <= 0) return "the same year";
  if (years === 1) return "1 year apart";
  const prefix = approximate ? "about " : "";
  if (years >= 1000) return `${prefix}${(Math.round(years / 100) * 100).toLocaleString("en-US")} years apart`;
  if (years >= 100) return `${prefix}${Math.round(years / 10) * 10} years apart`;
  return `${prefix}${years} years apart`;
}

/** A row shaped enough to date. Kept loose so both DB rows and fixtures fit. */
export interface DatedRow {
  date_display?: string | null;
  date_precision?: string | null;
  year_start?: number | null;
  year_end?: number | null;
  year_mid?: number | null;
}

/**
 * The short date shown large at the reveal.
 *
 * Derived from the museum's own label wherever that label names a year or a
 * century, so nothing we print ever claims more precision than the museum did.
 * A range stays a range: an object the Art Institute dates 1700-50 is never
 * described as being from 1725.
 */
export function headline(row: DatedRow): string {
  const parsed = parseDisplay(row.date_display ?? "");
  if (parsed && parsed.precision === "year" && span(parsed) === 0) return formatYear(parsed.start);
  if (row.date_precision === "century") return centuryLabel(row.year_mid ?? 0);
  const start = row.year_start;
  const end = row.year_end;
  if (start === null || start === undefined || end === null || end === undefined || start === end) {
    return formatYear(row.year_mid ?? 0);
  }
  return `${formatYear(start)}–${formatYear(end)}`;
}

export function isExact(row: DatedRow): boolean {
  return row.date_precision === "year" && row.year_start === row.year_end;
}

/** The museum's own label, or a range built from its dates when it gave none. */
export function displayDate(row: DatedRow): string {
  if (row.date_display) return row.date_display;
  const start = row.year_start;
  const end = row.year_end;
  if (start === null || start === undefined || end === null || end === undefined) {
    return "date unrecorded";
  }
  if (start === end) return formatYear(start);
  return `${formatYear(start)}–${formatYear(end)}`;
}
