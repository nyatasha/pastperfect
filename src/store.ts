/** Read and write queries shared by the pages and the JSON API. */

import * as config from "./config.ts";
import * as daily from "./daily.ts";
import * as db from "./db.ts";
import { rngFor, shuffle } from "./rng.ts";

/** Everything the reveal is allowed to say about an object. */
export const REVEAL_FIELDS =
  "id, museum, title, artist, artist_note, date_display, year_start, year_end, " +
  "year_mid, date_precision, medium, classification, culture, credit_line, " +
  "object_url, image_key, image_w, image_h, license_label, license_url, license_id";

export interface ObjectRow {
  id: string;
  museum: string;
  title: string;
  artist: string | null;
  artist_note: string | null;
  date_display: string;
  year_start: number;
  year_end: number;
  year_mid: number;
  date_precision: string;
  medium: string | null;
  classification: string | null;
  culture: string | null;
  credit_line: string | null;
  object_url: string;
  image_key: string;
  image_w: number | null;
  image_h: number | null;
  license_label: string;
  license_url: string;
  license_id: string;
}

export interface PairRow {
  id: string;
  left_id: string;
  right_id: string;
  earlier: "left" | "right";
  guaranteed_gap: number;
  display_gap: number;
  approximate: number;
  difficulty: number;
  surprise: number;
  insight: string;
  museums: string;
  created_at: string;
}

/** An object is in play only when its rights, its date and its image all pass. */
export const IN_PLAY = "playable = 1 AND local_image = 1";

// --- collection ----------------------------------------------------------

export interface OverallStats {
  objects: number;
  earliest: number | null;
  latest: number | null;
  pairs: number;
  museums: number;
}

export function overallStats(): OverallStats {
  const row = db.get<{ objects: number; earliest: number | null; latest: number | null }>(
    `SELECT COUNT(*) AS objects, MIN(year_start) AS earliest, MAX(year_end) AS latest ` +
      `FROM objects WHERE ${IN_PLAY}`,
  );
  return {
    objects: row?.objects ?? 0,
    earliest: row?.earliest ?? null,
    latest: row?.latest ?? null,
    pairs: db.scalar("SELECT COUNT(*) AS n FROM pairs"),
    museums: config.MUSEUM_ORDER.length,
  };
}

export interface MuseumStats {
  objects: number;
  earliest: number | null;
  latest: number | null;
  licences: Array<{ label: string; url: string; n: number }>;
  forms: Array<{ label: string; n: number }>;
  own_pairs: number;
  excluded: Record<string, number>;
}

export function museumStats(slug: string): MuseumStats {
  const row = db.get<{ objects: number; earliest: number | null; latest: number | null }>(
    `SELECT COUNT(*) AS objects, MIN(year_start) AS earliest, MAX(year_end) AS latest ` +
      `FROM objects WHERE museum = ? AND ${IN_PLAY}`,
    [slug],
  );
  const licences = db.all<{ label: string; url: string; n: number }>(
    `SELECT license_label AS label, license_url AS url, COUNT(*) AS n FROM objects ` +
      `WHERE museum = ? AND ${IN_PLAY} GROUP BY license_label, license_url ORDER BY n DESC`,
    [slug],
  );
  const forms = db.all<{ label: string; n: number }>(
    `SELECT COALESCE(NULLIF(classification, ''), 'Other') AS label, COUNT(*) AS n ` +
      `FROM objects WHERE museum = ? AND ${IN_PLAY} GROUP BY label ORDER BY n DESC LIMIT 6`,
    [slug],
  );
  const report = db.getMeta<Record<string, { excluded?: Record<string, number> }>>(
    "ingest_report",
    {},
  );
  return {
    objects: row?.objects ?? 0,
    earliest: row?.earliest ?? null,
    latest: row?.latest ?? null,
    licences,
    forms,
    own_pairs: db.scalar("SELECT COUNT(*) AS n FROM pairs WHERE museums = ?", [slug]),
    excluded: report[slug]?.excluded ?? {},
  };
}

