/** The rights gate decides what we are allowed to show at all. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as config from "../src/config.ts";
import { allowedSummary, evaluate, normalise, refusedSummary } from "../src/rights.ts";

describe("normalise", () => {
  it("maps identifiers and URLs onto canonical ids", () => {
    const cases: Record<string, string> = {
      cc0: "cc0",
      CC0: "cc0",
      "https://creativecommons.org/publicdomain/zero/1.0/": "cc0",
      pdm: "pdm",
      "Public Domain Mark": "pdm",
      "https://creativecommons.org/publicdomain/mark/1.0/": "pdm",
      "cc-by": "cc-by",
      "https://creativecommons.org/licenses/by/4.0/": "cc-by",
    };
    for (const [raw, expected] of Object.entries(cases)) assert.equal(normalise(raw), expected, raw);
  });

  it("returns nothing for a statement it does not know", () => {
    for (const raw of [null, "", "all rights reserved", "ask us nicely"]) {
      assert.equal(normalise(raw), null, String(raw));
    }
  });
});

describe("the gate", () => {
  it("passes open licences with the detail we need to attribute", () => {
    const { allowed, reason, detail } = evaluate("cc0", "test basis");
    assert.equal(allowed, true);
    assert.equal(reason, "");
    assert.equal(detail!.license_id, "cc0");
    assert.equal(detail!.rights_basis, "test basis");
    assert.ok(detail!.license_id in config.ALLOWED_LICENCES);
  });

  it("refuses NonCommercial and NoDerivatives", () => {
    for (const raw of ["cc-by-nc", "cc-by-nc-sa", "cc-by-nd", "https://creativecommons.org/licenses/by-nc-nd/4.0/"]) {
      const { allowed, reason } = evaluate(raw, "test");
      assert.equal(allowed, false, raw);
      assert.ok(reason.includes("excluded"), raw);
    }
  });

  it("refuses in-copyright material", () => {
    assert.equal(evaluate("inc", "test").allowed, false);
  });

  it("refuses rather than assumes when the statement is absent or unknown", () => {
    for (const raw of [null, "", "something new"]) {
      const { allowed, reason } = evaluate(raw, "test");
      assert.equal(allowed, false, String(raw));
      assert.ok(reason.includes("no recognised licence"), String(raw));
    }
  });

  it("round-trips every allowed licence", () => {
    for (const key of Object.keys(config.ALLOWED_LICENCES)) {
      const { allowed, detail } = evaluate(key, "test");
      assert.equal(allowed, true, key);
      assert.ok(detail!.license_url.startsWith("https://"), key);
    }
  });

  it("publishes both lists for the rights page", () => {
    assert.equal(allowedSummary().length, Object.keys(config.ALLOWED_LICENCES).length);
    assert.ok(refusedSummary().some((item) => item.id === "cc-by-nc"));
  });
});
