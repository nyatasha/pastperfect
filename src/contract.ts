/**
 * The payload contract between the server and the game client.
 *
 * This file is the reason the project is in TypeScript. Past Perfect's central
 * promise is that a player cannot learn *when* an object was made until they
 * have committed to an answer, and that promise lives entirely in the shape of
 * two payloads. Writing those shapes down once, here, is what turns the promise
 * from something a test checks afterwards into something the compiler refuses
 * to let us break.
 *
 * The rule is about time, not about identity. A player who cannot tell whether
 * they are looking at an oil painting or a photograph of one is not being
 * tested, they are being confused, so `QuestionSide` carries two pieces of
 * "what am I looking at" context: the object's form, drawn from a fixed
 * vocabulary, and the museum that holds it.
 *
 * Nothing that carries a date may join them. Not a title, not a maker, not a
 * medium, not a century, not a free-text field that might contain a year. If
 * you find yourself wanting to add one, it belongs in `RevealSide`.
 */

/**
 * Everything a player may see BEFORE answering.
 *
 * An opaque image, its size, a one-or-two-word noun for the form of the thing
 * ("Painting", "Photograph", "Side chair") and the slug of the museum that
 * holds it. `form` comes from `taxonomy.displayForm`, which cannot emit a
 * digit; `museum` is a slug from `config.MUSEUMS`.
 */
export interface QuestionSide {
  readonly img: string;
  readonly w: number | null;
  readonly h: number | null;
  readonly form: string;
  readonly museum: string;
}

/** One question. `id` carries the pair and its orientation, and reveals neither. */
export interface Question {
  readonly id: string;
  readonly n: number;
  readonly a: QuestionSide;
  readonly b: QuestionSide;
}

export interface DailyRound {
  readonly mode: "daily";
  readonly edition: string;
  readonly date: string;
  readonly puzzle: number;
  readonly total: number;
  readonly questions: readonly Question[];
}

export interface EndlessRound {
  readonly mode: "endless";
  readonly museum: string;
  readonly page: number;
  readonly questions: readonly Question[];
  readonly adAfterRounds?: number;
  readonly exhausted?: boolean;
}

/**
 * One shared pair, opened from a link somebody sent.
 *
 * The same `Question` as either other mode -- the point of a challenge is that
 * it is the ordinary game with one question in it, so nothing here widens what
 * a player may see before answering.
 */
export interface ChallengeRound {
  readonly mode: "challenge";
  readonly questions: readonly Question[];
}

export type Round = DailyRound | EndlessRound | ChallengeRound;

/** Everything a player may see AFTER answering. */
export interface RevealSide {
  readonly title: string;
  readonly artist: string | null;
  readonly artistNote: string | null;
  readonly date: string;
  readonly year: number;
  readonly yearText: string;
  readonly approximate: boolean;
  readonly century: string;
  readonly medium: string | null;
  readonly museum: string;
  readonly museumName: string;
  readonly museumPath: string;
  readonly credit: string | null;
  readonly objectUrl: string;
  readonly licence: string;
  readonly licenceUrl: string;
}

export interface Reveal {
  readonly correct: boolean;
  readonly earlier: "a" | "b";
  readonly gap: number;
  readonly gapText: string;
  readonly approximate: boolean;
  readonly insight: string;
  readonly surprise: boolean;
  readonly difficulty: number;
  readonly successRate: number | null;
  readonly a: RevealSide;
  readonly b: RevealSide;
}

/**
 * How a finished daily compares with everybody else's, and nothing more.
 *
 * Deliberately thin. An earlier version sent the raw player count and the whole
 * score distribution so the client could phrase the comparison itself, which
 * meant every visitor could read today's traffic out of a network response --
 * and the results screen went on to print it at them ("5 people have played
 * today"), which is a number nobody playing a game wants or can act on. The
 * comparison is computed on the server now and the inputs stay there, where
 * `GET /api/metrics` can show them to an operator who holds the token.
 */
export interface Standing {
  readonly date: string;
  readonly puzzle: number;
  readonly score: number;
  /**
   * Share of today's players this score is strictly better than, 0-100, or
   * null while the day's sample is too small to mean anything.
   */
  readonly beat: number | null;
  /** Whether `beat` is available yet. False says "too early", never "how many". */
  readonly ranked: boolean;
}

/**
 * Fields that must never appear in a question payload. Exported so the runtime
 * test and the type share one list: the compiler stops us adding a field to
 * `QuestionSide`, and this stops us leaking one through a stray `JSON.stringify`.
 *
 * "museum" is absent by design -- the holding institution is context, not a
 * date. Everything left on this list either names a work or dates one.
 */
export const FORBIDDEN_BEFORE_ANSWER = [
  "title", "artist", "year", "credit", "licen",
  "insight", "earlier", "medium", "gap", "difficulty", "date",
] as const;