/** Objects appearing in a daily set near today, which must not be shown off-game. */
function spoilerObjectIds(): Set<string> {
  const today = daily.today();
  const window = config.FEATURE_SPOILER_WINDOW_DAYS;
  const rows = db.all<{ left_id: string; right_id: string }>(
    "SELECT p.left_id, p.right_id FROM daily_sets d JOIN pairs p ON p.id = d.pair_id " +
      "WHERE d.date BETWEEN ? AND ?",
    [daily.addDays(today, -window), daily.addDays(today, window)],
  );
  const out = new Set<string>();
  for (const row of rows) {
    out.add(row.left_id);
    out.add(row.right_id);
  }
  return out;
}

/**
 * A stable daily selection to illustrate a page.
 *
 * Anything scheduled in a nearby daily set is held back: a museum page that
 * quietly shows you today's answer would be a bad museum page.
 */
export function featuredObjects(museum: string | null = null, limit = 8): ObjectRow[] {
  const sql = `SELECT ${REVEAL_FIELDS} FROM objects WHERE ${IN_PLAY}` +
    (museum ? " AND museum = ?" : "") + " ORDER BY id";
  let rows = db.all<ObjectRow>(sql, museum ? [museum] : []);
  const blocked = spoilerObjectIds();
  const fresh = rows.filter((row) => !blocked.has(row.id));
  rows = fresh.length > 0 ? fresh : rows;

  const rng = rngFor(`${daily.today()}:${museum ?? "all"}`);
  shuffle(rows, rng);
  if (museum) return rows.slice(0, limit);

  // Spread the strip across the launch mix rather than whichever museum
  // happens to sort first.
  const byMuseum = new Map<string, ObjectRow[]>();
  for (const row of rows) {
    const bucket = byMuseum.get(row.museum);
    if (bucket) bucket.push(row);
    else byMuseum.set(row.museum, [row]);
  }
  const picked: ObjectRow[] = [];
  while (picked.length < limit && [...byMuseum.values()].some((b) => b.length > 0)) {
    let progressed = false;
    for (const slug of config.MUSEUM_ORDER) {
      const bucket = byMuseum.get(slug);
      if (bucket && bucket.length > 0 && picked.length < limit) {
        picked.push(bucket.pop()!);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return picked;
}

export function objectsByIds(ids: readonly string[]): Map<string, ObjectRow> {
  if (ids.length === 0) return new Map();
  const marks = ids.map(() => "?").join(",");
  const rows = db.all<ObjectRow>(
    `SELECT ${REVEAL_FIELDS} FROM objects WHERE id IN (${marks})`,
    [...ids],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

export function pair(pairId: string): PairRow | undefined {
  return db.get<PairRow>("SELECT * FROM pairs WHERE id = ?", [pairId]);
}

// --- endless -------------------------------------------------------------

/**
 * A deterministic, never-repeating walk through the pair pool.
 *
 * The client holds only a seed and a page number, so there is no server-side
 * session to keep and no growing list of "already seen" ids to send up.
 */
export function endlessPage(
  seed: string,
  museum: string | null,
  page: number,
  size: number,
): Array<{ id: string; difficulty: number }> {
  const rows = museum
    ? db.all<{ id: string; difficulty: number }>(
        "SELECT p.id, p.difficulty FROM pairs p " +
          "JOIN objects l ON l.id = p.left_id JOIN objects r ON r.id = p.right_id " +
          "WHERE l.museum = ? AND r.museum = ? ORDER BY p.id",
        [museum, museum],
      )
    : db.all<{ id: string; difficulty: number }>("SELECT id, difficulty FROM pairs ORDER BY id");
  if (rows.length === 0) return [];

  const rng = rngFor(seed);
  // Endless opens gently and stays mixed, so order by difficulty band first and
  // shuffle inside each band.
  const banded = new Map<number, Array<{ id: string; difficulty: number }>>();
  for (const item of rows) {
    const bucket = banded.get(item.difficulty);
    if (bucket) bucket.push(item);
    else banded.set(item.difficulty, [item]);
  }
  for (const bucket of banded.values()) shuffle(bucket, rng);

  const ordered: Array<{ id: string; difficulty: number }> = [];
  const cursor = new Map<number, number>();
  for (const level of banded.keys()) cursor.set(level, 0);
  const rotation = [1, 2, 3, 2, 4, 3, 5, 4, 2, 5, 3, 4];
  while ([...banded.keys()].some((level) => cursor.get(level)! < banded.get(level)!.length)) {
    let progressed = false;
    for (const level of rotation) {
      const bucket = banded.get(level);
      if (!bucket) continue;
      const index = cursor.get(level) ?? 0;
      if (index < bucket.length) {
        ordered.push(bucket[index]!);
        cursor.set(level, index + 1);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return ordered.slice(page * size, page * size + size);
}

// --- play records --------------------------------------------------------

/** Count a session's first answer to a pair, and only its first. */
export function recordAnswer(session: string, pairId: string, correct: boolean): void {
  if (!session) return;
  db.transaction((conn) => {
    const result = conn
      .prepare(
        "INSERT OR IGNORE INTO answer_log (session, pair_id, correct, created_at) VALUES (?,?,?,?)",
      )
      .run(session, pairId, correct ? 1 : 0, db.nowIso());
    if (Number(result.changes) > 0) {
      conn
        .prepare(
          "INSERT INTO pair_stats (pair_id, shown, correct) VALUES (?, 1, ?) " +
            "ON CONFLICT(pair_id) DO UPDATE SET shown = shown + 1, correct = correct + excluded.correct",
        )
        .run(pairId, correct ? 1 : 0);
    }
  });
}

/** Share of players who answered this pair correctly, once it means anything. */
export function pairSuccess(pairId: string): number | null {
  const row = db.get<{ shown: number; correct: number }>(
    "SELECT shown, correct FROM pair_stats WHERE pair_id = ?",
    [pairId],
  );
  if (!row || row.shown < config.PERCENTILE_MIN_SAMPLE) return null;
  return Math.round((100 * row.correct) / row.shown);
}

/**
 * The day's shape, as the server sees it.
 *
 * `players` and `distribution` never leave the server: they are here for
 * `/api/metrics` and for computing `beat`. What a player is told is `beat`.
 */
export interface Standing {
  players: number;
  percentile: number | null;
  /** Share of players this score is strictly better than, once ranked. */
  beat: number | null;
  distribution: number[];
}

export function dailyStanding(date: string, edition: string, score: number): Standing {
  const scores = db
    .all<{ score: number }>("SELECT score FROM daily_results WHERE date = ? AND edition = ?", [
      date,
      edition,
    ])
    .map((row) => row.score);
  const players = scores.length;
  const distribution = Array.from({ length: config.DAILY_QUESTIONS + 1 }, (_, n) =>
    scores.filter((s) => s === n).length,
  );
  let percentile: number | null = null;
  let beat: number | null = null;
  if (players >= config.PERCENTILE_MIN_SAMPLE) {
    percentile = Math.round((100 * scores.filter((s) => s <= score).length) / players);
    // Strictly better, so "you did better than 60%" survives being read closely
    // by somebody who tied with half the field.
    beat = Math.round((100 * scores.filter((s) => s < score).length) / players);
  }
  return { players, percentile, beat, distribution };
}

export function recordDaily(
  session: string,
  date: string,
  edition: string,
  score: number,
): Standing {
  if (session) {
    db.run(
      "INSERT OR IGNORE INTO daily_results (date, edition, session, score, created_at) VALUES (?,?,?,?,?)",
      [date, edition, session, score, db.nowIso()],
    );
  }
  return dailyStanding(date, edition, score);
}

/**
 * First-party, cookieless analytics.
 *
 * The PRD asks for analytics, not for surveillance: this stores an event name,
 * the browser's own random session id and a small bag of properties. No IP
 * address is written, and nothing here can be joined back to a person.
 */
export function logEvent(name: string, session: string, props: unknown): void {
  if (!name || name.length > 64) return;
  // Truncating JSON would leave a row that parses as nothing, and the metrics
  // queries read `mode` out of this blob. An oversized bag is dropped whole
  // instead, so every stored row is valid JSON.
  const encoded = JSON.stringify(props ?? {});
  const payload = encoded.length > 1000 ? '{"oversized":true}' : encoded;
  db.run("INSERT INTO events (name, session, props, created_at) VALUES (?,?,?,?)", [
    name.slice(0, 64),
    (session || "anon").slice(0, 64),
    payload,
    db.nowIso(),
  ]);
}

export function eventSummary(days = 7): Array<{ name: string; n: number; sessions: number }> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  return db.all(
    "SELECT name, COUNT(*) AS n, COUNT(DISTINCT session) AS sessions FROM events " +
      "WHERE created_at >= ? GROUP BY name ORDER BY n DESC",
    [since],
  );
}
