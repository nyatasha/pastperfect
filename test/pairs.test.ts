/** The pair pool. A question exists only when its answer is provable. */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as config from "../src/config.ts";
import * as db from "../src/db.ts";
import * as insights from "../src/insights.ts";
import { build, difficultyFor, guaranteedGap, tooSimilar } from "../src/pairs.ts";
import { sandbox, teardown } from "./fixtures.ts";

interface JoinedPair {
  id: string; left_id: string; right_id: string; earlier: "left" | "right";
  guaranteed_gap: number; difficulty: number; insight: string; museums: string;
  ls: number; le: number; rs: number; re: number; lm: string; rm: string;
}

const rows = (): JoinedPair[] =>
  db.all<JoinedPair>(
    "SELECT p.*, l.year_start AS ls, l.year_end AS le, r.year_start AS rs, " +
      "r.year_end AS re, l.museum AS lm, r.museum AS rm " +
      "FROM pairs p JOIN objects l ON l.id = p.left_id JOIN objects r ON r.id = p.right_id",
  );

describe("building the pool", () => {
  before(async () => {
    await sandbox();
    build(11, () => {});
  });
  after(teardown);

  it("produces a pool", () => {
    assert.ok(rows().length > 20);
  });

  it("never pairs objects whose ranges overlap", () => {
    for (const row of rows()) {
      const disjoint = row.le < row.rs || row.re < row.ls;
      assert.ok(disjoint, `${row.left_id} vs ${row.right_id} overlap`);
    }
  });

  it("records an earlier side the dates actually support", () => {
    for (const row of rows()) {
      if (row.earlier === "left") assert.ok(row.le < row.rs, row.id);
      else assert.ok(row.re < row.ls, row.id);
    }
  });

  it("stores the provable minimum as the guaranteed gap", () => {
    for (const row of rows()) {
      const expected = row.earlier === "left" ? row.rs - row.le : row.ls - row.re;
      assert.equal(row.guaranteed_gap, expected, row.id);
      assert.ok(row.guaranteed_gap >= config.MIN_PAIR_GAP_YEARS);
    }
  });

  it("gives every pair a caption", () => {
    for (const row of rows()) {
      assert.ok(row.insight.trim().length > 0, row.id);
      assert.ok(row.insight.length < 200, row.id);
    }
  });

  it("scores difficulty in range and records the museums", () => {
    for (const row of rows()) {
      assert.ok([1, 2, 3, 4, 5].includes(row.difficulty));
      assert.equal(row.museums, [...new Set([row.lm, row.rm])].sort().join("|"));
    }
  });

  it("is idempotent", () => {
    const before = new Set(rows().map((row) => row.id));
    build(11, () => {});
    assert.deepEqual(before, new Set(rows().map((row) => row.id)));
  });
});

describe("difficulty", () => {
  const make = (over: Partial<{ region: string; looks_modern: number }> = {}) => ({
    region: "Europe", looks_modern: 0, ...over,
  });

  it("makes wide gaps easy and narrow gaps hard", () => {
    assert.ok(difficultyFor(make(), make(), 900).difficulty < difficultyFor(make(), make(), 4).difficulty);
  });

  it("flags a misleading visual cue and charges a level for it", () => {
    const plain = difficultyFor(make(), make(), 120);
    const tricky = difficultyFor(make({ looks_modern: 1 }), make(), 120);
    assert.equal(tricky.surprise, true);
    assert.equal(plain.surprise, false);
    assert.ok(tricky.difficulty > plain.difficulty);
  });

  it("makes a helpful visual cue easier", () => {
    const plain = difficultyFor(make(), make(), 120);
    const helped = difficultyFor(make(), make({ looks_modern: 1 }), 120);
    assert.equal(helped.surprise, false);
    assert.ok(helped.difficulty < plain.difficulty);
  });

  it("makes crossing regions harder", () => {
    assert.ok(
      difficultyFor(make(), make({ region: "East Asia" }), 120).difficulty >
        difficultyFor(make(), make(), 120).difficulty,
    );
  });

  it("does not treat an unknown region as a difference", () => {
    assert.equal(
      difficultyFor(make({ region: "Unknown" }), make(), 120).difficulty,
      difficultyFor(make(), make(), 120).difficulty,
    );
  });

  it("computes the guaranteed gap symmetrically, and zero when they overlap", () => {
    const a = { year_start: 1600, year_end: 1650 };
    const b = { year_start: 1700, year_end: 1710 };
    assert.equal(guaranteedGap(a, b), 50);
    assert.equal(guaranteedGap(b, a), 50);
    assert.equal(guaranteedGap(a, { year_start: 1640, year_end: 1660 }), 0);
  });
});

