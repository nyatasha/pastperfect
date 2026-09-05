/**
 * The local record, exercised rather than read.
 *
 * `static/js/app.js` is the whole account system -- streak, passport, lifetime
 * totals -- and it is the one part of the game with no server behind it to
 * check its arithmetic. So it is loaded here into a stub browser and driven
 * through the calls the board actually makes, because the questions worth
 * answering ("does an endless answer reach the passport?", "can a daily count
 * itself twice?") are behavioural and a substring assertion cannot see them.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { beforeEach, describe, it } from "node:test";

import * as config from "../src/config.ts";

const APP_JS = fs.readFileSync(path.join(config.STATIC_DIR, "js", "app.js"), "utf8");

/** Just enough browser for app.js to load: storage, a theme toggle to not find. */
function browser(): any {
  const cells = new Map<string, string>();
  const noop = (): void => {};
  const element = (): any => ({
    setAttribute: noop, removeAttribute: noop, getAttribute: () => null,
    appendChild: noop, remove: noop, addEventListener: noop,
    classList: { add: noop, remove: noop, toggle: noop },
  });
  const win: any = {
    localStorage: {
      getItem: (key: string) => (cells.has(key) ? cells.get(key)! : null),
      setItem: (key: string, value: string) => void cells.set(key, String(value)),
      removeItem: (key: string) => void cells.delete(key),
    },
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    crypto: { getRandomValues: (bytes: Uint8Array) => bytes.map((_, i) => i + 7) },
    addEventListener: noop,
  };
  win.window = win;
  win.document = {
    readyState: "complete", documentElement: element(), head: element(),
    querySelector: () => null, getElementById: () => null,
    createElement: element, addEventListener: noop,
  };
  win.navigator = {};
  win.fetch = () => ({ catch: noop });
  vm.createContext(win);
  vm.runInContext(APP_JS, win);
  return win;
}

/**
 * One reveal, in the shape the board banks it: the two sides as the answer
 * payload sends them, plus the forms the question payload carried.
 */
function answered(over: Partial<Record<string, unknown>> = {}): any {
  return {
    correct: true, gap: 120, surprise: false,
    a: { museum: "met", year: 1500, museumName: "The Met" },
    b: { museum: "aic", year: 1620, museumName: "Art Institute" },
    formA: "Painting", formB: "Photograph",
    earlier: "a", chosen: "a",
    ...over,
  };
}

/** The Daily Challenge's own numbers -- the ones endless must never move. */
function dailyOnly(record: any): unknown {
  return {
    played: record.played, dist: record.dist, streak: record.streak,
    best: record.best, lastPlayed: record.lastPlayed, daily: record.daily,
  };
}

describe("endless and the lifetime record", () => {
  let PP: any;
  beforeEach(() => { PP = browser().PP; });

  it("banks what an endless answer showed you, as it happens", () => {
    PP.recordEndlessAnswer(answered(), 1);
    const record = PP.load();
    assert.equal(record.answers, 1);
    assert.equal(record.correct, 1);
    assert.equal(record.objectsSeen, 2);
    assert.equal(record.museums["met"], 1);
    assert.equal(record.museums["aic"], 1);
    assert.equal(record.forms["Painting"], 1);
    assert.equal(record.forms["Photograph"], 1);
    assert.equal(record.oldestYear, 1500);
    assert.equal(record.newestYear, 1620);
    // Field by field: the record is built inside the vm, so its objects are
    // structurally equal to a plain literal without being the same realm's.
    assert.equal(record.centuries["15"].seen, 1);
    assert.equal(record.centuries["15"].right, 1);
    assert.equal(record.endlessBest, 1);
  });

  /**
   * The passport is the "common collection progress" a player watches. It has
   * to move in endless, and it has to move at the same rate as it does in a
   * daily -- two objects per question, whichever mode showed them.
   */
  it("fills the passport at the same rate as a daily", () => {
    for (let i = 0; i < 5; i++) PP.recordEndlessAnswer(answered(), i + 1);
    const endless = PP.load();

    const daily = browser().PP;
    daily.recordDaily("2026-09-05", "", 5, Array.from({ length: 5 }, () => answered()));
    const finished = daily.load();

    assert.equal(endless.museums["met"], 5);
    assert.equal(endless.museums["met"], finished.museums["met"]);
    assert.equal(endless.objectsSeen, finished.objectsSeen);
    assert.equal(endless.answers, finished.answers);
  });

  it("never moves a Daily Challenge number", () => {
    const before = dailyOnly(PP.load());
    for (let i = 0; i < 12; i++) {
      PP.recordEndlessAnswer(answered({ correct: i % 2 === 0 }), i);
    }
    PP.endEndlessRun(9);
    const after = PP.load();
    assert.deepEqual(dailyOnly(after), before);
    assert.equal(after.played, 0);
    assert.equal(after.streak, 0);
    assert.equal(after.endlessRuns, 1);
    assert.equal(after.endlessBest, 11);
  });

  /** Ending a run counts the run, and nothing else: the answers are already in. */
  it("counts an endless answer once, not again at the end of the run", () => {
    PP.recordEndlessAnswer(answered(), 1);
    PP.recordEndlessAnswer(answered(), 2);
    const banked = PP.load();
    PP.endEndlessRun(2);
    const ended = PP.load();
    assert.equal(ended.answers, banked.answers);
    assert.equal(ended.objectsSeen, banked.objectsSeen);
    assert.equal(ended.museums["met"], banked.museums["met"]);
  });

  it("still notices a surprise, a near miss and a five-century miss", () => {
    PP.recordEndlessAnswer(answered({ correct: true, surprise: true }), 1);
    PP.recordEndlessAnswer(answered({ correct: false, gap: 900 }), 0);
    PP.recordEndlessAnswer(answered({ correct: false, gap: 12 }), 0);
    const record = PP.load();
    assert.equal(record.surpriseWins, 1);
    assert.equal(record.bigMisses, 1);
    assert.equal(record.nearMisses, 1);
  });
});

