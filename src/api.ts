/**
 * The JSON API the game client talks to.
 *
 * Two rules shape this module.
 *
 * First, a question payload contains no title, no maker, no date and no museum
 * -- only two opaque image URLs. Everything that would give the answer away
 * arrives after the player commits, from POST /api/answer. That rule is no
 * longer a convention: `QuestionSide` in contract.ts cannot hold those fields,
 * so a leak fails to compile rather than failing in production.
 *
 * Second, the answer itself is computed here from stored date intervals. There
 * is no model in this path, and there is no network call in this path.
 */

import type {
  DailyRound, EndlessRound, Question, QuestionSide, Reveal, RevealSide, Standing,
} from "./contract.ts";
import * as config from "./config.ts";
import * as daily from "./daily.ts";
import * as dates from "./dates.ts";
import * as db from "./db.ts";
import * as store from "./store.ts";

export const QID = /^([0-9a-f]{16})\.([01])$/;
export const SESSION = /^[A-Za-z0-9_-]{6,64}$/;
export const MAX_ENDLESS_PAGE = 400;
export const ENDLESS_PAGE_SIZE = 8;

export function safeSession(value: unknown): string {
  const text = String(value ?? "");
  return SESSION.test(text) ? text : "";
}

/**
 * What a player may see *before* answering.
 *
 * The single place a QuestionSide is built. Its return type is the contract, so
 * adding anything identifying here is a type error at this line rather than a
 * spoiler in production.
 */
function questionSide(row: store.ObjectRow): QuestionSide {
  return { img: `/img/${row.image_key}.jpg`, w: row.image_w, h: row.image_h };
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
  const rows = daily.questions(day, edition);
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
  const page = Number.isFinite(raw) ? Math.max(0, Math.min(MAX_ENDLESS_PAGE, Math.trunc(raw))) : 0;

  const picks = store.endlessPage(seed, museum, page, ENDLESS_PAGE_SIZE);
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

export function round(query: URLSearchParams): ApiResult {
  return query.get("mode") === "endless" ? endlessRound(query) : dailyRound(query);
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
  const body: Standing = {
    date: day,
    puzzle: daily.puzzleNumber(day),
    score: rawScore,
    minSample: config.PERCENTILE_MIN_SAMPLE,
    players: standing.players,
    percentile: standing.percentile,
    distribution: standing.distribution,
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