describe("near duplicates", () => {
  it("rejects plates from one series", () => {
    assert.equal(
      tooSimilar({ artist: "Goya", title: "Los Caprichos, Plate 1" }, { artist: "Goya", title: "Los Caprichos, Plate 2" }),
      true,
    );
  });

  it("keeps different works by one artist", () => {
    assert.equal(
      tooSimilar({ artist: "Goya", title: "The Third of May" }, { artist: "Goya", title: "Saturn Devouring His Son" }),
      false,
    );
  });

  it("keeps the same title by different artists", () => {
    assert.equal(
      tooSimilar({ artist: "Monet", title: "Self-Portrait" }, { artist: "Cezanne", title: "Self-Portrait" }),
      false,
    );
  });
});

describe("insights", () => {
  const obj = (over: Partial<insights.InsightRow> = {}): insights.InsightRow => ({
    title: "A thing", artist: null, year_mid: 1700, medium: "Oil on canvas",
    classification: "Painting", region: "Europe", looks_modern: 0,
    date_precision: "year", year_start: 1700, year_end: 1700, date_display: "1700",
    ...over,
  });

  it("leads with the surprising case", () => {
    const line = insights.forPair(
      obj({ looks_modern: 1, medium: "Albumen silver print", classification: "Photograph" }),
      obj({ year_mid: 1900, year_start: 1900, year_end: 1900, date_display: "1900" }),
      150, true,
    );
    assert.ok(line.includes("older"));
    assert.ok(line.includes("photograph"));
  });

  it("reads naturally when both forms match", () => {
    const line = insights.forPair(obj(), obj({ year_mid: 1702, year_start: 1702, year_end: 1702, date_display: "1702" }), 2, false);
    assert.ok(line.includes("two paintings"));
    assert.ok(!line.includes("a painting and a painting"));
  });

  it("mentions a shared maker", () => {
    const line = insights.forPair(
      obj({ artist: "Rembrandt van Rijn (Dutch)" }),
      obj({ artist: "Rembrandt van Rijn (Dutch)", year_mid: 1660, year_start: 1660, year_end: 1660, date_display: "1660" }),
      40, false,
    );
    assert.ok(line.includes("Rembrandt"));
  });

  it("never claims a year the museum did not state", () => {
    const line = insights.forPair(
      obj({ date_display: "1700-50", date_precision: "range", year_start: 1700, year_end: 1750, year_mid: 1725, classification: "Textile", medium: "Linen" }),
      obj({ year_mid: 1900, year_start: 1900, year_end: 1900, date_display: "1900", classification: "Sculpture", medium: "Bronze" }),
      180, true,
    );
    assert.ok(line.includes("1700–1750"), line);
    assert.ok(!line.includes("1725"), line);
  });

  it("produces something for any shape of record", () => {
    const line = insights.forPair(
      obj({ region: "Unknown", medium: null, classification: null }),
      obj({ region: "Unknown", medium: null, classification: null, year_mid: 1850, year_start: 1850, year_end: 1850, date_display: "1850" }),
      150, true,
    );
    assert.ok(line.trim().length > 0);
  });
});
