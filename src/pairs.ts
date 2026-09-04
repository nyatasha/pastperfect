/**
 * Precomputing the question pool.
 *
 * A pair is only a question if its answer is provable. That means the two date
 * intervals must not overlap: whatever the true date of each object is inside
 * its range, one is unambiguously earlier. Overlapping ranges are not "close
 * calls", they are unanswerable, and the game never asks them.
 */

import { createHash } from "node:crypto";

import * as config from "./config.ts";
import * as db from "./db.ts";
import * as insights from "./insights.ts";
import { makeRng, shuffle, type Rng } from "./rng.ts";

/**
 * Buckets on the *provable* gap. Sampling a few partners from each bucket for
 * every object is what gives the pool a full difficulty range instead of a heap
 * of easy thousand-year questions.
 */
export const GAP_BUCKETS: ReadonlyArray<readonly [number, number]> = [
  [1, 15], [15, 40], [40, 100], [100, 200], [200, 500], [500, 10_000],
];
export const PER_BUCKET = 4;

const OBJECT_FIELDS =
  "id, museum, title, artist, year_start, year_end, year_mid, date_precision, " +
  "medium, classification, region, looks_modern";

export interface PairObject extends insights.InsightRow {
  id: string;
  museum: string;
  title: string;
  year_start: number;
  year_end: number;
  year_mid: number;
  date_precision: string;
  region: string;
  looks_modern: number;
}

export function pairId(left: string, right: string): string {
  return createHash("sha1").update(`${left}|${right}`).digest("hex").slice(0, 16);
}

function normaliseTitle(title: string): string {
  let text = (title ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ");
  text = text.replace(/\b(plate|pl|no|number|fig|figure|vol|volume|part|pt)\b\.?\s*\d+/g, " ");
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/** Reject near-duplicates -- two plates from one series make a poor question. */
export function tooSimilar(
  a: { artist?: string | null; title: string },
  b: { artist?: string | null; title: string },
): boolean {
  if (a.artist && a.artist === b.artist) {
    const ta = normaliseTitle(a.title);
    const tb = normaliseTitle(b.title);
    if (ta && tb && (ta === tb || ta.startsWith(tb) || tb.startsWith(ta))) return true;
  }
  return false;
}

/** Smallest possible number of years between them, or 0 if ranges overlap. */
export function guaranteedGap(
  a: { year_start: number; year_end: number },
  b: { year_start: number; year_end: number },
): number {
  if (a.year_end < b.year_start) return b.year_start - a.year_end;
  if (b.year_end < a.year_start) return a.year_start - b.year_end;
  return 0;
}

/** Score 1 (gentle) to 5 (cruel), plus whether the pair is visually deceptive. */
export function difficultyFor(
  earlier: { region: string; looks_modern: number | boolean },
  later: { region: string; looks_modern: number | boolean },
  gap: number,
): { difficulty: number; surprise: boolean } {
  let score: number;
  if (gap >= 300) score = 1;
  else if (gap >= 150) score = 2;
  else if (gap >= 60) score = 3;
  else if (gap >= 20) score = 4;
  else score = 5;

  const surprise = Boolean(earlier.looks_modern) && !later.looks_modern;
  if (surprise) {
    // The visual cue points the wrong way, which is the whole trick.
    score += 1;
  } else if (Boolean(later.looks_modern) && !earlier.looks_modern) {
    // The cue points the right way, so the question gets easier.
    score -= 1;
  }

  const regions = new Set([earlier.region, later.region]);
  if (!regions.has("Unknown") && regions.size === 2) {
    // Most players hold one mental timeline. Crossing regions breaks it.
    score += 1;
  }

  return { difficulty: Math.max(1, Math.min(5, score)), surprise };
}

/** Partners for `subject`, spread across the gap buckets. */
function candidates(rows: PairObject[], subject: PairObject, rng: Rng): PairObject[] {
  const chosen: PairObject[] = [];
  for (const [low, high] of GAP_BUCKETS) {
    const bucket = rows.filter((other) => {
      if (other.id === subject.id) return false;
      const gap = guaranteedGap(subject, other);
      return gap >= low && gap < high;
    });
    if (bucket.length === 0) continue;
    shuffle(bucket, rng);
    chosen.push(...bucket.slice(0, PER_BUCKET));
  }
  return chosen;
}

export function build(seed = 11, log: (line: string) => void = console.log): number {
  db.init();
  const rows = db.all<PairObject>(
    `SELECT ${OBJECT_FIELDS} FROM objects ` +
      "WHERE playable = 1 AND local_image = 1 ORDER BY year_mid, id",
  );
  log(`  ${rows.length} playable objects with images`);
  if (rows.length < 2) return 0;

  const rng = makeRng(seed);
  const now = db.nowIso();
  const seen = new Set<string>();
  const records: unknown[][] = [];

  for (const subject of rows) {
    for (const other of candidates(rows, subject, rng)) {
      if (tooSimilar(subject, other)) continue;
      const [left, right] = subject.id < other.id ? [subject, other] : [other, subject];
      const key = pairId(left.id, right.id);
      if (seen.has(key)) continue;
      const gap = guaranteedGap(left, right);
      if (gap < config.MIN_PAIR_GAP_YEARS) continue;

      const earlierSide = left.year_end < right.year_start ? "left" : "right";
      const earlier = earlierSide === "left" ? left : right;
      const later = earlierSide === "left" ? right : left;

      const approximate = earlier.date_precision !== "year" || later.date_precision !== "year";
      const displayGap = Math.abs(later.year_mid - earlier.year_mid);
      const { difficulty, surprise } = difficultyFor(earlier, later, gap);

      seen.add(key);
      records.push([
        key, left.id, right.id, earlierSide, gap, displayGap,
        approximate ? 1 : 0, difficulty, surprise ? 1 : 0,
        insights.forPair(earlier, later, displayGap, approximate),
        [...new Set([left.museum, right.museum])].sort().join("|"),
        now,
      ]);
    }
  }

  db.transaction((conn) => {
    conn.exec("DELETE FROM daily_sets");
    conn.exec("DELETE FROM pair_stats");
    conn.exec("DELETE FROM pairs");
    const insert = conn.prepare(
      "INSERT INTO pairs (id, left_id, right_id, earlier, guaranteed_gap, " +
        "display_gap, approximate, difficulty, surprise, insight, museums, " +
        "created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const record of records) insert.run(...db.params(record));
  });
  db.setMeta("last_pair_build", now);
  log(`  ${records.length} pairs built`);
  return records.length;
}

export interface DifficultyRow {
  difficulty: number;
  n: number;
  surprising: number;
  min_gap: number;
  max_gap: number;
}

export function distribution(): DifficultyRow[] {
  return db.all<DifficultyRow>(
    "SELECT difficulty, COUNT(*) AS n, SUM(surprise) AS surprising, " +
      "MIN(guaranteed_gap) AS min_gap, MAX(guaranteed_gap) AS max_gap " +
      "FROM pairs GROUP BY difficulty ORDER BY difficulty",
  );
}
