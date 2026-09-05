/**
 * The link checker, minus the network.
 *
 * `check` and `run` talk to four museums, so they are deliberately not tested
 * here: a suite that fails when the Rijksmuseum is having a bad morning is a
 * suite people learn to ignore. What is tested is everything that decides what
 * a status *means*, which is where the judgement actually lives.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as config from "../src/config.ts";
import * as db from "../src/db.ts";
import { BLOCKED, BROKEN, classify, failing, sample, type MuseumReport } from "../src/links.ts";
import { sandbox, teardown } from "./fixtures.ts";

/** A report with nothing wrong in it, for tests that vary one field. */
function report(over: Partial<MuseumReport> = {}): MuseumReport {
  return {
    museum: "met", checked: 6, ok: 6, blocked: 0, broken: 0, unreachable: 0,
    examples: [], ...over,
  };
}

describe("classifying a status", () => {
  it("treats a page that answered as ok", () => {
    for (const status of [200, 201, 204, 301, 302, 307, 399]) {
      assert.equal(classify(status), "ok", String(status));
    }
  });

  /* The distinction the whole check exists to draw: the Met answers a bot with
     429 and Wellcome with 403 while serving both pages fine to a browser. */
  it("calls a bot wall blocked, not broken", () => {
    for (const status of BLOCKED) assert.equal(classify(status), "blocked", String(status));
    assert.equal(classify(403), "blocked");
    assert.equal(classify(429), "blocked");
  });

  it("calls a missing page broken", () => {
    for (const status of BROKEN) assert.equal(classify(status), "broken", String(status));
    assert.equal(classify(404), "broken");
    assert.equal(classify(410), "broken");
  });

  it("calls no response at all unreachable", () => {
    assert.equal(classify(null), "unreachable");
  });

  /* Anything unrecognised is broken rather than ok, so a new failure mode
     surfaces instead of passing quietly. */
  it("refuses to call an unknown failure a success", () => {
    for (const status of [400, 402, 500, 502]) {
      assert.equal(classify(status), "broken", String(status));
    }
  });

  it("agrees with itself: no status is both blocked and broken", () => {
    for (const status of BLOCKED) assert.ok(!BROKEN.has(status), String(status));
  });
});

describe("deciding a museum is failing", () => {
  it("fails a museum whose links are gone", () => {
    assert.equal(failing(report({ ok: 0, broken: 6 })), true);
  });

  it("does not fail a museum that only refused us", () => {
    assert.equal(failing(report({ ok: 0, blocked: 6 })), false);
  });

  /* Unreachable is a network having a bad day, not a museum moving its URLs. */
  it("does not fail a museum we simply could not reach", () => {
    assert.equal(failing(report({ ok: 0, unreachable: 6 })), false);
  });

  it("does not fail a museum where anything at all resolved", () => {
    assert.equal(failing(report({ ok: 1, broken: 5 })), false);
  });

  it("does not fail a museum we hold no links for", () => {
    assert.equal(failing(report({ checked: 0, ok: 0 })), false);
  });
});

describe("sampling links to check", () => {
  before(sandbox);
  after(teardown);

  it("takes the asked-for number from every collection", () => {
    const picked = sample(3);
    for (const slug of config.MUSEUM_ORDER) {
      assert.equal(picked.filter((row) => row.museum === slug).length, 3, slug);
    }
    assert.equal(picked.length, 3 * config.MUSEUM_ORDER.length);
  });

  it("returns the same sample every run, so a report is comparable", () => {
    assert.deepEqual(sample(4), sample(4));
  });

  it("gives back a real URL for every pick", () => {
    for (const row of sample(2)) {
      assert.ok(config.MUSEUM_ORDER.includes(row.museum as never), row.museum);
      assert.match(row.url, /^https?:\/\//, row.url);
    }
  });

  /* An object with no link is not a broken link, and asking about "" would
     report an unreachable that means nothing. */
  it("never samples an object that has no link", () => {
    db.run("UPDATE objects SET object_url = '' WHERE museum = 'met'");
    const picked = sample(3);
    assert.equal(picked.filter((row) => row.museum === "met").length, 0);
    assert.ok(picked.every((row) => row.url !== ""));
    // The other collections are untouched by one museum's missing links.
    assert.equal(picked.filter((row) => row.museum === "aic").length, 3);
  });

  it("asks for no more than a collection holds", () => {
    const held = db.scalar(
      "SELECT COUNT(*) AS n FROM objects WHERE museum = 'aic' AND playable = 1 AND object_url <> ''",
    );
    assert.ok(sample(held + 50).filter((row) => row.museum === "aic").length === held);
  });
});
