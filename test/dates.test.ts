/** The date parser is the correctness core, so it gets the most tests. */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import * as config from "../src/config.ts";
import {
  centuryKey, centuryLabel, describeGap, estimate, formatYear, headline,
  parseDisplay, playable, representativeYear, span, type DateEstimate,
} from "../src/dates.ts";

function assertRange(text: string, start: number, end: number, precision?: string): void {
  const result = parseDisplay(text);
  assert.ok(result, `${text} did not parse`);
  assert.deepEqual([result.start, result.end], [start, end], text);
  if (precision) assert.equal(result.precision, precision, text);
}

describe("parseDisplay", () => {
  it("reads plain years", () => {
    assertRange("1878", 1878, 1878, "year");
    assertRange("[1877]", 1877, 1877);
    assertRange("Bruxelles : Mayolez, 1877.", 1877, 1877);
  });

  it("reads ranges, in both house styles", () => {
    assertRange("1798-1802", 1798, 1802, "range");
    assertRange("1884-86", 1884, 1886);
    assertRange("1630/36", 1630, 1636); // the Art Institute's style
    assertRange("1893/1894", 1893, 1894);
    assertRange("between 1900 and 1910", 1900, 1910);
  });

  it("does not read day/month/year notation as a range", () => {
    assert.equal(parseDisplay("Anarchiste. 14/3/94."), null);
  });

  it("widens when a label hedges", () => {
    assertRange("ca. 1470", 1465, 1475, "circa");
    assertRange("probably 1512", 1507, 1517, "circa");
    assertRange("1642 (?)", 1637, 1647, "circa");
  });

  it("reads centuries and their fractions", () => {
    assertRange("17th century", 1600, 1699, "century");
    assertRange("late 17th century", 1667, 1699);
    assertRange("mid-18th century", 1733, 1766);
    assertRange("second half of the 19th century", 1850, 1899);
    assertRange("first quarter 18th century", 1700, 1724);
    assertRange("19th-20th century", 1800, 1999);
    assertRange("17th and 18th centuries", 1600, 1799);
  });

  it("reads decades and open shorthand", () => {
    assertRange("1890s", 1890, 1899, "decade");
    assertRange("1500s", 1500, 1599, "century"); // ambiguous -> wider reading
    assertRange("18--", 1800, 1899);
    assertRange("185-", 1850, 1859);
  });

  it("reads open-ended labels", () => {
    assertRange("before 1600", 1575, 1600);
    assertRange("after 1850", 1850, 1875);
  });

  it("reads BCE without mistaking B.C. for circa", () => {
    assertRange("500 B.C.", -500, -500);
    assertRange("500-400 B.C.", -500, -400);
    assertRange("1st century B.C.", -100, -1);
    assertRange("late 1st century B.C.", -33, -1);
  });

  it("returns nothing usable for a label with no date", () => {
    for (const text of ["n.d.", "undated", "date unknown", "plate 4", "", "   "]) {
      assert.equal(parseDisplay(text), null, text);
    }
  });

  it("treats a period parenthetical as context, not a date", () => {
    assert.equal(parseDisplay("Edo period (1615-1868)"), null);
    assertRange("Ming dynasty (1368-1644), 15th century", 1400, 1499);
  });

  it("does not mistake short numbers for years", () => {
    assertRange("Vol. 3, 1899", 1899, 1899);
  });
});

describe("representativeYear", () => {
  it("prefers a stated year inside the range over the midpoint", () => {
    const e: DateEstimate = { start: 1854, end: 1858, precision: "range", display: "1854" };
    assert.equal(representativeYear(e), 1854);
  });

  it("falls back to the midpoint when the label names no single year", () => {
    const e: DateEstimate = { start: 1600, end: 1699, precision: "century", display: "17th century" };
    assert.equal(representativeYear(e), 1649);
  });

  it("ignores a stated year outside the range", () => {
    const e: DateEstimate = { start: 1700, end: 1720, precision: "range", display: "1650" };
    assert.equal(representativeYear(e), 1710);
  });
});

describe("estimate", () => {
  it("lets an openly vague label widen confident numeric fields", () => {
    const result = estimate("19th century", 1850, 1850);
    assert.deepEqual([result!.start, result!.end], [1800, 1899]);
  });

  it("treats a far wider numeric label as context", () => {
    let result = estimate("1884-86, border added 1888-89", 1884, 1886);
    assert.deepEqual([result!.start, result!.end], [1884, 1889]);
    result = estimate("Edo period (1615-1868)", 1700, 1750);
    assert.deepEqual([result!.start, result!.end], [1700, 1750]);
  });

  it("copes when either side is missing", () => {
    assert.equal(estimate(null, 1642, 1642)!.start, 1642);
    assert.equal(estimate("1642", null, null)!.start, 1642);
    assert.equal(estimate("n.d.", null, null), null);
  });

  it("repairs reversed fields", () => {
    const result = estimate(null, 1700, 1600);
    assert.deepEqual([result!.start, result!.end], [1600, 1700]);
  });
});

describe("playability", () => {
  it("refuses ranges wider than the limit", () => {
    const wide: DateEstimate = { start: 1000, end: 1000 + config.MAX_OBJECT_SPAN_YEARS + 1, precision: "range", display: "" };
    assert.equal(playable(wide), false);
    const edge: DateEstimate = { start: 1000, end: 1000 + config.MAX_OBJECT_SPAN_YEARS, precision: "range", display: "" };
    assert.equal(playable(edge), true);
  });

  it("refuses years outside the sane bounds", () => {
    assert.equal(playable({ start: -99999, end: -99998, precision: "range", display: "" }), false);
    assert.equal(playable({ start: config.MAX_YEAR + 5, end: config.MAX_YEAR + 6, precision: "range", display: "" }), false);
  });

  it("measures span", () => {
    assert.equal(span({ start: 1600, end: 1699, precision: "century", display: "" }), 99);
  });
});

describe("presentation", () => {
  it("formats years either side of the era", () => {
    assert.equal(formatYear(1642), "1642");
    assert.equal(formatYear(-500), "500 BC");
  });

  it("names centuries", () => {
    assert.equal(centuryLabel(1878), "19th century");
    assert.equal(centuryLabel(-500), "5th century BC");
    assert.equal(centuryKey(1878), 18);
    assert.equal(centuryKey(-500), -5);
  });

  it("hedges the gap only when the dates are imprecise", () => {
    assert.ok(describeGap(120, true).includes("about"));
    assert.ok(!describeGap(12, false).includes("about"));
    assert.equal(describeGap(1, false), "1 year apart");
  });

  it("never prints more precision than the museum claimed", () => {
    assert.equal(
      headline({ date_display: "1700-50", date_precision: "range", year_start: 1700, year_end: 1750, year_mid: 1725 }),
      "1700–1750",
    );
    assert.equal(
      headline({ date_display: "early 17th century", date_precision: "century", year_start: 1600, year_end: 1632, year_mid: 1616 }),
      "17th century",
    );
    assert.equal(
      headline({ date_display: "1854", date_precision: "range", year_start: 1854, year_end: 1858, year_mid: 1854 }),
      "1854",
    );
  });
});

after(() => { /* no shared state */ });
