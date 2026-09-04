/**
 * Building the Daily Challenge.
 *
 * Everybody gets the same ten questions on the same day, so the set has to be a
 * stored artefact rather than something regenerated per request. It is derived
 * from a seed made of the date, which keeps regeneration reproducible, and then
 * written to the database, which keeps it stable even if the pair pool changes
 * underneath it.
 */

import * as config from "./config.ts";
import * as db from "./db.ts";
import { choice, rngFor, shuffle } from "./rng.ts";

/** The edition key for the all-museums daily. */
export const MIXED = "";

const DAY_MS = 86_400_000;

/**
 * The canonical puzzle day, in UTC.
 *
 * Deliberately UTC: the puzzle number in a shared result has to mean the same
 * thing to the person who receives it as to the person who sent it.
 */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const asUtc = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);

export function addDays(iso: string, days: number): string {
  return new Date(asUtc(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

export function puzzleNumber(day: string): number {
  return Math.round((asUtc(day) - asUtc(config.EPOCH_DATE)) / DAY_MS) + 1;
}

/** A valid ISO date, or null. Rejects "2026-13-45" as well as rubbish. */
export function parseDate(text: string | null | undefined): string | null {
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const stamp = Date.parse(`${text}T00:00:00Z`);
  if (Number.isNaN(stamp)) return null;
  return new Date(stamp).toISOString().slice(0, 10) === text ? text : null;
}

/** Past puzzles stay closed in v0; the archive is a paid feature later. */
export function archiveOpen(): boolean {
  return process.env.PASTPERFECT_ALLOW_ARCHIVE === "1";
}

export function playableDay(day: string): boolean {
  const now = today();
  return day === now || (archiveOpen() && day <= now);
}

interface PoolRow {
  id: string;
  difficulty: number;
  left_id: string;
  right_id: string;
  left_museum: string;
  right_museum: string;
}

function pool(edition: string): PoolRow[] {
  const base =
    "SELECT p.id, p.difficulty, p.left_id, p.right_id, " +
    "       l.museum AS left_museum, r.museum AS right_museum " +
    "FROM pairs p " +
    "JOIN objects l ON l.id = p.left_id " +
    "JOIN objects r ON r.id = p.right_id";
  if (edition !== MIXED) {
    return db.all<PoolRow>(`${base} WHERE l.museum = ? AND r.museum = ?`, [edition, edition]);
  }
  return db.all<PoolRow>(base);
}

/** Objects used in this edition within the cooldown window. */
function recentObjects(day: string, edition: string): Set<string> {
  const since = addDays(day, -config.DAILY_COOLDOWN_DAYS);
  const rows = db.all<{ left_id: string; right_id: string }>(
    "SELECT p.left_id, p.right_id FROM daily_sets d JOIN pairs p ON p.id = d.pair_id " +
      "WHERE d.edition = ? AND d.date >= ? AND d.date < ?",
    [edition, since, day],
  );
  const used = new Set<string>();
  for (const row of rows) {
    used.add(row.left_id);
    used.add(row.right_id);
  }
  return used;
}

function nearby(target: number): number[] {
  const order = [target];
  for (const step of [1, 2, 3, 4]) {
    for (const level of [target - step, target + step]) {
      if (level >= 1 && level <= 5 && !order.includes(level)) order.push(level);
    }
  }
  return order;
}

export type DailyRow = [date: string, edition: string, position: number, pairId: string, flipped: number];

/** Pick the day's questions. Returns rows ready for insertion. */
export function buildDay(day: string, edition: string = MIXED, given?: PoolRow[]): DailyRow[] {
  const available = given ?? pool(edition);
  if (available.length < config.DAILY_QUESTIONS) return [];

  const rng = rngFor(`past-perfect-daily-v1:${edition}:${day}`);
  const cooling = recentObjects(day, edition);
  const byDifficulty = new Map<number, PoolRow[]>();
  for (const pair of available) {
    const bucket = byDifficulty.get(pair.difficulty);
    if (bucket) bucket.push(pair);
    else byDifficulty.set(pair.difficulty, [pair]);
  }
  for (const bucket of byDifficulty.values()) shuffle(bucket, rng);

  const usedObjects = new Set<string>();
  const seenMuseums = new Set<string>();
  const rows: DailyRow[] = [];

  const curve = config.DAILY_DIFFICULTY_CURVE.slice(0, config.DAILY_QUESTIONS);
  for (const [position, target] of curve.entries()) {
    let chosen: PoolRow | null = null;
    // Walk outwards from the intended difficulty rather than failing: a thin
    // pool should soften the curve, not leave a hole in the puzzle.
    for (const level of nearby(target)) {
      let options = (byDifficulty.get(level) ?? []).filter(
        (pair) => !usedObjects.has(pair.left_id) && !usedObjects.has(pair.right_id),
      );
      const fresh = options.filter(
        (pair) => !cooling.has(pair.left_id) && !cooling.has(pair.right_id),
      );
      options = fresh.length > 0 ? fresh : options;
      if (options.length === 0) continue;
      if (edition === MIXED && seenMuseums.size < config.MUSEUM_ORDER.length) {
        const widening = options.filter(
          (pair) => !seenMuseums.has(pair.left_museum) || !seenMuseums.has(pair.right_museum),
        );
        options = widening.length > 0 ? widening : options;
      }
      chosen = choice(options, rng);
      break;
    }
    if (!chosen) break;
    usedObjects.add(chosen.left_id).add(chosen.right_id);
    seenMuseums.add(chosen.left_museum).add(chosen.right_museum);
    rows.push([day, edition, position, chosen.id, rng() < 0.5 ? 1 : 0]);
  }

  return rows;
}

/** Precompute daily sets for a window of days, for every edition. */
export function ensure(
  days = 45,
  start?: string,
  editions?: string[],
  log: (line: string) => void = console.log,
): number {
  db.init();
  const first = start ?? addDays(today(), -2);
  const list = editions ?? [MIXED, ...config.MUSEUM_ORDER];
  let written = 0;

  for (const edition of list) {
    const available = pool(edition);
    if (available.length < config.DAILY_QUESTIONS) {
      log(`  ${(edition || "mixed").padEnd(14)} skipped — only ${available.length} pairs available`);
      continue;
    }
    let made = 0;
    for (let offset = 0; offset < days; offset++) {
      const day = addDays(first, offset);
      const existing = db.scalar(
        "SELECT COUNT(*) AS n FROM daily_sets WHERE date = ? AND edition = ?",
        [day, edition],
      );
      if (existing >= config.DAILY_QUESTIONS) continue;
      const rows = buildDay(day, edition, available);
      if (rows.length === 0) continue;
      db.transaction((conn) => {
        conn.prepare("DELETE FROM daily_sets WHERE date = ? AND edition = ?").run(day, edition);
        const insert = conn.prepare(
          "INSERT INTO daily_sets (date, edition, position, pair_id, flipped) VALUES (?,?,?,?,?)",
        );
        for (const row of rows) insert.run(...db.params(row));
      });
      made += 1;
      written += rows.length;
    }
    log(`  ${(edition || "mixed").padEnd(14)} ${made} days generated`);
  }
  return written;
}

export interface DailyQuestion {
  position: number;
  flipped: number;
  id: string;
  pair_id: string;
  left_id: string;
  right_id: string;
  earlier: string;
  guaranteed_gap: number;
  display_gap: number;
  approximate: number;
  difficulty: number;
  surprise: number;
  insight: string;
  museums: string;
}

/** The stored questions for a day, joined to everything the reveal needs. */
export function questions(day: string, edition: string = MIXED): DailyQuestion[] {
  return db.all<DailyQuestion>(
    "SELECT d.position, d.flipped, p.*, p.id AS pair_id FROM daily_sets d " +
      "JOIN pairs p ON p.id = d.pair_id " +
      "WHERE d.date = ? AND d.edition = ? ORDER BY d.position",
    [day, edition],
  );
}

export function availableDays(edition: string = MIXED): string[] {
  return db
    .all<{ date: string }>(
      "SELECT DISTINCT date FROM daily_sets WHERE edition = ? ORDER BY date",
      [edition],
    )
    .map((row) => row.date);
}
