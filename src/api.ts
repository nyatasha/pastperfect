/**
 * The JSON API the game client talks to.
 *
 * Two rules shape this module.
 *
 * First, a question payload contains no title, no maker and no date -- two
 * opaque image URLs, the form of each object and the museum that holds it, and
 * nothing more. Everything that would give the answer away arrives after the
 * player commits, from POST /api/answer. That rule is no longer a convention:
 * `QuestionSide` in contract.ts cannot hold those fields, so a leak fails to
 * compile rather than failing in production.
 *
 * Second, the answer itself is computed here from stored date intervals. There
 * is no model in this path, and there is no network call in this path.
 */

import type {
  ChallengeRound, DailyRound, EndlessRound, Question, QuestionSide, Reveal,
  RevealSide, Standing,
} from "./contract.ts";
import * as config from "./config.ts";
import * as daily from "./daily.ts";
import * as dates from "./dates.ts";
import * as db from "./db.ts";
import * as store from "./store.ts";
import * as taxonomy from "./taxonomy.ts";

export const QID = /^([0-9a-f]{16})\.([01])$/;
export const SESSION = /^[A-Za-z0-9_-]{6,64}$/;
/**
 * A sanity bound on the page number, not a length for the game.
 *
 * It used to be 400, which is 3,200 questions -- fewer than the pool holds --
 * and the request was clamped to it, so a long enough run stopped advancing and
 * served the same eight questions for ever. The pool's own end is the end now;
 * this only stops an absurd offset.
 */
export const MAX_ENDLESS_PAGE = 100_000;
export const ENDLESS_PAGE_SIZE = 8;

export function safeSession(value: unknown): string {
  const text = String(value ?? "");
  return SESSION.test(text) ? text : "";
}

/**
 * What a player may see *before* answering.
 *
 * The single place a QuestionSide is built. Its return type is the contract, so
 * adding anything that dates the object is a type error at this line rather
 * than a spoiler in production.
 *
 * `form` and `museum` are the exception the contract documents: knowing you are
 * comparing a photograph in London with a chair in Amsterdam tells you what to
 * look at, and tells you nothing about when either was made.
 */
function questionSide(row: store.ObjectRow): QuestionSide {
  return {
    img: `/img/${row.image_key}.jpg`,
    w: row.image_w,
    h: row.image_h,
    form: taxonomy.displayForm(row.medium, row.classification, row.title),
    museum: row.museum,
  };
}

/** What a player may see *after* answering. */
function revealSide(row: store.ObjectRow): RevealSide {
  const museum = config.MUSEUMS[row.museum];
  return {
    title: row.title,
    artist: row.artist,
    artistNote: row.artist_note,
    date: dates.displayDate(row),
    year: row.year_mid,
    yearText: dates.headline(row),
    approximate: row.date_precision !== "year",
    century: dates.centuryLabel(row.year_mid),
    medium: row.medium,
    museum: row.museum,
    museumName: museum?.shortName ?? row.museum,
    museumPath: `/museum/${row.museum}`,
    credit: row.credit_line,
    objectUrl: row.object_url,
    licence: row.license_label,
    licenceUrl: row.license_url,
  };
}

interface PairLike {
  id: string;
  left_id: string;
  right_id: string;
  flipped?: number;
}

/** Turn stored pairs into spoiler-free questions. */
function toQuestions(rows: readonly PairLike[]): Question[] {
  const ids = rows.flatMap((row) => [row.left_id, row.right_id]);
  const objects = store.objectsByIds(ids);
  const out: Question[] = [];
  for (const [index, row] of rows.entries()) {
    const left = objects.get(row.left_id);
    const right = objects.get(row.right_id);
    if (!left || !right) continue;
    const flipped = Boolean(row.flipped);
    const [first, second] = flipped ? [right, left] : [left, right];
    out.push({
      id: `${row.id}.${flipped ? 1 : 0}`,
      n: index + 1,
      a: questionSide(first),
      b: questionSide(second),
    });
  }
  return out;
}

export type ApiResult =
  | { status: number; body: unknown }
  | { status: 204; body: null };

export function dailyRound(query: URLSearchParams): ApiResult {
  const edition = query.get("edition") ?? daily.MIXED;
  if (edition && !(edition in config.MUSEUMS)) {
    return { status: 404, body: { error: "unknown edition" } };
  }
  const day = daily.parseDate(query.get("date")) ?? daily.today();
  if (!daily.playableDay(day)) {
    return {
      status: 410,
      body: { error: "closed", message: "That puzzle has closed.", today: daily.today() },
    };
  }
  // Builds the day if the precomputed batch has run out, so the daily never
  // simply stops.
  const rows = daily.ensureDay(day, edition);
  if (rows.length === 0) return { status: 503, body: { error: "not ready" } };

  const payload: DailyRound = {
    mode: "daily",
    edition,
    date: day,
    puzzle: daily.puzzleNumber(day),
    total: rows.length,
    questions: toQuestions(rows.map((row) => ({ ...row, id: row.pair_id }))),
  };
  return { status: 200, body: payload };
}

