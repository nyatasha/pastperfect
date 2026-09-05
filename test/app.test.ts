/**
 * End-to-end checks against the HTTP application.
 *
 * The most important test here is "a question payload reveals nothing". In the
 * Python implementation that was the *only* defence. It is still here, because
 * a stray JSON.stringify could still leak, but it is now the second line: the
 * first is `assertQuestionSideIsMinimal` below, which the compiler checks.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import sharp from "sharp";

import { app } from "../src/app.ts";
import * as config from "../src/config.ts";
import type { QuestionSide } from "../src/contract.ts";
import { FORBIDDEN_BEFORE_ANSWER } from "../src/contract.ts";
import { MAX_ENDLESS_PAGE } from "../src/api.ts";
import * as daily from "../src/daily.ts";
import * as db from "../src/db.ts";
import { build } from "../src/pairs.ts";
import * as store from "../src/store.ts";
import { sandbox, teardown } from "./fixtures.ts";

/**
 * A compile-time assertion, not a runtime one.
 *
 * If anybody widens QuestionSide with a field that could identify an object,
 * `npm run typecheck` fails at this line -- before the code can ever run, let
 * alone leak. This is the guarantee the port was made for.
 */
type Exactly<T, Shape> = [keyof T] extends [keyof Shape] ? ([keyof Shape] extends [keyof T] ? true : never) : never;
const assertQuestionSideIsMinimal: Exactly<
  QuestionSide,
  { img: string; w: number | null; h: number | null; form: string; museum: string }
> = true;

async function call(
  method: string, path: string, body?: unknown,
): Promise<{ status: number; headers: Headers; text: string }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const response = await app.fetch(new Request(`http://localhost:8000${path}`, init));
  return { status: response.status, headers: response.headers, text: await response.text() };
}

const json = async (path: string): Promise<any> => JSON.parse((await call("GET", path)).text);

