/** The Daily Challenge: identical for everyone, stable once written. */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as config from "../src/config.ts";
import * as daily from "../src/daily.ts";
import * as db from "../src/db.ts";
import { build } from "../src/pairs.ts";
import { sandbox, teardown } from "./fixtures.ts";

describe("daily sets", () => {
  before(async () => {
    await sandbox();
    build(11, () => {});
    daily.ensure(20, daily.today(), undefined, () => {});
  });
  after(teardown);

  it("gives today a full set", () => {
    assert.equal(daily.questions(daily.today()).length, config.DAILY_QUESTIONS);
  });

  it("generates the same set for a date every time", () => {
    assert.deepEqual(daily.buildDay("2027-03-14"), daily.buildDay("2027-03-14"));
  });

  it("generates different sets on different days", () => {
    assert.notDeepEqual(
      daily.buildDay("2027-03-14").map((row) => row[3]),
      daily.buildDay("2027-03-15").map((row) => row[3]),
    );
  });

  it("never repeats an object inside one day", () => {
    const seen = new Set<string>();
    for (const row of daily.questions(daily.today())) {
      for (const id of [row.left_id, row.right_id]) {
        assert.ok(!seen.has(id), "object used twice in one day");
        seen.add(id);
      }
    }
  });

  it("does not move a stored set when regenerated", () => {
    const before = daily.questions(daily.today()).map((row) => row.pair_id);
    daily.ensure(20, daily.today(), undefined, () => {});
    assert.deepEqual(before, daily.questions(daily.today()).map((row) => row.pair_id));
  });

  it("broadly follows the difficulty curve", () => {
    const levels = daily.questions(daily.today()).map((row) => row.difficulty);
    const opening = levels.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
    const closing = levels.slice(-3).reduce((a, b) => a + b, 0) / 3;
    assert.ok(opening <= closing, `${opening} should not exceed ${closing}`);
  });

  it("keeps a museum edition inside its own collection", () => {
    for (const slug of config.MUSEUM_ORDER) {
      const rows = daily.questions(daily.today(), slug);
      if (rows.length === 0) continue; // the fixture is small; an edition may not fill
      for (const row of rows) assert.equal(row.museums, slug);
    }
  });

  it("numbers puzzles from the epoch", () => {
    assert.equal(daily.puzzleNumber(config.EPOCH_DATE), 1);
    assert.equal(daily.puzzleNumber(daily.addDays(config.EPOCH_DATE, 9)), 10);
  });

  it("closes past and future puzzles by default", () => {
    assert.equal(daily.playableDay(daily.today()), true);
    assert.equal(daily.playableDay(daily.addDays(daily.today(), -1)), false);
    assert.equal(daily.playableDay(daily.addDays(daily.today(), 1)), false);
  });

  /**
   * Freshness is a preference rather than a guarantee: a thin pool should
   * soften the rule, not leave a hole in somebody's puzzle.
   */
  it("keeps consecutive days fresh while the pool can afford it", () => {
    const days = [0, 1, 2].map((offset) => {
      const rows = daily.questions(daily.addDays(daily.today(), offset));
      return new Set([...rows.map((r) => r.left_id), ...rows.map((r) => r.right_id)]);
    });
    assert.equal([...days[0]!].filter((id) => days[1]!.has(id)).length, 0);
    assert.equal([...days[0]!].filter((id) => days[2]!.has(id)).length, 0);
  });

  /**
   * The failure this guards against is a live site with no puzzle on it: a
   * precomputed batch runs out and nobody notices until the daily 503s.
   */
  it("builds a day on demand when the precomputed batch has run out", () => {
    const beyond = daily.addDays(daily.today(), 90); // far past what ensure() made
    assert.equal(daily.questions(beyond).length, 0, "fixture should not have this day");

    const built = daily.ensureDay(beyond);
    assert.equal(built.length, config.DAILY_QUESTIONS);
    assert.equal(daily.questions(beyond).length, config.DAILY_QUESTIONS, "and it is stored");
  });

  it("builds the same day whether eagerly or lazily", () => {
    const day = daily.addDays(daily.today(), 91);
    const lazy = daily.ensureDay(day).map((row) => row.pair_id);
    // Throw it away and let the batch path produce the same day instead.
    db.run("DELETE FROM daily_sets WHERE date = ?", [day]);
    daily.ensure(1, day, [daily.MIXED], () => {});
    assert.deepEqual(daily.questions(day).map((row) => row.pair_id), lazy);
  });

  it("leaves an existing day alone", () => {
    const today = daily.today();
    const before = daily.questions(today).map((row) => row.pair_id);
    assert.deepEqual(daily.ensureDay(today).map((row) => row.pair_id), before);
  });

  it("rejects rubbish dates", () => {
    assert.equal(daily.parseDate("not-a-date"), null);
    assert.equal(daily.parseDate("2026-13-45"), null);
    assert.equal(daily.parseDate("2026-02-30"), null);
    assert.equal(daily.parseDate("2026-09-04"), "2026-09-04");
  });

  it("walks dates across month and year boundaries", () => {
    assert.equal(daily.addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(daily.addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(daily.addDays("2028-03-01", -1), "2028-02-29"); // leap year
  });
});
