/**
 * Seeded randomness.
 *
 * The daily set and the endless walk both have to be reproducible from a seed:
 * regenerate a day and you must get the same ten questions. Node has no seedable
 * RNG, so this is mulberry32 -- small, fast, and good enough for choosing which
 * teapot you see on a Tuesday.
 */

import { createHash } from "node:crypto";

/** A stable 32-bit seed from any string. */
export function seedFrom(text: string): number {
  return createHash("sha256").update(text).digest().readUInt32BE(0);
}

export type Rng = () => number;

export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rngFor(text: string): Rng {
  return makeRng(seedFrom(text));
}

/** Fisher-Yates, in place. */
export function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

export function choice<T>(items: readonly T[], rng: Rng): T {
  return items[Math.floor(rng() * items.length)]!;
}
