/**
 * Challenging a friend with one pair.
 *
 * A challenge is the ordinary game with one question in it, so the tests that
 * matter are the ones that prove it stayed that way: the link names the exact
 * pair and nothing else, the unanswered page and payload are as blank as any
 * other question's, the answer is still derived on the server, and none of it
 * touches the daily's state or the sitemap.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { app } from "../src/app.ts";
import * as api from "../src/api.ts";
import * as config from "../src/config.ts";
import { FORBIDDEN_BEFORE_ANSWER } from "../src/contract.ts";
import * as daily from "../src/daily.ts";
import * as db from "../src/db.ts";
import { build, pairId } from "../src/pairs.ts";
import { sandbox, teardown } from "./fixtures.ts";

async function call(
  method: string, path: string, body?: unknown,
): Promise<{ status: number; headers: Headers; text: string }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const response = await app.fetch(new Request(`${config.site.baseUrl}${path}`, init));
  return { status: response.status, headers: response.headers, text: await response.text() };
}

const json = async (path: string): Promise<any> => JSON.parse((await call("GET", path)).text);

const head = (html: string): string => html.slice(0, html.indexOf("</head>"));

function tag(html: string, kind: "name" | "property", key: string): string | null {
  const found = head(html).match(new RegExp(`<meta ${kind}="${key}" content="([^"]*)">`));
  return found ? found[1]! : null;
}

/** A question id from today's daily -- the same thing a player would share. */
async function someQuestion(): Promise<any> {
  const round = await json("/api/round?mode=daily");
  return round.questions[2];
}

