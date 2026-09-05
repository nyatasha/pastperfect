/**
 * Service metrics: who played, what they did, and whether it worked.
 *
 * Everything here is derived from three tables the game already writes --
 * `events`, `daily_results` and `answer_log` -- so there is no third-party
 * analytics script, no cookie and nothing sent off the box. That is the whole
 * privacy position: we can count behaviour without identifying anybody, because
 * a "session" is a random string a browser made up for itself and never
 * reconciled with a person.
 *
 * Read it two ways: `npm run pp -- metrics` on the machine, or
 * `GET /api/metrics` with the operator token. Both call `collect`.
 */

import * as config from "./config.ts";
import * as daily from "./daily.ts";
import * as db from "./db.ts";

export interface DayRow {
  date: string;
  /** Distinct browsers that did anything at all. The closest honest "users". */
  sessions: number;
  /** Distinct browsers that finished a Daily Challenge. */
  players: number;
  /** Finished dailies, all editions. One browser can finish several editions. */
  completions: number;
  answers: number;
  correct: number;
}

export interface Metrics {
  generatedAt: string;
  windowDays: number;
  totals: {
    sessionsEver: number;
    completionsEver: number;
    answersEver: number;
    accuracy: number;
    objects: number;
    questions: number;
  };
  today: {
    date: string;
    puzzle: number;
    players: number;
    completions: number;
    scores: number[];
    medianScore: number | null;
  };
  days: DayRow[];
  editions: Array<{ edition: string; completions: number; players: number }>;
  events: Array<{ name: string; n: number; sessions: number }>;
  funnel: { roundStarts: number; completions: number; shares: number; zooms: number; reviews: number };
  retention: { played1: number; played2to3: number; played4plus: number; returning: number };
  hardest: Array<{ pair: string; shown: number; correct: number; rate: number }>;
}

const since = (days: number): string => daily.addDays(daily.today(), -days);