/**
 * Where a run resumes.
 *
 * The pool's order is fixed by the seed, so page 0 is always the same eight
 * questions. Without a cursor, leaving a run and coming back replayed them --
 * and since every answer is banked as it is given, the replay counted the same
 * objects into the passport twice.
 */
describe("the endless cursor", () => {
  let PP: any;
  beforeEach(() => { PP = browser().PP; });

  it("starts a browser that has never played at the first page", () => {
    assert.equal(PP.endlessResume(""), 0);
    assert.equal(PP.endlessResume("met"), 0);
  });

  it("resumes after the page the player answered into", () => {
    PP.markEndlessPage("", 3);
    assert.equal(PP.endlessResume(""), 3);
  });

  it("walks one cursor per pool", () => {
    PP.markEndlessPage("", 4);
    PP.markEndlessPage("met", 1);
    assert.equal(PP.endlessResume(""), 4);
    assert.equal(PP.endlessResume("met"), 1);
    assert.equal(PP.endlessResume("aic"), 0);
  });

  it("goes back to the top when the pool runs out", () => {
    PP.markEndlessPage("met", 7);
    PP.markEndlessPage("met", 0);
    assert.equal(PP.endlessResume("met"), 0);
  });

  it("ignores a cursor that has been tampered with", () => {
    const record = PP.load();
    record.endlessAt = { mixed: "nonsense", met: -4 };
    PP.save(record);
    assert.equal(PP.endlessResume(""), 0);
    assert.equal(PP.endlessResume("met"), 0);
  });

  it("survives a record written before the cursor existed", () => {
    const old = PP.blankRecord();
    delete old.endlessAt;
    PP.save(old);
    assert.equal(PP.endlessResume(""), 0);
    PP.markEndlessPage("", 2);
    assert.equal(PP.endlessResume(""), 2);
  });
});

describe("the daily record", () => {
  let PP: any;
  beforeEach(() => { PP = browser().PP; });

  it("counts a finished daily once, however often it is replayed", () => {
    const answers = Array.from({ length: 3 }, () => answered());
    PP.recordDaily("2026-09-05", "", 3, answers);
    PP.recordDaily("2026-09-05", "", 3, answers);
    const record = PP.load();
    assert.equal(record.played, 1);
    assert.equal(record.answers, 3);
    assert.equal(record.dist[3], 1);
    assert.equal(record.streak, 1);
  });

  it("moves the streak on consecutive days, and only for the mixed edition", () => {
    PP.recordDaily("2026-09-04", "", 6, [answered()]);
    PP.recordDaily("2026-09-05", "", 8, [answered()]);
    assert.equal(PP.load().streak, 2);
    PP.recordDaily("2026-09-06", "met", 9, [answered()]);
    const record = PP.load();
    assert.equal(record.streak, 2, "a museum edition is not the streak");
    assert.equal(record.played, 3);
    assert.equal(record.best, 2);
  });
});