describe("pages", () => {
  before(async () => {
    await sandbox();
    build(11, () => {});
    daily.ensure(5, daily.today(), undefined, () => {});
  });
  after(teardown);

  it("compiles the contract assertion", () => {
    assert.equal(assertQuestionSideIsMinimal, true);
  });

  it("renders every public page", async () => {
    const paths = [
      "/", "/daily", "/endless", "/museums", "/how-to-play", "/about", "/rights",
      "/stats", "/robots.txt", "/sitemap.xml", "/manifest.webmanifest", "/sw.js",
      ...config.MUSEUM_ORDER.map((s) => `/museum/${s}`),
      ...config.MUSEUM_ORDER.map((s) => `/daily/${s}`),
      ...config.MUSEUM_ORDER.map((s) => `/endless/${s}`),
    ];
    for (const path of paths) {
      const res = await call("GET", path);
      assert.equal(res.status, 200, path);
      const floor = path.endsWith(".txt") ? 80 : 500;
      assert.ok(res.text.length > floor, `${path} was only ${res.text.length} bytes`);
    }
  });

  it("carries the metadata a search engine and a share preview need", async () => {
    for (const path of ["/", "/daily", "/museum/met", "/about"]) {
      const html = (await call("GET", path)).text;
      assert.ok(html.includes('<meta name="description"'), path);
      assert.ok(html.includes('rel="canonical"'), path);
      assert.ok(html.includes('property="og:image"'), path);
      assert.ok(html.includes("<title>"), path);
    }
  });

  /**
   * A share preview is server-rendered or it does not exist: WhatsApp, Slack
   * and the rest fetch the HTML and read the head, and none of them run the
   * page's JavaScript. So these assertions are deliberately made against the
   * bytes the server sends, before anything hydrates.
   */
  it("serves the home page's social card metadata in the server-rendered head", async () => {
    const html = (await call("GET", "/")).text;
    const head = html.slice(0, html.indexOf("</head>"));
    const meta = (kind: "property" | "name", key: string): string | null => {
      const found = head.match(
        new RegExp(`<meta ${kind}="${key}" content="([^"]*)">`),
      );
      return found ? found[1]! : null;
    };

    const image = `${config.site.baseUrl}${config.SOCIAL_IMAGE}`;
    assert.equal(meta("property", "og:title"), config.SOCIAL_TITLE);
    assert.equal(meta("property", "og:description"), config.SOCIAL_DESCRIPTION);
    assert.equal(meta("property", "og:type"), "website");
    assert.equal(meta("property", "og:url"), `${config.site.baseUrl}/`);
    assert.equal(meta("property", "og:image"), image);
    assert.equal(meta("property", "og:image:width"), "1200");
    assert.equal(meta("property", "og:image:height"), "630");
    assert.equal(meta("name", "twitter:card"), "summary_large_image");
    assert.equal(meta("name", "twitter:title"), config.SOCIAL_TITLE);
    assert.equal(meta("name", "twitter:description"), config.SOCIAL_DESCRIPTION);
    assert.equal(meta("name", "twitter:image"), image);

    // A crawler cannot resolve "/og/...". Every card URL has to be absolute.
    for (const url of [meta("property", "og:image"), meta("name", "twitter:image")]) {
      assert.ok(url?.startsWith("http"), `${url} is not an absolute URL`);
    }
  });

  /**
   * The card is a committed file rather than a rendered one, so the thing that
   * can break it is somebody deleting it or regenerating it at the wrong size.
   * Crawlers fetch it once and cache hard, and several of them drop a card
   * whose image 404s, so this is checked over HTTP and not just on disk.
   */
  it("serves the social card itself, at the size the tags claim", async () => {
    const response = await app.fetch(
      new Request(`http://localhost:8000${config.SOCIAL_IMAGE}`),
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^image\/png/);

    const file = path.join(config.STATIC_DIR, "img", "social.png");
    const size = await sharp(file).metadata();
    assert.equal(size.width, 1200);
    assert.equal(size.height, 630);
  });

  it("emits valid structured data", async () => {
    const html = (await call("GET", "/")).text;
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)];
    assert.ok(blocks.length >= 2);
    for (const block of blocks) assert.ok("@context" in JSON.parse(block[1]!));
  });

  it("404s unknown paths and unknown museums", async () => {
    for (const path of ["/nope", "/museum/louvre", "/endless/louvre", "/daily/louvre"]) {
      assert.equal((await call("GET", path)).status, 404, path);
    }
  });

  it("closes past puzzles", async () => {
    const res = await call("GET", "/daily/2020-01-01");
    assert.equal(res.status, 410);
    assert.ok(res.text.toLowerCase().includes("closed"));
  });

  it("redirects a trailing slash", async () => {
    const res = await call("GET", "/about/");
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "/about");
  });

  it("refuses to serve outside the static directory", async () => {
    assert.notEqual((await call("GET", "/static/../../src/config.ts")).status, 200);
    assert.notEqual((await call("GET", "/static/%2e%2e/%2e%2e/package.json")).status, 200);
  });

  it("renders no advertising", async () => {
    assert.equal(config.ADS_ENABLED, false);
    for (const path of ["/", "/daily", "/endless"]) {
      assert.ok(!(await call("GET", path)).text.includes('class="ad-slot"'), path);
    }
  });

  /**
   * The only third-party script on the site, and the only one there is ever a
   * reason for: page views and referrers, which the first-party events cannot
   * see because they do not fire until a round starts. It stays cookieless and
   * it stays exactly one tag -- that is the whole basis for having no consent
   * banner, so it is worth failing a build over.
   */
  it("carries the analytics tag, once, and nothing else third-party", async () => {
    const html = (await call("GET", "/")).text;
    const tags = [...html.matchAll(/<script[^>]*\bsrc="https?:\/\/[^"]+"/g)].map((m) => m[0]);
    assert.equal(tags.length, 1, `unexpected third-party scripts: ${tags.join(", ")}`);
    assert.ok(tags[0]!.includes(config.GOATCOUNTER_SCRIPT));
    assert.ok(html.includes(`data-goatcounter="${config.GOATCOUNTER}"`));
    assert.ok(config.GOATCOUNTER.startsWith("https://"));
  });

  it("sets the security headers", async () => {
    const res = await call("GET", "/");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.ok(res.headers.get("referrer-policy"));
  });

  it("lets every page switch theme", async () => {
    for (const path of ["/", "/daily", "/endless", "/museums", "/museum/met", "/about", "/stats"]) {
      const html = (await call("GET", path)).text;
      assert.ok(html.includes('id="theme-toggle"'), path);
      assert.ok(html.includes("pastperfect.theme"), path);
      assert.ok(html.includes('content="#FBF6EC" media="(prefers-color-scheme: light)"'), path);
      assert.ok(html.includes('content="#100F0D" media="(prefers-color-scheme: dark)"'), path);
    }
  });

  it("runs the theme bootstrap before the stylesheet", async () => {
    const html = (await call("GET", "/daily")).text;
    assert.ok(html.indexOf("pastperfect.theme") < html.indexOf("app.css"));
  });

  /**
   * The board's shell, before a byte of JavaScript runs.
   *
   * Two of these matter beyond "the markup exists". The zoom control has to be
   * a sibling of the choice button rather than a child of it -- nesting them
   * would make looking closer a way of answering, which is the bug it exists to
   * fix -- and the board needs the museum names client-side, because the
   * question payload carries slugs.
   */
  it("ships a board a player can read and zoom", async () => {
    for (const path of ["/daily", "/endless", "/daily/met"]) {
      const html = (await call("GET", path)).text;
      assert.ok(html.includes('id="museum-data"'), `${path} has no museum names`);
      for (const side of ["a", "b"]) {
        assert.ok(html.includes(`id="choice-${side}"`), path);
        assert.ok(html.includes(`data-zoom="${side}"`), `${path} cannot zoom ${side}`);
      }
      assert.equal(html.match(/data-kind/g)?.length, 2, `${path} labels both objects`);
      assert.ok(html.includes('id="lightbox"'), path);
      // A button inside a button is invalid, and would answer on a zoom.
      assert.ok(!/<button[^>]*>(?:(?!<\/button>)[\s\S])*?<button/.test(html), path);
    }
  });

  it("puts every way to play on the pages a player actually lands on", async () => {
    for (const path of ["/", "/daily", "/endless", "/museums"]) {
      const html = (await call("GET", path)).text;
      for (const slug of config.MUSEUM_ORDER) {
        assert.ok(html.includes(`href="/daily/${slug}"`), `${path} hides the ${slug} daily`);
        assert.ok(html.includes(`href="/endless/${slug}"`), `${path} hides the ${slug} endless`);
      }
    }
  });

  /**
   * A museum link is an aside, not an exit.
   *
   * The reveal used to link the museum straight to its collection page in the
   * same tab, so reading about the object you had just been shown threw away
   * the run you were in. The board no longer links it at all -- and the museum
   * links that remain on a game page (the footer credits, and the "about this
   * collection" line under each play card) open beside the game instead.
   */
  it("opens museum links beside a game rather than over it", async () => {
    for (const path of ["/daily", "/endless", "/daily/met", "/endless/met"]) {
      const html = (await call("GET", path)).text;
      for (const link of html.matchAll(/<a[^>]*href="\/museum\/[a-z]+"[^>]*>/g)) {
        assert.match(link[0], /target="_blank"/, `${path} leaves the game for ${link[0]}`);
        assert.match(link[0], /rel="noopener"/, `${path}: ${link[0]}`);
      }
      assert.ok(html.includes('href="/museum/'), `${path} has no museum link to check`);
    }
  });

  /**
   * No outbound link tells a museum where the player came from.
   *
   * This is not only manners. The Art Institute sits behind a firewall that
   * answers 403 to any request whose referrer names localhost -- scheme and
   * port make no difference, and no other museum in the mix does it -- so with
   * `Referrer-Policy: strict-origin-when-cross-origin` every "see the object"
   * link into artic.edu was a block page for anybody running the site locally.
   * Sending no referrer at all fixes that and leaks nothing either way.
   */
  it("sends no referrer to a museum", async () => {
    const paths = ["/", "/museums", "/about", "/rights", "/how-to-play",
      ...config.MUSEUM_ORDER.map((s) => `/museum/${s}`)];
    for (const path of paths) {
      const html = (await call("GET", path)).text;
      for (const link of html.matchAll(/<a[^>]*href="https?:[^"]*"[^>]*>/g)) {
        assert.match(link[0], /rel="[^"]*noreferrer/, `${path} leaks a referrer: ${link[0]}`);
      }
    }
  });

  /**
   * The board builds its museum links in JavaScript, under the same rule. Only
   * links that leave the site carry a `rel` at all, so every one of them here
   * has to name noreferrer.
   */
  it("sends no referrer from the reveal either", () => {
    const gameJs = fs.readFileSync(path.join(config.STATIC_DIR, "js", "game.js"), "utf8");
    const rels = [...gameJs.matchAll(/rel="[^"]*"/g)].map((match) => match[0]);
    assert.ok(rels.length >= 3, `only found ${rels.length} outbound links in game.js`);
    for (const rel of rels) {
      assert.match(rel, /noreferrer/, `game.js builds a link that leaks a referrer: ${rel}`);
    }
  });

  /**
   * Not every object has a museum page we trust -- a source that cannot build
   * a live URL stores an empty one -- and both places that offer "See the
   * object" have to ask before they print it. An `href=""` is not a dead end,
   * it is a reload of the game, which costs the player the run they are in.
   */
  it("offers no object link when there is no page to send anyone to", () => {
    const gameJs = fs.readFileSync(path.join(config.STATIC_DIR, "js", "game.js"), "utf8");
    const lines = gameJs.split("\n");
    let uses = 0;
    lines.forEach((line, index) => {
      if (!/href="'\s*\+\s*escapeAttr\(info\.objectUrl\)/.test(line)) return;
      uses++;
      const before = lines.slice(Math.max(0, index - 5), index).join("\n");
      assert.match(
        before,
        /(if \(info\.objectUrl\)|info\.objectUrl\s*$|info\.objectUrl\s*\?)/,
        `game.js line ${index + 1} links to an object page without checking there is one`,
      );
    });
    assert.equal(uses, 2, `expected both object links in game.js, found ${uses}`);
  });

  /**
   * The service worker must not be able to pin an old script.
   *
   * `/static/js/game.js` keeps its name across deploys, so a cache-first rule
   * with no revalidation freezes whichever copy a browser saw first -- which
   * is how a shipped fix to the museum links kept not reaching anybody. Only
   * `/img/`, whose paths are content hashes, may be answered from the cache
   * without asking the network.
   */
  it("never pins a shell script in the service worker", () => {
    const sw = fs.readFileSync(path.join(config.STATIC_DIR, "js", "sw.js"), "utf8");
    const staticBranch = sw.slice(sw.indexOf("'/static/'"));
    assert.match(staticBranch, /fetch\(/, "the service worker never revalidates /static/");
    assert.match(staticBranch, /cache: 'reload'/, "revalidation can be served from the HTTP cache");
    const imgBranch = sw.slice(sw.indexOf("'/img/'"), sw.indexOf("'/static/'"));
    assert.match(imgBranch, /hit \|\| fetch/, "images should stay cache-first");
  });

  /** Off a game page they are ordinary navigation again. */
  it("leaves museum links alone everywhere else", async () => {
    for (const path of ["/", "/museums", "/museum/met", "/about"]) {
      const html = (await call("GET", path)).text;
      const links = [...html.matchAll(/<a[^>]*href="\/museum\/[a-z]+"[^>]*>/g)];
      assert.ok(links.length > 0, path);
      assert.ok(links.some((link) => !link[0].includes("target=")), `${path} sends every museum link away`);
    }
  });

  /**
   * Endless has no last question, so the only way to finish a run deliberately
   * is a button. The handler has always been in game.js; the markup for it was
   * missing, which left navigating away as the only exit.
   */
  it("gives an endless run a way to end", async () => {
    for (const path of ["/endless", "/endless/met"]) {
      assert.ok((await call("GET", path)).text.includes('id="end-run"'), path);
    }
    for (const path of ["/daily", "/daily/met"]) {
      assert.ok(!(await call("GET", path)).text.includes('id="end-run"'), `${path} is not a run`);
    }
  });

  it("gives the stats page the museum names it renders a passport from", async () => {
    const html = (await call("GET", "/stats")).text;
    assert.ok(html.includes('id="museum-data"'));
    for (const slug of config.MUSEUM_ORDER) assert.ok(html.includes(`"${slug}"`), slug);
  });
});

describe("api", () => {
  before(async () => {
    await sandbox();
    build(11, () => {});
    daily.ensure(5, daily.today(), undefined, () => {});
  });
  after(teardown);

  it("shapes the daily round correctly", async () => {
    const data = await json("/api/round?mode=daily");
    assert.equal(data.total, config.DAILY_QUESTIONS);
    assert.equal(data.date, daily.today());
    for (const question of data.questions) {
      assert.deepEqual(Object.keys(question).sort(), ["a", "b", "id", "n"]);
      for (const side of ["a", "b"] as const) {
        assert.deepEqual(Object.keys(question[side]).sort(), ["form", "h", "img", "museum", "w"]);
        assert.match(question[side].img, /^\/img\/[0-9a-f]{20}\.jpg$/);
      }
    }
  });

  /** No title, maker, date or answer may appear before a guess. */
  it("reveals nothing that dates an object in a question payload", async () => {
    const raw = JSON.stringify((await json("/api/round?mode=daily")).questions).toLowerCase();
    for (const word of FORBIDDEN_BEFORE_ANSWER) {
      assert.ok(!raw.includes(word), `${word} leaked into the question payload`);
    }
    // Nothing that could be read as a date, either.
    assert.deepEqual([...raw.replace(/1100/g, "").matchAll(/(?<!\d)(1[0-9]{3})(?!\d)/g)].map((m) => m[1]), []);
  });

  /**
   * The two pieces of context a question is allowed to carry. Both are shown
   * before the player commits, so both have to be incapable of dating a thing:
   * `museum` is a known slug, and `form` is a noun with no digit in it.
   */
  it("names the form and the museum of each object up front", async () => {
    const data = await json("/api/round?mode=daily");
    for (const question of data.questions) {
      for (const side of ["a", "b"] as const) {
        assert.ok(config.MUSEUM_ORDER.includes(question[side].museum), question[side].museum);
        assert.match(question[side].form, /^[A-Z][A-Za-z ]{1,40}$/, question[side].form);
      }
    }
  });

  it("reveals everything once answered, and is right about which came first", async () => {
    const data = await json("/api/round?mode=daily");
    for (const question of data.questions) {
      const res = await call("POST", "/api/answer", { q: question.id, choice: "a", session: "answerallsession" });
      assert.equal(res.status, 200);
      const reveal = JSON.parse(res.text);
      assert.ok(["a", "b"].includes(reveal.earlier));
      assert.equal(reveal.correct, reveal.earlier === "a");
      assert.ok(reveal.insight);
      for (const side of ["a", "b"] as const) {
        for (const field of ["title", "date", "yearText", "museumName", "licence", "objectUrl"]) {
          assert.ok(field in reveal[side], `${field} missing from reveal`);
        }
      }
      const [earlier, later] = reveal.earlier === "a" ? [reveal.a, reveal.b] : [reveal.b, reveal.a];
      assert.ok(earlier.year < later.year);
    }
  });

  it("counts one session's repeated answers only once", async () => {
    // Measured as a delta, not an absolute: other tests in this file answer
    // the same questions under their own sessions, and each of those is
    // legitimately counted. What must not move is the second answer from the
    // same session.
    const question = (await json("/api/round?mode=daily")).questions.at(-1);
    const pairId = String(question.id).split(".")[0];
    const shown = (): number =>
      db.get<{ shown: number }>("SELECT shown FROM pair_stats WHERE pair_id = ?", [pairId])?.shown ?? 0;

    const before = shown();
    for (let i = 0; i < 3; i++) {
      await call("POST", "/api/answer", { q: question.id, choice: "b", session: "repeatsession" });
    }
    assert.equal(shown() - before, 1);
  });

  it("rejects malformed answers", async () => {
    const bad = [
      {}, { q: "nope", choice: "a" }, { q: `${"0".repeat(16)}.0`, choice: "c" },
      { q: "../../etc/passwd", choice: "a" },
    ];
    for (const payload of bad) {
      const status = (await call("POST", "/api/answer", payload)).status;
      assert.ok([400, 404].includes(status), JSON.stringify(payload));
    }
  });

  it("never repeats a question in endless", async () => {
    const seen = new Set<string>();
    for (let page = 0; page < 4; page++) {
      const data = await json(`/api/round?mode=endless&seed=endlessseed&page=${page}`);
      const ids = data.questions.map((q: { id: string }) => q.id.split(".")[0]);
      for (const id of ids) assert.ok(!seen.has(id), `page ${page} repeated a question`);
      for (const id of ids) seen.add(id);
    }
    assert.ok(seen.size > 8);
  });

  /**
   * Past the end, the pool says so.
   *
   * The page number used to be clamped, so asking for one beyond the cap served
   * the last page again -- for ever, to a client that keeps asking for the next
   * one. A run that silently loops re-counts objects the player has already
   * been shown, which is the one thing the local record must not do.
   */
  it("ends an endless run rather than looping the last page", async () => {
    for (const page of [MAX_ENDLESS_PAGE, MAX_ENDLESS_PAGE + 1, MAX_ENDLESS_PAGE * 9]) {
      const data = await json(`/api/round?mode=endless&seed=deepseed&page=${page}`);
      assert.deepEqual(data.questions, [], `page ${page} still served questions`);
      assert.equal(data.exhausted, true, `page ${page}`);
      // The page asked for comes back unchanged. A clamped number here is the
      // shape of the old bug: two different pages answered by the same eight.
      assert.equal(data.page, page, `page ${page} was answered as ${data.page}`);
    }
  });

  it("is stable for an endless seed", async () => {
    const first = (await json("/api/round?mode=endless&seed=stableseed&page=1")).questions.map((q: any) => q.id);
    const again = (await json("/api/round?mode=endless&seed=stableseed&page=1")).questions.map((q: any) => q.id);
    assert.deepEqual(first, again);
  });

  it("records a standing when a daily is completed", async () => {
    const res = await call("POST", "/api/daily/complete", {
      date: daily.today(), edition: "", score: 7, session: "completesession",
    });
    assert.equal(res.status, 200);
    const result = JSON.parse(res.text);
    assert.equal(result.score, 7);
    assert.equal(result.ranked, false, "ranked before the sample means anything");
    assert.equal(result.beat, null);
  });

  it("ranks a score once the sample is big enough", async () => {
    for (let i = 0; i < config.PERCENTILE_MIN_SAMPLE + 2; i++) {
      await call("POST", "/api/daily/complete", {
        date: daily.today(), edition: "", score: i % 11, session: `crowd${String(i).padStart(3, "0")}`,
      });
    }
    const res = await call("POST", "/api/daily/complete", {
      date: daily.today(), edition: "", score: 10, session: "lateplayer",
    });
    const result = JSON.parse(res.text);
    assert.equal(result.ranked, true);
    assert.equal(typeof result.beat, "number");
    assert.ok(result.beat > 0 && result.beat <= 100);
  });

  /**
   * How many people played today is an operator's number, not a player's. It
   * used to ship in this payload and get printed on the results screen; now it
   * is only readable through the token-protected metrics endpoint.
   */
  it("never tells a player how many people played", async () => {
    const res = await call("POST", "/api/daily/complete", {
      date: daily.today(), edition: "", score: 4, session: "privacysession",
    });
    const result = JSON.parse(res.text);
    assert.deepEqual(Object.keys(result).sort(), ["beat", "date", "puzzle", "ranked", "score"]);
    for (const leaked of ["players", "distribution", "minSample"]) {
      assert.ok(!(leaked in result), `${leaked} leaked to the client`);
    }
  });

  it("rejects impossible scores", async () => {
    for (const score of [-1, 11, "many", null, 1.5]) {
      const status = (await call("POST", "/api/daily/complete", {
        date: daily.today(), edition: "", score, session: "badsession",
      })).status;
      assert.equal(status, 400, String(score));
    }
  });

  it("accepts and stores events", async () => {
    assert.equal((await call("POST", "/api/events", {
      name: "unit_test_event", session: "eventsession", props: { a: 1 },
    })).status, 204);
    assert.ok(store.eventSummary().some((row) => row.name === "unit_test_event"));
  });

  /**
   * The metrics queries read `mode` out of the props blob, and SQLite's
   * json_extract raises on malformed text rather than shrugging. So a props bag
   * too big to store must be dropped whole, never truncated into something that
   * would take the whole report down with it.
   */
  it("never stores props that are not valid JSON", async () => {
    await call("POST", "/api/events", {
      name: "oversized_event", session: "bigsession", props: { blob: "x".repeat(4000) },
    });
    const row = db.get<{ props: string }>(
      "SELECT props FROM events WHERE name = 'oversized_event'",
    );
    assert.ok(row);
    assert.doesNotThrow(() => JSON.parse(row.props));
  });

  /**
   * `round_start` fires for both modes, so the daily/endless split lives in the
   * event's props. Without it, "rounds started" silently mixes the two and the
   * daily completion rate is unreadable.
   */
  it("splits the funnel by mode", async () => {
    process.env["PASTPERFECT_METRICS_TOKEN"] = "s3cret-operator-token";
    try {
      for (const mode of ["daily", "daily", "endless"]) {
        await call("POST", "/api/events", {
          name: "round_start", session: `funnel-${mode}`, props: { mode, edition: "" },
        });
      }
      const body = JSON.parse(
        (await call("GET", "/api/metrics?token=s3cret-operator-token")).text,
      );
      assert.equal(body.funnel.dailyStarts, 2);
      assert.equal(body.funnel.endlessStarts, 1);
      assert.equal(body.funnel.roundStarts, 3);
      assert.equal(typeof body.funnel.completionRate, "number");
      assert.equal(typeof body.funnel.errors, "number");
    } finally {
      delete process.env["PASTPERFECT_METRICS_TOKEN"];
    }
  });

  /**
   * The metrics door. Shut and invisible by default, because an operator
   * endpoint that announces itself is an invitation.
   */
  it("hides metrics unless an operator token is configured", async () => {
    delete process.env["PASTPERFECT_METRICS_TOKEN"];
    assert.equal((await call("GET", "/api/metrics")).status, 404);
    assert.equal((await call("GET", "/api/metrics?token=anything")).status, 404);
  });

  it("guards metrics with the token, and then serves them", async () => {
    process.env["PASTPERFECT_METRICS_TOKEN"] = "s3cret-operator-token";
    try {
      assert.equal((await call("GET", "/api/metrics")).status, 401);
      assert.equal((await call("GET", "/api/metrics?token=wrong")).status, 401);
      // Same length as the real token, so this fails on content, not on shape.
      assert.equal((await call("GET", "/api/metrics?token=s3cret-operator-tokeX")).status, 401);

      const res = await call("GET", "/api/metrics?token=s3cret-operator-token");
      assert.equal(res.status, 200);
      const body = JSON.parse(res.text);
      assert.equal(typeof body.totals.completionsEver, "number");
      assert.equal(body.today.date, daily.today());
      assert.ok(Array.isArray(body.days));
      assert.ok(Array.isArray(body.events));
      assert.equal(typeof body.retention.returning, "number");
    } finally {
      delete process.env["PASTPERFECT_METRICS_TOKEN"];
    }
  });

  it("reports health", async () => {
    const health = await json("/api/health");
    assert.equal(health.ok, true);
    assert.equal(health.adsEnabled, false);
  });

  it("refuses an unknown edition or museum", async () => {
    assert.equal((await call("GET", "/api/round?mode=daily&edition=louvre")).status, 404);
    assert.equal((await call("GET", "/api/round?mode=endless&museum=louvre")).status, 404);
    assert.equal((await call("GET", "/api/round?mode=daily&date=2020-01-01")).status, 410);
  });
});
