/**
 * End-to-end checks against the HTTP application.
 *
 * The most important test here is "a question payload reveals nothing". In the
 * Python implementation that was the *only* defence. It is still here, because
 * a stray JSON.stringify could still leak, but it is now the second line: the
 * first is `assertQuestionSideIsMinimal` below, which the compiler checks.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { app } from "../src/app.ts";
import * as config from "../src/config.ts";
import type { QuestionSide } from "../src/contract.ts";
import { FORBIDDEN_BEFORE_ANSWER } from "../src/contract.ts";
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
const assertQuestionSideIsMinimal: Exactly<QuestionSide, { img: string; w: number | null; h: number | null }> = true;

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
        assert.deepEqual(Object.keys(question[side]).sort(), ["h", "img", "w"]);
        assert.match(question[side].img, /^\/img\/[0-9a-f]{20}\.jpg$/);
      }
    }
  });

  /** No title, maker, date, museum or answer may appear before a guess. */
  it("reveals nothing in a question payload", async () => {
    const raw = JSON.stringify((await json("/api/round?mode=daily")).questions).toLowerCase();
    for (const word of FORBIDDEN_BEFORE_ANSWER) {
      assert.ok(!raw.includes(word), `${word} leaked into the question payload`);
    }
    // Nothing that could be read as a date, either.
    assert.deepEqual([...raw.replace(/1100/g, "").matchAll(/(?<!\d)(1[0-9]{3})(?!\d)/g)].map((m) => m[1]), []);
  });

  it("reveals everything once answered, and is right about which came first", async () => {
    const data = await json("/api/round?mode=daily");
    for (const question of data.questions) {
      const res = await call("POST", "/api/answer", { q: question.id, choice: "a", session: "unittestsession" });
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
    assert.ok(result.players >= 1);
    assert.equal(result.percentile, null, "percentile shown before it means anything");
  });

  it("shows a percentile once the sample is big enough", async () => {
    for (let i = 0; i < config.PERCENTILE_MIN_SAMPLE + 2; i++) {
      await call("POST", "/api/daily/complete", {
        date: daily.today(), edition: "", score: i % 11, session: `crowd${String(i).padStart(3, "0")}`,
      });
    }
    const res = await call("POST", "/api/daily/complete", {
      date: daily.today(), edition: "", score: 10, session: "lateplayer",
    });
    const result = JSON.parse(res.text);
    assert.ok(result.players >= config.PERCENTILE_MIN_SAMPLE);
    assert.equal(typeof result.percentile, "number");
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