export function endlessRound(query: URLSearchParams): ApiResult {
  const museum = query.get("museum") || null;
  if (museum && !(museum in config.MUSEUMS)) {
    return { status: 404, body: { error: "unknown museum" } };
  }
  const seed = safeSession(query.get("seed")) || "anonymous-seed";
  const raw = Number(query.get("page") ?? 0);
  const page = Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;

  // Beyond the bound the pool counts as finished. Clamping instead would hand
  // back the last page again, which reads to a player as the run looping.
  const picks =
    page > MAX_ENDLESS_PAGE ? [] : store.endlessPage(seed, museum, page, ENDLESS_PAGE_SIZE);
  if (picks.length === 0) {
    const empty: EndlessRound = { mode: "endless", museum: museum ?? "", page, questions: [], exhausted: true };
    return { status: 200, body: empty };
  }

  const rows: PairLike[] = [];
  for (const [offset, pick] of picks.entries()) {
    const row = store.pair(pick.id);
    if (row) rows.push({ ...row, flipped: (page * ENDLESS_PAGE_SIZE + offset + seed.length) % 2 });
  }
  const payload: EndlessRound = {
    mode: "endless",
    museum: museum ?? "",
    page,
    questions: toQuestions(rows),
    adAfterRounds: config.ENDLESS_AD_AFTER_ROUNDS,
  };
  return { status: 200, body: payload };
}

/**
 * One question, addressed by its own id.
 *
 * A challenge link carries nothing but the question id the board and the answer
 * endpoint already speak: sixteen hex characters naming the pair, and one bit
 * saying which way round it is shown. So resolving a challenge is a lookup on
 * the existing pool, and the payload it produces is the same `Question` the
 * daily and endless rounds produce -- built by the same `toQuestions`, and so
 * subject to the same `QuestionSide` contract.
 *
 * Returns null for anything that is not a live pair: a malformed id, an id for
 * a pair that no longer exists, or a pair whose objects have gone. All three
 * are one answer on purpose, so a link cannot be used to ask whether one
 * particular object is still in the collection.
 */
export function challengeQuestion(id: unknown): Question | null {
  const match = QID.exec(String(id ?? ""));
  if (!match) return null;
  const row = store.pair(match[1]!);
  if (!row) return null;
  // toQuestions drops a pair whose objects have gone, so an empty result is
  // "no longer available" rather than a half-built question.
  return toQuestions([{ ...row, flipped: match[2] === "1" ? 1 : 0 }])[0] ?? null;
}

export function challengeRound(query: URLSearchParams): ApiResult {
  const question = challengeQuestion(query.get("q"));
  if (!question) return { status: 404, body: { error: "unknown challenge" } };
  const payload: ChallengeRound = { mode: "challenge", questions: [question] };
  return { status: 200, body: payload };
}

export function round(query: URLSearchParams): ApiResult {
  const mode = query.get("mode");
  if (mode === "endless") return endlessRound(query);
  if (mode === "challenge") return challengeRound(query);
  return dailyRound(query);
}

export function answer(payload: Record<string, unknown>): ApiResult {
  const match = QID.exec(String(payload["q"] ?? ""));
  const choice = payload["choice"];
  if (!match || (choice !== "a" && choice !== "b")) {
    return { status: 400, body: { error: "bad request" } };
  }

  const pairId = match[1]!;
  const flipped = match[2] === "1";
  const row = store.pair(pairId);
  if (!row) return { status: 404, body: { error: "unknown question" } };

  const objects = store.objectsByIds([row.left_id, row.right_id]);
  const left = objects.get(row.left_id);
  const right = objects.get(row.right_id);
  if (!left || !right) return { status: 404, body: { error: "unknown question" } };

  // The answer is a comparison of two stored intervals that provably do not
  // overlap. Nothing else feeds into it.
  const [first, second] = flipped ? [right, left] : [left, right];
  const earlierRow = row.earlier === "left" ? left : right;
  const earlierSide: "a" | "b" = earlierRow === first ? "a" : "b";
  const correct = choice === earlierSide;

  store.recordAnswer(safeSession(payload["session"]), pairId, correct);

  const reveal: Reveal = {
    correct,
    earlier: earlierSide,
    gap: row.display_gap,
    gapText: dates.describeGap(row.display_gap, Boolean(row.approximate)),
    approximate: Boolean(row.approximate),
    insight: row.insight,
    surprise: Boolean(row.surprise),
    difficulty: row.difficulty,
    successRate: store.pairSuccess(pairId),
    a: revealSide(first),
    b: revealSide(second),
  };
  return { status: 200, body: reveal };
}

export function complete(payload: Record<string, unknown>): ApiResult {
  const day = daily.parseDate(String(payload["date"] ?? ""));
  const edition = String(payload["edition"] ?? "");
  if (!day || (edition && !(edition in config.MUSEUMS))) {
    return { status: 400, body: { error: "bad request" } };
  }
  const rawScore = payload["score"];
  if (typeof rawScore !== "number" || !Number.isInteger(rawScore)) {
    return { status: 400, body: { error: "bad request" } };
  }
  if (rawScore < 0 || rawScore > config.DAILY_QUESTIONS) {
    return { status: 400, body: { error: "bad request" } };
  }

  const standing = store.recordDaily(safeSession(payload["session"]), day, edition, rawScore);
  // `standing` also carries the player count and the full distribution. Neither
  // is copied into the response: see the note on Standing in contract.ts.
  const body: Standing = {
    date: day,
    puzzle: daily.puzzleNumber(day),
    score: rawScore,
    beat: standing.beat,
    ranked: standing.beat !== null,
  };
  return { status: 200, body };
}

export function events(payload: Record<string, unknown>): ApiResult {
  const props = payload["props"];
  store.logEvent(
    String(payload["name"] ?? ""),
    safeSession(payload["session"]),
    typeof props === "object" && props !== null ? props : null,
  );
  return { status: 204, body: null };
}

export function health(): ApiResult {
  const stats = store.overallStats();
  return {
    status: 200,
    body: {
      ok: stats.objects > 0 && stats.pairs > 0,
      objects: stats.objects,
      pairs: stats.pairs,
      dailyDays: daily.availableDays().length,
      today: daily.today(),
      puzzle: daily.puzzleNumber(daily.today()),
      lastIngest: db.getMeta<string | null>("last_ingest", null),
      adsEnabled: config.ADS_ENABLED,
    },
  };
}