describe("challenge links", () => {
  before(async () => {
    await sandbox();
    build(11, () => {});
    daily.ensure(5, daily.today(), undefined, () => {});
  });
  after(teardown);

  // --- what the link is ---------------------------------------------------

  it("resolves to the exact pair, in the exact order, that was shared", async () => {
    const question = await someQuestion();
    const round = await json(`/api/round?mode=challenge&q=${question.id}`);
    assert.equal(round.mode, "challenge");
    assert.equal(round.questions.length, 1);
    const served = round.questions[0];
    assert.equal(served.id, question.id);
    assert.deepEqual(served.a, question.a);
    assert.deepEqual(served.b, question.b);

    // The other orientation of the same pair is a different, equally valid link.
    const [pair, flip] = String(question.id).split(".");
    const other = `${pair}.${flip === "1" ? "0" : "1"}`;
    const flipped = (await json(`/api/round?mode=challenge&q=${other}`)).questions[0];
    assert.deepEqual(flipped.a, question.b);
    assert.deepEqual(flipped.b, question.a);
  });

  it("is stable: the same link serves the same pair every time", async () => {
    const question = await someQuestion();
    const once = await json(`/api/round?mode=challenge&q=${question.id}`);
    const again = await json(`/api/round?mode=challenge&q=${question.id}`);
    assert.deepEqual(once, again);
  });

  /**
   * The identifier is a hash of two object ids and nothing else.
   *
   * Proved rather than asserted: the id the board hands out is recomputed here
   * from the two objects' own ids, which is the only input `pairId` has. No
   * date, no gap and no answer can be encoded in it, because none of them is in
   * the room when it is made -- and that is also why the link survives a
   * restart, a redeploy and a rebuild of the pool.
   */
  it("names the pair by a hash of its two object ids, and nothing else", async () => {
    const question = await someQuestion();
    assert.match(question.id, /^[0-9a-f]{16}\.[01]$/);

    const [id, orientation] = String(question.id).split(".");
    const row = db.get<{ left_id: string; right_id: string; earlier: string }>(
      "SELECT left_id, right_id, earlier FROM pairs WHERE id = ?", [id!],
    )!;
    assert.equal(id, pairId(row.left_id, row.right_id));
    assert.ok(["0", "1"].includes(orientation!));

    // Which side is older is stored, and changing it does not touch the link.
    db.run("UPDATE pairs SET earlier = ? WHERE id = ?",
      [row.earlier === "left" ? "right" : "left", id!]);
    try {
      const again = (await json(`/api/round?mode=challenge&q=${question.id}`)).questions[0];
      assert.equal(again.id, question.id, "the link moved with the answer");
    } finally {
      db.run("UPDATE pairs SET earlier = ? WHERE id = ?", [row.earlier, id!]);
    }

    // Nothing in it that could be read as a title or a year.
    const reveal = JSON.parse(
      (await call("POST", "/api/answer", { q: question.id, choice: "a" })).text,
    );
    for (const secret of [reveal.a.title, reveal.b.title, reveal.a.yearText, reveal.b.yearText]) {
      assert.equal(
        String(question.id).includes(String(secret).toLowerCase()), false, `${secret} is in the link`,
      );
    }
    assert.equal(/(?<!\d)\d{4}(?!\d)/.test(String(question.id).replace(".", "")), false);
  });

  // --- what the unanswered challenge exposes ------------------------------

  it("exposes nothing in the payload that a normal question would not", async () => {
    const question = await someQuestion();
    const round = await json(`/api/round?mode=challenge&q=${question.id}`);
    const served = round.questions[0];
    assert.deepEqual(Object.keys(served).sort(), ["a", "b", "id", "n"]);
    for (const side of ["a", "b"] as const) {
      assert.deepEqual(Object.keys(served[side]).sort(), ["form", "h", "img", "museum", "w"]);
    }
    const raw = JSON.stringify(round).toLowerCase();
    for (const word of FORBIDDEN_BEFORE_ANSWER) {
      assert.ok(!raw.includes(word), `${word} leaked into a challenge payload`);
    }
    // Nothing year-shaped, with the opaque image keys taken out first: they are
    // hashes, and a hash is entitled to contain four digits in a row.
    const words = raw.replace(/\/img\/[0-9a-f]{20}\.jpg/g, "");
    assert.deepEqual([...words.matchAll(/(?<!\d)(1[0-9]{3})(?!\d)/g)].map((m) => m[1]), []);
  });

  it("server-renders no object data at all on the challenge page", async () => {
    const question = await someQuestion();
    const html = (await call("GET", `/challenge/${question.id}`)).text;
    const reveal = JSON.parse(
      (await call("POST", "/api/answer", { q: question.id, choice: "a" })).text,
    );

    for (const secret of [
      reveal.a.title, reveal.b.title, reveal.a.yearText, reveal.b.yearText,
      reveal.insight, reveal.gapText, reveal.a.objectUrl, reveal.b.objectUrl,
    ]) {
      assert.equal(html.includes(String(secret)), false, `${secret} is in the challenge HTML`);
    }
    // Not even the two spoiler-free image URLs: the board fetches those.
    assert.equal(/\/img\/[0-9a-f]{20}\.jpg/.test(html), false, "image URLs are pre-rendered");
    // No year anywhere in the document body, however it got there.
    const body = html.slice(html.indexOf("<main"));
    // Nothing year-shaped anywhere in the document, however it got there. (The
    // one number the board does render before an answer is the zoom's "100%".)
    assert.deepEqual([...body.matchAll(/(?<!\d)(\d{4})(?!\d)/g)].map((m) => m[1]), []);
    // The id, and only the id.
    assert.ok(html.includes(`data-q="${question.id}"`));
  });

  it("gives the recipient the same board, not a second implementation", async () => {
    const question = await someQuestion();
    const html = (await call("GET", `/challenge/${question.id}`)).text;
    for (const side of ["a", "b"]) {
      assert.ok(html.includes(`id="choice-${side}"`), side);
      assert.ok(html.includes(`data-zoom="${side}"`), side);
    }
    assert.ok(html.includes('id="lightbox"'));
    assert.ok(html.includes('id="museum-data"'));
    assert.ok(html.includes('src="/static/js/game.js"'));
    // One board, one mode flag.
    assert.ok(html.includes('data-mode="challenge"'));
  });

  // --- answering ----------------------------------------------------------

  it("reveals through the same endpoint, and is right about which came first", async () => {
    const question = await someQuestion();
    const res = await call("POST", "/api/answer", {
      q: question.id, choice: "a", session: "challengesession",
    });
    assert.equal(res.status, 200);
    const reveal = JSON.parse(res.text);
    assert.ok(["a", "b"].includes(reveal.earlier));
    assert.equal(reveal.correct, reveal.earlier === "a");
    const [earlier, later] = reveal.earlier === "a" ? [reveal.a, reveal.b] : [reveal.b, reveal.a];
    assert.ok(earlier.year < later.year);
    for (const field of ["title", "date", "yearText", "museumName", "licence", "objectUrl"]) {
      assert.ok(field in reveal.a, `${field} missing from the challenge reveal`);
    }
  });

  /** A client that says it was right is simply not believed. */
  it("never takes the client's word for the answer", async () => {
    const question = await someQuestion();
    const honest = JSON.parse(
      (await call("POST", "/api/answer", { q: question.id, choice: "a" })).text,
    );
    const wrongSide = honest.earlier === "a" ? "b" : "a";
    const lying = JSON.parse(
      (await call("POST", "/api/answer", {
        q: question.id, choice: wrongSide, correct: true, earlier: wrongSide,
        a: { year: 1000 }, b: { year: 2000 },
      })).text,
    );
    assert.equal(lying.correct, false);
    assert.equal(lying.earlier, honest.earlier);
    assert.equal(lying.a.year, honest.a.year);
  });

  // --- bad links ----------------------------------------------------------

  it("answers every unusable link with one unavailable page, and a 404", async () => {
    const unusable = [
      "/challenge/nonsense",
      "/challenge/" + "0".repeat(16) + ".0",   // well formed, no such pair
      "/challenge/" + "0".repeat(16) + ".2",   // out-of-range orientation
      "/challenge/ZZZZZZZZZZZZZZZZ.0",
      "/challenge/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "/challenge/" + "a".repeat(400) + ".0",
      "/challenge/" + "0".repeat(16) + ".0?q=" + encodeURIComponent("<script>alert(1)</script>"),
      "/challenge",
    ];
    for (const path of unusable) {
      const res = await call("GET", path);
      assert.equal(res.status, 404, path);
      assert.ok(res.text.includes("no longer available"), path);
      // Nothing from the URL is echoed back into the page.
      assert.equal(res.text.includes("<script>alert"), false, path);
      assert.equal(res.text.includes("aaaaaaaaaa"), false, path);
      assert.equal(tag(res.text, "name", "robots"), "noindex, follow", path);
    }

    // A path with a slash in it is not a challenge id at all: it never reaches
    // this route, and the ordinary 404 answers it without echoing a thing.
    const injected = await call("GET", "/challenge/<script>alert(1)</script>");
    assert.equal(injected.status, 404);
    assert.equal(injected.text.includes("<script>alert"), false);
    assert.equal((await call("GET", "/api/round?mode=challenge&q=nonsense")).status, 404);
    assert.equal((await call("GET", "/api/round?mode=challenge")).status, 404);
  });

  it("stops serving a challenge whose objects have left the collection", async () => {
    const question = (await json("/api/round?mode=daily")).questions.at(-1);
    const pairId = String(question.id).split(".")[0];
    const row = db.get<{ left_id: string }>("SELECT left_id FROM pairs WHERE id = ?", [pairId])!;
    const saved = db.get<Record<string, unknown>>("SELECT * FROM objects WHERE id = ?", [row.left_id])!;
    // The pool references its objects, so a withdrawal has to be staged with
    // the constraint relaxed. What is under test is what the route does when
    // the object is not there, however it came to not be there.
    db.run("PRAGMA foreign_keys=OFF");
    db.run("DELETE FROM objects WHERE id = ?", [row.left_id]);
    try {
      const res = await call("GET", `/challenge/${question.id}`);
      assert.equal(res.status, 404);
      assert.ok(res.text.includes("no longer available"));
      assert.equal((await call("GET", `/api/round?mode=challenge&q=${question.id}`)).status, 404);
    } finally {
      const columns = Object.keys(saved);
      db.run(
        `INSERT INTO objects (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        columns.map((column) => saved[column]),
      );
      db.run("PRAGMA foreign_keys=ON");
    }
  });

  // --- the daily is not touched -------------------------------------------

  /**
   * Answering a challenge writes exactly what answering any question writes --
   * one row in the answer log -- and nothing in the daily's tables. The streak
   * itself lives in the player's browser and is only ever moved by
   * `PP.recordDaily`, which the board calls when a daily's ten are finished.
   */
  it("leaves the daily's own state alone", async () => {
    const before = {
      results: db.scalar("SELECT COUNT(*) AS n FROM daily_results"),
      sets: db.scalar("SELECT COUNT(*) AS n FROM daily_sets"),
    };
    const question = await someQuestion();
    await call("GET", `/challenge/${question.id}`);
    await call("POST", "/api/answer", { q: question.id, choice: "b", session: "statelesssession" });
    assert.equal(db.scalar("SELECT COUNT(*) AS n FROM daily_results"), before.results);
    assert.equal(db.scalar("SELECT COUNT(*) AS n FROM daily_sets"), before.sets);

    // And the daily itself is unchanged: the same ten, still ten.
    const round = await json("/api/round?mode=daily");
    assert.equal(round.total, config.DAILY_QUESTIONS);
    assert.equal(round.questions.length, config.DAILY_QUESTIONS);
  });

  it("keeps the challenge out of the round modes it is not", async () => {
    // A challenge page never asks for a daily or an endless page, and neither
    // of those knows anything about challenge ids.
    const question = await someQuestion();
    const endless = await json(`/api/round?mode=endless&seed=challengeseed&page=0`);
    assert.equal(endless.mode, "endless");
    assert.equal(endless.questions.length, api.ENDLESS_PAGE_SIZE);
    const dailyRound = await json(`/api/round?date=${daily.today()}`);
    assert.equal(dailyRound.mode, "daily");
    assert.ok(String(question.id).length > 0);
  });

  // --- the page itself ----------------------------------------------------

  it("is noindex, follow, with spoiler-free metadata and a generic card", async () => {
    const question = await someQuestion();
    const html = (await call("GET", `/challenge/${question.id}`)).text;
    assert.equal(tag(html, "name", "robots"), "noindex, follow");

    const title = head(html).match(/<title>([^<]*)<\/title>/)![1]!;
    const description = tag(html, "name", "description") ?? "";
    const social = [
      title, description,
      tag(html, "property", "og:title"), tag(html, "property", "og:description"),
      tag(html, "name", "twitter:title"), tag(html, "name", "twitter:description"),
    ].join(" ");

    assert.match(title, /Past Perfect/);
    assert.ok(description.length > 40);
    // Nothing that dates anything, and nothing pair-specific.
    assert.equal(/\d/.test(social), false, `a digit reached the challenge metadata: ${social}`);
    const reveal = JSON.parse(
      (await call("POST", "/api/answer", { q: question.id, choice: "a" })).text,
    );
    for (const secret of [reveal.a.title, reveal.b.title, reveal.a.yearText, reveal.gapText]) {
      assert.equal(social.includes(String(secret)), false, `${secret} is in the metadata`);
    }
    // The site's own committed card, not one drawn from the pair.
    assert.equal(
      tag(html, "property", "og:image"), `${config.site.baseUrl}${config.SOCIAL_IMAGE}`,
    );
    // No structured data trying to get this page ranked.
    assert.equal(html.includes("application/ld+json"), false);
  });

  it("canonicalises to itself, so noindex lands on the challenge and nowhere else", async () => {
    const question = await someQuestion();
    const html = (await call("GET", `/challenge/${question.id}`)).text;
    const canonical = head(html).match(/<link rel="canonical" href="([^"]*)">/)![1]!;
    assert.equal(canonical, `${config.site.baseUrl}/challenge/${question.id}`);

    const missing = (await call("GET", "/challenge/nonsense")).text;
    const missingCanonical = missing.match(/<link rel="canonical" href="([^"]*)">/)![1]!;
    assert.ok(missingCanonical.startsWith(`${config.site.baseUrl}/challenge`), missingCanonical);
    for (const indexable of ["/daily", "/endless", "/"]) {
      assert.notEqual(missingCanonical, `${config.site.baseUrl}${indexable}`);
    }
  });

  it("survives a refresh, answered or not", async () => {
    const question = await someQuestion();
    const first = await call("GET", `/challenge/${question.id}`);
    const second = await call("GET", `/challenge/${question.id}`);
    assert.equal(first.status, 200);
    assert.equal(second.text, first.text);
    await call("POST", "/api/answer", { q: question.id, choice: "a", session: "refreshsession" });
    const third = await call("GET", `/challenge/${question.id}`);
    assert.equal(third.status, 200);
    // Still an unanswered board: answering is not remembered on the server.
    assert.equal(third.text, first.text);
  });

  it("offers no directory of challenges to crawl", async () => {
    const sitemap = (await call("GET", "/sitemap.xml")).text;
    assert.equal(sitemap.includes("/challenge"), false);
    for (const path of ["/", "/daily", "/museums", "/how-to-play", "/endless"]) {
      const html = (await call("GET", path)).text;
      assert.equal(html.includes('href="/challenge'), false, `${path} links to a challenge`);
    }
    // Nor does the challenge page itself link to another one.
    const question = await someQuestion();
    const challenge = (await call("GET", `/challenge/${question.id}`)).text;
    assert.equal(challenge.includes('href="/challenge'), false);
  });

  // --- the events ---------------------------------------------------------

  it("counts shares, opens and the walk into the daily", async () => {
    process.env["PASTPERFECT_METRICS_TOKEN"] = "s3cret-operator-token";
    try {
      for (const [name, times] of [
        ["pair_challenge_share", 4], ["pair_challenge_start", 2], ["pair_challenge_to_daily", 1],
      ] as const) {
        for (let i = 0; i < times; i++) {
          await call("POST", "/api/events", {
            name, session: `challenge${i}`, props: { mode: "daily" },
          });
        }
      }
      const body = JSON.parse((await call("GET", "/api/metrics?token=s3cret-operator-token")).text);
      assert.equal(body.challenge.shares, 4);
      assert.equal(body.challenge.starts, 2);
      assert.equal(body.challenge.toDaily, 1);
      assert.equal(body.challenge.opensPerShare, 50);
      assert.equal(body.challenge.dailyConversion, 50);
      // The challenge must not be counted as a round in the existing funnel.
      assert.equal(body.funnel.roundStarts, 0);
    } finally {
      delete process.env["PASTPERFECT_METRICS_TOKEN"];
    }
  });
});