/** An event's session, when the props recorded one; "anon" otherwise. */
function eventDays(days: number): DayRow[] {
  const from = since(days);
  const rows = db.all<{ date: string; sessions: number }>(
    "SELECT substr(created_at, 1, 10) AS date, COUNT(DISTINCT session) AS sessions " +
      "FROM events WHERE substr(created_at, 1, 10) >= ? GROUP BY date",
    [from],
  );
  const players = db.all<{ date: string; players: number; completions: number }>(
    "SELECT date, COUNT(DISTINCT session) AS players, COUNT(*) AS completions " +
      "FROM daily_results WHERE date >= ? GROUP BY date",
    [from],
  );
  const answers = db.all<{ date: string; answers: number; correct: number }>(
    "SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS answers, SUM(correct) AS correct " +
      "FROM answer_log WHERE substr(created_at, 1, 10) >= ? GROUP BY date",
    [from],
  );

  const index = new Map<string, DayRow>();
  const touch = (date: string): DayRow => {
    let row = index.get(date);
    if (!row) {
      row = { date, sessions: 0, players: 0, completions: 0, answers: 0, correct: 0 };
      index.set(date, row);
    }
    return row;
  };
  for (const row of rows) touch(row.date).sessions = row.sessions;
  for (const row of players) {
    const day = touch(row.date);
    day.players = row.players;
    day.completions = row.completions;
  }
  for (const row of answers) {
    const day = touch(row.date);
    day.answers = row.answers;
    day.correct = Number(row.correct ?? 0);
  }
  return [...index.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function eventCount(name: string): number {
  return db.scalar("SELECT COUNT(*) AS n FROM events WHERE name = ?", [name]);
}

export function collect(windowDays = 30): Metrics {
  const today = daily.today();
  const todayScores = db
    .all<{ score: number }>("SELECT score FROM daily_results WHERE date = ?", [today])
    .map((row) => row.score);
  const distribution = Array.from({ length: config.DAILY_QUESTIONS + 1 }, (_, n) =>
    todayScores.filter((s) => s === n).length,
  );

  const answersEver = db.scalar("SELECT COUNT(*) AS n FROM answer_log");
  const correctEver = db.scalar("SELECT COALESCE(SUM(correct), 0) AS n FROM answer_log");

  const byPlayCount = db.all<{ played: number; sessions: number }>(
    "SELECT played, COUNT(*) AS sessions FROM " +
      "(SELECT session, COUNT(DISTINCT date) AS played FROM daily_results GROUP BY session) " +
      "GROUP BY played",
  );
  const bucket = (test: (played: number) => boolean): number =>
    byPlayCount.filter((row) => test(row.played)).reduce((sum, row) => sum + row.sessions, 0);

  return {
    generatedAt: db.nowIso(),
    windowDays,
    totals: {
      sessionsEver: db.scalar("SELECT COUNT(DISTINCT session) AS n FROM events"),
      completionsEver: db.scalar("SELECT COUNT(*) AS n FROM daily_results"),
      answersEver,
      accuracy: answersEver ? Math.round((100 * correctEver) / answersEver) : 0,
      objects: db.scalar("SELECT COUNT(*) AS n FROM objects WHERE playable = 1 AND local_image = 1"),
      questions: db.scalar("SELECT COUNT(*) AS n FROM pairs"),
    },
    today: {
      date: today,
      puzzle: daily.puzzleNumber(today),
      players: new Set(
        db.all<{ session: string }>("SELECT session FROM daily_results WHERE date = ?", [today])
          .map((row) => row.session),
      ).size,
      completions: todayScores.length,
      scores: distribution,
      medianScore: median(todayScores),
    },
    days: eventDays(windowDays),
    editions: db.all<{ edition: string; completions: number; players: number }>(
      "SELECT CASE WHEN edition = '' THEN 'mixed' ELSE edition END AS edition, " +
        "COUNT(*) AS completions, COUNT(DISTINCT session) AS players " +
        "FROM daily_results WHERE date >= ? GROUP BY edition ORDER BY completions DESC",
      [since(windowDays)],
    ),
    events: db.all<{ name: string; n: number; sessions: number }>(
      "SELECT name, COUNT(*) AS n, COUNT(DISTINCT session) AS sessions FROM events " +
        "WHERE substr(created_at, 1, 10) >= ? GROUP BY name ORDER BY n DESC",
      [since(windowDays)],
    ),
    funnel: {
      roundStarts: eventCount("round_start"),
      completions: eventCount("daily_complete"),
      shares: eventCount("share"),
      zooms: eventCount("zoom_open"),
      reviews: eventCount("review_open"),
    },
    retention: {
      played1: bucket((n) => n === 1),
      played2to3: bucket((n) => n >= 2 && n <= 3),
      played4plus: bucket((n) => n >= 4),
      returning: bucket((n) => n >= 2),
    },
    hardest: db
      .all<{ pair_id: string; shown: number; correct: number }>(
        "SELECT pair_id, shown, correct FROM pair_stats WHERE shown >= ? ORDER BY " +
          "(CAST(correct AS REAL) / shown) ASC LIMIT 10",
        [config.PERCENTILE_MIN_SAMPLE],
      )
      .map((row) => ({
        pair: row.pair_id,
        shown: row.shown,
        correct: row.correct,
        rate: Math.round((100 * row.correct) / row.shown),
      })),
  };
}

/**
 * The operator token.
 *
 * Absent means the endpoint does not exist -- it 404s rather than 403s, so an
 * unconfigured deployment does not advertise a door for somebody to knock on.
 */
export function token(): string {
  return (process.env["PASTPERFECT_METRICS_TOKEN"] ?? "").trim();
}

/** Constant-time compare, so the endpoint cannot be probed a character at a time. */
export function authorised(presented: string | null): boolean {
  const expected = token();
  if (!expected) return false;
  const given = (presented ?? "").trim();
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
