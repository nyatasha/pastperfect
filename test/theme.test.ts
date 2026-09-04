/**
 * The two palettes.
 *
 * Dark mode is a token swap, which only works while two things stay true:
 * every colour lives in a token, and both dark blocks stay in step with each
 * other. Both are easy to break by adding one component rule, so both are
 * tested.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import * as config from "../src/config.ts";

const CSS = fs.readFileSync(path.join(config.STATIC_DIR, "css", "app.css"), "utf8");

/**
 * Tokens whose light values would be unreadable on a dark ground. Every one of
 * them has to be redefined by both dark blocks.
 */
const MUST_INVERT = new Set([
  "--ivory", "--ivory-warm", "--ivory-deep", "--ink", "--ink-2", "--ink-3",
  "--line", "--line-soft", "--accent", "--correct", "--shadow-card",
  "--shadow-lift", "--frame-sheen", "--art-shadow", "--chip", "--halo",
  "--ivory-fade", "--on-accent",
]);

/** The body of the first rule whose selector starts with `selector`. */
function block(selector: string): string {
  const start = CSS.indexOf(selector);
  assert.ok(start >= 0, `missing rule: ${selector}`);
  const open = CSS.indexOf("{", start);
  let depth = 1;
  let index = open + 1;
  while (depth > 0 && index < CSS.length) {
    if (CSS[index] === "{") depth += 1;
    else if (CSS[index] === "}") depth -= 1;
    index += 1;
  }
  return CSS.slice(open + 1, index - 1);
}

const tokens = (text: string): Set<string> =>
  new Set([...text.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));

const LIGHT = tokens(block(":root {"));
const SYSTEM_DARK = tokens(block(':root:not([data-theme="light"]) {'));
const CHOSEN_DARK = tokens(block(':root[data-theme="dark"] {'));

describe("palettes", () => {
  it("defines the full set in light", () => {
    for (const token of MUST_INVERT) assert.ok(LIGHT.has(token), `light is missing ${token}`);
  });

  it("keeps the two dark blocks in step", () => {
    assert.deepEqual([...SYSTEM_DARK].sort(), [...CHOSEN_DARK].sort());
  });

  it("redefines everything that must invert", () => {
    for (const [palette, name] of [[SYSTEM_DARK, "system dark"], [CHOSEN_DARK, "chosen dark"]] as const) {
      for (const token of MUST_INVERT) assert.ok(palette.has(token), `${name} is missing ${token}`);
    }
  });

  it("defines no token light has not", () => {
    for (const [palette, name] of [[SYSTEM_DARK, "system dark"], [CHOSEN_DARK, "chosen dark"]] as const) {
      for (const token of palette) assert.ok(LIGHT.has(token), `${name} has stray ${token}`);
    }
  });

  it("yields to an explicit light choice over a dark system", () => {
    assert.ok(CSS.includes(':root:not([data-theme="light"])'));
  });
});

describe("no loose colours", () => {
  it("keeps every colour inside the palette blocks", () => {
    let stripped = CSS;
    for (const selector of [":root {", ':root:not([data-theme="light"]) {', ':root[data-theme="dark"] {']) {
      stripped = stripped.replace(block(selector), "");
    }
    stripped = stripped.replace(/\/\*[\s\S]*?\*\//g, "");
    const offenders = stripped
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /#[0-9A-Fa-f]{3,8}\b|\brgba?\(/.test(line));
    assert.deepEqual(offenders, [], `colour literals outside the palettes: ${offenders.join(" | ")}`);
  });
});

describe("client scripts", () => {
  it("hides what the game hides", () => {
    // The classic cascade trap: an author `img { display: block }` outranks the
    // user agent's `[hidden] { display: none }`.
    assert.ok(CSS.includes("[hidden] { display: none !important; }"));
  });

  it("ships the theme toggle wiring", () => {
    const appJs = fs.readFileSync(path.join(config.STATIC_DIR, "js", "app.js"), "utf8");
    assert.ok(appJs.includes("pastperfect.theme"));
    assert.ok(appJs.includes("prefers-color-scheme: dark"));
  });
});
