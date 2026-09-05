/**
 * Service metrics: who played, what they did, and whether it worked.
 *
 * Everything here is derived from three tables the game already writes --
 * `events`, `daily_results` and `answer_log` -- so no cookie and nothing about
 * behaviour leaves the box. That is the whole privacy position: we can count
 * behaviour without identifying anybody, because a "session" is a random string
 * a browser made up for itself and never reconciled with a person.
 *
 * Read `session` as *browser profile*, not as a visit and not as a person. It
 * is an id in localStorage that never rotates, so one human on a phone and a
 * laptop is two, and a cleared browser is a third. Every "player" and
 * "returning" figure below inherits that limit.
 *
 * The one thing this cannot see is where anybody came from, because the first
 * event only fires once a round starts. That gap is GoatCounter's job
 * (`config.GOATCOUNTER`), and the two are deliberately not joined up.
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
  /**
   * What happened inside the window -- the same window as everything else here.
   *
   * `round_start` fires for both modes, so the split comes from the event's own
   * `mode` prop rather than from a second event. A "start" is a board loading;
   * a daily "completion" is a finished set of ten. `endlessEnds` is the nearest
   * endless equivalent, but a player who wanders off mid-run never sends one,
   * so it undercounts by design.
   */
  funnel: {
    /** Boards loaded, both modes. */
    roundStarts: number;
    dailyStarts: number;
    endlessStarts: number;
    /** `daily_complete` events. Not the same as `daily_results` rows, which dedupe. */
    dailyCompletions: number;
    endlessEnds: number;
    /** Percentage of daily starts that reached the result screen. */
    completionRate: number;
    shares: number;
    zooms: number;
    reviews: number;
    /** Uncaught JavaScript errors reported by players' browsers. */
    errors: number;
  };
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

/**
 * Events of one name inside the window, optionally narrowed to one mode.
 *
 * The mode lives in the event's props blob rather than in a column, because the
 * events table is deliberately generic -- a name, a browser id and a bag. That
 * is what `json_extract` is for; the index on (name, created_at) still carries
 * the selective part of the query.
 */
function eventCount(name: string, from: string, mode?: string): number {
  // json_valid guards the rows written before props were length-checked:
  // json_extract raises on malformed text rather than returning null, and one
  // bad row would take the whole report down.
  const clause = mode
    ? " AND CASE WHEN json_valid(props) THEN json_extract(props, '$.mode') END = ?"
    : "";
  const args: unknown[] = mode ? [name, from, mode] : [name, from];
  return db.scalar(
    "SELECT COUNT(*) AS n FROM events WHERE name = ? AND substr(created_at, 1, 10) >= ?" + clause,
    args,
  );
}

function funnel(from: string): Metrics["funnel"] {
  const dailyStarts = eventCount("round_start", from, "daily");
  const dailyCompletions = eventCount("daily_complete", from);
  return {
    roundStarts: eventCount("round_start", from),
    dailyStarts,
    endlessStarts: eventCount("round_start", from, "endless"),
    dailyCompletions,
    endlessEnds: eventCount("endless_end", from),
    completionRate: dailyStarts ? Math.round((100 * dailyCompletions) / dailyStarts) : 0,
    shares: eventCount("share", from),
    zooms: eventCount("zoom_open", from),
    reviews: eventCount("review_open", from),
    errors: eventCount("client_error", from),
  };
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
    funnel: funnel(since(windowDays)),
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
