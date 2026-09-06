/**
 * The share pipeline.
 *
 * `static/js/share.js` decides what a Past Perfect image looks like when it
 * leaves the site, and none of that is checkable from the server: the card is
 * drawn in a browser and handed to the operating system. So the module is
 * loaded into a stub browser with a recording canvas, and driven through the
 * things that actually break -- text that runs off the edge of a square, and a
 * share sheet that will not take a file.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, it } from "node:test";

import * as config from "../src/config.ts";

const SHARE_JS = fs.readFileSync(path.join(config.STATIC_DIR, "js", "share.js"), "utf8");
const GAME_JS = fs.readFileSync(path.join(config.STATIC_DIR, "js", "game.js"), "utf8");
const STATS_JS = fs.readFileSync(path.join(config.STATIC_DIR, "js", "stats.js"), "utf8");

/** A 2d context that records calls and measures text at 0.5em a character. */
function context(): any {
  const calls: any[] = [];
  const ctx: any = {
    calls,
    font: "10px serif",
    measureText: (text: string) => ({
      width: String(text).length * (parseFloat(ctx.font) || 10) * 0.5,
    }),
    fillText: (text: string, x: number, y: number) => void calls.push({ text, x, y }),
  };
  for (const name of [
    "clearRect", "fillRect", "beginPath", "moveTo", "arcTo", "arc", "closePath",
    "fill", "stroke", "save", "restore", "clip", "translate", "scale", "drawImage",
  ]) ctx[name] = (): void => {};
  return ctx;
}

function canvas(): any {
  const ctx = context();
  return { width: 1080, height: 1920, getContext: () => ctx, ctx };
}

