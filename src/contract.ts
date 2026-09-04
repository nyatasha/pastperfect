/**
 * The payload contract between the server and the game client.
 *
 * This file is the reason the project is in TypeScript. Past Perfect's central
 * promise is that a player cannot learn anything about an object until they
 * have committed to an answer, and that promise lives entirely in the shape of
 * two payloads. Writing those shapes down once, here, is what turns the promise
 * from something a test checks afterwards into something the compiler refuses
 * to let us break.
 *
 * The rule: nothing describing an object may be added to `QuestionSide`. Not a
 * title, not a date, not a museum, not a hint of one. If you find yourself
 * wanting to, the answer is that it belongs in `RevealSide`.
 */

/** Everything a player may see BEFORE answering: an opaque image and its size. */
export interface QuestionSide {
  readonly img: string;
  readonly w: number | null;
  readonly h: number | null;
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

export type Round = DailyRound | EndlessRound;

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

export interface Standing {
  readonly date: string;
  readonly puzzle: number;
  readonly score: number;
  readonly players: number;
  readonly percentile: number | null;
  readonly distribution: readonly number[];
  readonly minSample: number;
}

/**
 * Fields that must never appear in a question payload. Exported so the runtime
 * test and the type share one list: the compiler stops us adding a field to
 * `QuestionSide`, and this stops us leaking one through a stray `JSON.stringify`.
 */
export const FORBIDDEN_BEFORE_ANSWER = [
  "title", "artist", "year", "museum", "credit", "licen",
  "insight", "earlier", "medium", "gap", "difficulty", "date",
] as const;