function browser(over: Record<string, unknown> = {}): any {
  const win: any = {
    PP: { theme: () => "light" },
    navigator: {},
    Image: class {},
    document: { createElement: () => ({}), body: {} },
    setTimeout: () => 0,
    ...over,
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(SHARE_JS, win);
  return win;
}

describe("the share card", () => {
  const S = browser().PP.share;

  it("is 9:16, the shape a full-bleed story wants", () => {
    assert.equal(S.W, 1080);
    assert.equal(S.H, 1920);
    assert.equal(S.H / S.W, 16 / 9);
    // The canvases in markup are the same shape, not a stretched square.
    assert.ok(GAME_JS.includes('width="1080" height="1920"'));
    assert.ok(STATS_JS.includes('width="1080" height="1920"'));
  });

  it("wraps a long line and never runs past the width it was given", () => {
    const ctx = context();
    ctx.font = "40px serif";
    const title =
      "Today I learned that the engraving “A view of the city of Edinburgh from " +
      "Calton Hill, with figures in the foreground” (1789) is older than the " +
      "photograph “Untitled” (1932).";
    const rows = S.wrap(ctx, title, 920, 4);
    assert.equal(rows.length, 4);
    for (const row of rows) assert.ok(ctx.measureText(row).width <= 920, row);
  });

  it("marks a sentence it had to cut, rather than dropping the rest silently", () => {
    const ctx = context();
    ctx.font = "40px serif";
    const rows = S.wrap(ctx, "word ".repeat(200), 920, 4);
    assert.ok(rows[3].endsWith("…"));
  });

  it("cuts a one-line field to fit instead of wrapping it", () => {
    const ctx = context();
    ctx.font = "36px serif";
    const cut = S.fit(ctx, "Immaculate. Nothing left to teach you about this.", 200);
    assert.ok(cut.endsWith("…"));
    assert.ok(ctx.measureText(cut).width <= 200);
    // Something that already fits is left alone.
    assert.equal(S.fit(ctx, "Sharp", 400), "Sharp");
  });

  it("keeps the wordmark and the address on the card", () => {
    const c = canvas();
    const ctx = S.begin(c);
    S.footer(ctx, c, "https://pastperfect.example/daily", 72);
    const text = c.ctx.calls.map((call: any) => call.text);
    assert.ok(text.includes("Past Perfect"));
    assert.ok(text.includes("pastperfect.example/daily"));
    // Everything sits inside the card.
    for (const call of c.ctx.calls) assert.ok(call.y > 0 && call.y < 1920);
  });
});

describe("getting a card out of the browser", () => {
  /** A canvas whose toBlob hands back something File-shaped. */
  function shareable(): any {
    const c = canvas();
    c.toBlob = (done: (blob: unknown) => void): void => done({ size: 10 });
    return c;
  }

  it("sends the image itself when the share sheet takes files", async () => {
    const shared: any[] = [];
    const win = browser({
      navigator: {
        canShare: () => true,
        share: (data: unknown) => { shared.push(data); return Promise.resolve(); },
      },
      File: class { name: string; constructor(_parts: unknown[], name: string) { this.name = name; } },
    });
    await win.PP.share.send({
      canvas: shareable(), text: "7/10", url: "https://x/daily", filename: "a.png",
    });
    assert.equal(shared.length, 1);
    assert.equal(shared[0].files.length, 1);
    assert.equal(shared[0].files[0].name, "a.png");
  });

  it("falls back to the sentence and the link when files are refused", async () => {
    const shared: any[] = [];
    const win = browser({
      navigator: {
        canShare: () => false,
        share: (data: unknown) => { shared.push(data); return Promise.resolve(); },
      },
      File: class {},
    });
    await win.PP.share.send({
      canvas: shareable(), text: "7/10", url: "https://x/daily", filename: "a.png",
    });
    assert.equal(shared.length, 1);
    assert.equal(shared[0].files, undefined);
    assert.equal(shared[0].url, "https://x/daily");
  });

  it("falls back to the clipboard with no share sheet at all", async () => {
    const copied: string[] = [];
    const notes: string[] = [];
    const win = browser({
      navigator: {
        clipboard: { writeText: (t: string) => { copied.push(t); return Promise.resolve(); } },
      },
    });
    await win.PP.share.send({
      canvas: shareable(), text: "7/10\nhttps://x/daily", url: "https://x/daily",
      filename: "a.png", note: (m: string) => void notes.push(m),
    });
    assert.deepEqual(copied, ["7/10\nhttps://x/daily"]);
    assert.equal(notes.length, 1);
  });

  /** An achievement has no save button of its own, so it hands over the PNG. */
  it("falls back to the download when the caller asked for the file", async () => {
    const clicked: any[] = [];
    const link: any = { click: () => void clicked.push(link.download), remove: () => {} };
    const win = browser({
      navigator: {},
      URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
      document: { createElement: () => link, body: { appendChild: () => {} } },
    });
    await win.PP.share.send({
      canvas: shareable(), text: "unlocked", url: "https://x/daily",
      filename: "past-perfect-perfect.png", fallback: "download", note: () => {},
    });
    assert.deepEqual(clicked, ["past-perfect-perfect.png"]);
  });
});

/**
 * Sharing one pair.
 *
 * A challenge goes out as a sentence and a link and nothing else -- no card,
 * because a picture of the two objects with the reveal drawn on it would answer
 * the question before the recipient was asked it. So it uses the same way out
 * to the operating system, without the canvas.
 */
describe("challenge sharing", () => {
  it("hands the link to the share sheet where there is one", async () => {
    const shared: any[] = [];
    const win = browser({
      navigator: { share: (data: unknown) => { shared.push(data); return Promise.resolve(); } },
    });
    await win.PP.share.sendLink({
      text: "Which came first? Try this: https://x/challenge/abc.0",
      url: "https://x/challenge/abc.0",
    });
    assert.equal(shared.length, 1);
    assert.equal(shared[0].url, "https://x/challenge/abc.0");
    // No card is drawn for a pair, so no file is offered.
    assert.equal(shared[0].files, undefined);
  });

  it("falls back to the clipboard, and says so", async () => {
    const copied: string[] = [];
    const notes: string[] = [];
    const win = browser({
      navigator: {
        clipboard: { writeText: (t: string) => { copied.push(t); return Promise.resolve(); } },
      },
    });
    await win.PP.share.sendLink({
      text: "Which came first? https://x/challenge/abc.0",
      url: "https://x/challenge/abc.0",
      note: (m: string) => void notes.push(m),
    });
    assert.deepEqual(copied, ["Which came first? https://x/challenge/abc.0"]);
    assert.equal(notes.length, 1, "the fallback said nothing to a screen reader");
  });

  it("shares a link the recipient can play, and no spoiler with it", () => {
    const text = GAME_JS.slice(
      GAME_JS.indexOf("var CHALLENGE_TEXT"), GAME_JS.indexOf("function shareChallenge"),
    );
    assert.match(text, /Which came first\?/);
    // The sentence carries the URL and nothing computed from the reveal.
    assert.equal(/answer|year|gap|earlier|title/i.test(text), false, text);
    assert.ok(GAME_JS.includes("location.origin + '/challenge/' + question.id"));
    assert.ok(GAME_JS.includes("PP.share.sendLink("));
  });

  /** The three events, at the three moments the funnel is measured from. */
  it("counts the share, the open and the walk into the daily", () => {
    assert.ok(GAME_JS.includes("PP.track('pair_challenge_share'"));
    assert.ok(GAME_JS.includes("PP.track('pair_challenge_start'"));
    assert.ok(GAME_JS.includes("PP.track('pair_challenge_to_daily'"));
    // Counted at the tap, once, the way the result share already is -- not once
    // per fallback branch.
    assert.equal((GAME_JS.match(/pair_challenge_share/g) ?? []).length, 1);
    assert.equal((GAME_JS.match(/pair_challenge_start/g) ?? []).length, 1);
  });

  /**
   * A challenge writes nothing into the local record. The two calls that move
   * a streak or a passport are only reachable from the daily's own ending and
   * from an endless answer, and a challenge never reaches either.
   */
  it("never touches the daily's streak or the endless cursor", () => {
    for (const call of ["PP.recordDaily(", "PP.recordEndlessAnswer(", "PP.markEndlessPage("]) {
      const index = GAME_JS.indexOf(call);
      assert.ok(index > 0, `${call} is gone from the board`);
    }
    // The one place a daily is banked is the daily's own finish.
    const finish = GAME_JS.slice(
      GAME_JS.indexOf("function finishDaily"), GAME_JS.indexOf("function finishEndless"),
    );
    assert.ok(finish.includes("PP.recordDaily("));
    const challenge = GAME_JS.slice(
      GAME_JS.indexOf("function showChallengeOutcome"), GAME_JS.indexOf("/* ---------- advancing"),
    );
    assert.equal(/PP\.(recordDaily|recordEndlessAnswer|markEndlessPage|endEndlessRun)/.test(challenge), false);
  });
});

describe("achievement sharing", () => {
  it("reuses the one pipeline rather than growing a second", () => {
    assert.ok(STATS_JS.includes("PP.share.send("));
    assert.ok(!/canvas\.toBlob|navigator\.share/.test(STATS_JS));
    assert.ok(!/canvas\.toBlob|navigator\.share/.test(GAME_JS));
  });

  it("puts the name and the meaning on the card, and nothing from the record", () => {
    const card = STATS_JS.slice(
      STATS_JS.indexOf("function drawAchievementCard"),
      STATS_JS.indexOf("function wireAchievementShare"),
    );
    assert.ok(card.includes("PAST PERFECT"));
    assert.ok(card.includes("item.name"));
    assert.ok(card.includes("item.blurb"));
    // The local record is nobody else's business: no streak, no totals.
    assert.ok(!/record\.|earnedCount|item\.have|item\.progress/.test(card));
  });
});
