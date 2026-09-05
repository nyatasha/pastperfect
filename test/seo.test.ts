/**
 * What a crawler sees.
 *
 * Every assertion here is made against the bytes the server sends, before any
 * script runs, because that is all Googlebot and OAI-SearchBot commit to
 * reading. The things most likely to break quietly are the ones checked: a
 * sitemap that lists a URL which redirects or 404s, a canonical that points at
 * another page, a `noindex` that spreads to a page that wanted indexing, and a
 * robots.txt that closes a door somebody meant to leave open.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { app } from "../src/app.ts";
import * as config from "../src/config.ts";
import * as daily from "../src/daily.ts";
import { build } from "../src/pairs.ts";
import { esc } from "../src/render.ts";
import { sandbox, teardown } from "./fixtures.ts";

async function call(path: string): Promise<{ status: number; headers: Headers; text: string }> {
  const response = await app.fetch(new Request(`${config.site.baseUrl}${path}`));
  return { status: response.status, headers: response.headers, text: await response.text() };
}

const head = (html: string): string => html.slice(0, html.indexOf("</head>"));

function tag(html: string, kind: "name" | "property", key: string): string | null {
  const found = head(html).match(new RegExp(`<meta ${kind}="${key}" content="([^"]*)">`));
  return found ? found[1]! : null;
}

const titleOf = (html: string): string => head(html).match(/<title>([^<]*)<\/title>/)![1]!;

const canonicalOf = (html: string): string | null => {
  const found = head(html).match(/<link rel="canonical" href="([^"]*)">/);
  return found ? found[1]! : null;
};

function structured(html: string): Array<Record<string, unknown>> {
  return [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map(
    (block) => JSON.parse(block[1]!) as Record<string, unknown>,
  );
}

/** Everything the sitemap offers, which is also everything that may be indexed. */
function sitemapUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
}

describe("search engines", () => {
  before(async () => {
    await sandbox();
    build(11, () => {});
    daily.ensure(5, daily.today(), undefined, () => {});
  });
  after(teardown);

  // --- robots.txt ---------------------------------------------------------

  it("lets ordinary search crawlers in and points them at the sitemap", async () => {
    const res = await call("/robots.txt");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
    assert.match(res.text, /^User-agent: \*$/m);
    assert.match(res.text, /^Allow: \/$/m);
    assert.equal(res.text.includes(`Sitemap: ${config.site.baseUrl}/sitemap.xml`), true);

    // The one rule that would undo all of this.
    assert.equal(/^Disallow: \/$/m.test(res.text), false);
    for (const bot of ["Googlebot", "Bingbot", "DuckDuckBot"]) {
      assert.equal(res.text.includes(`Disallow: ${bot}`), false);
      assert.equal(new RegExp(`^User-agent: ${bot}$`, "m").test(res.text), false);
    }
  });

  /**
   * ChatGPT Search, named on purpose. A named group is not inherited from `*`,
   * so if this group ever loses its `Allow: /` the crawler is left with no rule
   * at all -- which is why the group is asserted whole rather than by keyword.
   */
  it("names OAI-SearchBot and allows it everything a reader can see", async () => {
    const text = (await call("/robots.txt")).text;
    const group = text.split(/\n\s*\n/).find((block) => block.includes("User-agent: OAI-SearchBot"));
    assert.ok(group, "no OAI-SearchBot group in robots.txt");
    assert.match(group, /^Allow: \/$/m);
    assert.match(group, /^Disallow: \/api\/$/m);
    assert.equal(/^Disallow: \/$/m.test(group), false);
  });

  it("keeps the API out of the index without blocking any page", async () => {
    const text = (await call("/robots.txt")).text;
    assert.match(text, /^Disallow: \/api\/$/m);
    // /stats is kept crawlable so its own noindex can actually be read.
    assert.equal(/^Disallow: \/stats$/m.test(text), false);
  });

  // --- sitemap ------------------------------------------------------------

  it("lists only absolute URLs on this site, with no duplicates or queries", async () => {
    const res = await call("/sitemap.xml");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /xml/);

    const urls = sitemapUrls(res.text);
    assert.ok(urls.length >= 15, `only ${urls.length} URLs in the sitemap`);
    assert.equal(new Set(urls).size, urls.length, "the sitemap repeats a URL");
    for (const url of urls) {
      assert.ok(url.startsWith(`${config.site.baseUrl}/`), `${url} is not absolute`);
      assert.equal(url.includes("?"), false, `${url} carries a query string`);
      assert.equal(url.endsWith("/") && url !== `${config.site.baseUrl}/`, false, `${url} has a trailing slash`);
    }
  });

  it("offers the permanent pages a reader would search for", async () => {
    const urls = sitemapUrls((await call("/sitemap.xml")).text);
    const expected = [
      "/", "/daily", "/endless", "/museums", "/how-to-play", "/about", "/rights",
      ...config.MUSEUM_ORDER.map((slug) => `/museum/${slug}`),
    ];
    for (const path of expected) {
      assert.ok(urls.includes(`${config.site.baseUrl}${path}`), `${path} is missing from the sitemap`);
    }
  });

  it("offers nothing transient, private or dated", async () => {
    const urls = sitemapUrls((await call("/sitemap.xml")).text);
    for (const url of urls) {
      assert.equal(url.includes("/stats"), false, `${url} is a private page`);
      assert.equal(/\/daily\/\d{4}-\d{2}-\d{2}/.test(url), false, `${url} is a dated puzzle`);
      assert.equal(url.includes("/api/"), false, `${url} is an API endpoint`);
    }
  });

  /**
   * The expensive test, and the one worth having: every URL offered is fetched.
   * A sitemap entry that redirects, 404s, or canonicalises somewhere else is
   * the single most common way a site quietly stops being indexed.
   */
  it("serves every URL it offers, at that URL, indexable", async () => {
    const urls = sitemapUrls((await call("/sitemap.xml")).text);
    for (const url of urls) {
      const path = url.slice(config.site.baseUrl.length);
      const res = await call(path);
      assert.equal(res.status, 200, `${path} answered ${res.status}`);
      assert.equal(canonicalOf(res.text), url, `${path} canonicalises elsewhere`);
      assert.equal(tag(res.text, "name", "robots"), "index, follow", `${path} is not indexable`);
    }
  });

  // --- per-page metadata --------------------------------------------------

  it("gives the home page a title and description that say what the site is", async () => {
    const html = (await call("/")).text;
    // Read back out of the HTML, so the "&" arrives as the entity it must be.
    assert.equal(titleOf(html), esc(config.HOME_TITLE));
    assert.equal(tag(html, "name", "description"), config.HOME_DESCRIPTION);
    // The site name, said once.
    assert.equal(titleOf(html).split(config.SITE_NAME).length - 1, 1);
    for (const museum of ["The Met", "Art Institute of Chicago", "Wellcome Collection", "Rijksmuseum"]) {
      assert.ok(config.HOME_DESCRIPTION.includes(museum), `${museum} is not in the home description`);
    }
  });

  it("gives every indexable page a unique title and description", async () => {
    const urls = sitemapUrls((await call("/sitemap.xml")).text);
    const titles = new Map<string, string>();
    const descriptions = new Map<string, string>();
    for (const url of urls) {
      const path = url.slice(config.site.baseUrl.length);
      const html = (await call(path)).text;
      const title = titleOf(html);
      const description = tag(html, "name", "description") ?? "";

      assert.ok(title.length > 0 && title.length < 120, `${path} has a ${title.length}-character title`);
      assert.ok(description.length > 40, `${path} has a thin description`);
      assert.equal(titles.get(title), undefined, `${path} repeats the title of ${titles.get(title)}`);
      assert.equal(
        descriptions.get(description), undefined,
        `${path} repeats the description of ${descriptions.get(description)}`,
      );
      titles.set(title, path);
      descriptions.set(description, path);
    }
  });

  /** Nobody searches for "the Met" hoping to find us -- but "the Met game" is ours. */
  it("says on each collection page what Past Perfect does with that collection", async () => {
    for (const slug of config.MUSEUM_ORDER) {
      const museum = config.MUSEUMS[slug]!;
      const html = (await call(`/museum/${slug}`)).text;
      const title = titleOf(html);
      assert.ok(title.includes(museum.shortName), `${slug} title does not name the museum`);
      assert.ok(/game/i.test(title), `${slug} title does not say it is a game`);
      // Case-insensitive: mid-sentence, "The Met..." reads as "the Met...".
      const description = (tag(html, "name", "description") ?? "").toLowerCase();
      assert.ok(
        description.includes(museum.name.toLowerCase().replace(/^the /, "")),
        `${slug} description does not name the museum`,
      );
    }
  });

  it("keeps the private and the missing out of the index, and everything else in", async () => {
    assert.equal(tag((await call("/stats")).text, "name", "robots"), "noindex, follow");
    const missing = await call("/nope");
    assert.equal(missing.status, 404);
    assert.equal(tag(missing.text, "name", "robots"), "noindex, nofollow");
    const closed = await call("/daily/2020-01-01");
    assert.equal(closed.status, 410);
    assert.equal(tag(closed.text, "name", "robots"), "noindex, follow");
  });

  /**
   * A dated puzzle is the same ten questions as `/daily`, at a second URL. It
   * has to say so, or the two compete with each other.
   */
  it("points a dated puzzle at /daily rather than at itself", async () => {
    const html = (await call(`/daily/${daily.today()}`)).text;
    assert.equal(canonicalOf(html), `${config.site.baseUrl}/daily`);
  });

  it("resolves every canonical to an absolute URL on this site", async () => {
    for (const path of ["/", "/daily", "/endless/met", "/museum/rijksmuseum", "/about", "/stats"]) {
      const canonical = canonicalOf((await call(path)).text);
      assert.ok(canonical?.startsWith(config.site.baseUrl), `${path}: ${canonical}`);
      assert.equal(canonical?.includes("localhost") && !config.site.baseUrl.includes("localhost"), false);
    }
  });

  // --- structured data ----------------------------------------------------

  it("describes the site and the game in JSON-LD", async () => {
    const blocks = structured((await call("/")).text);
    for (const block of blocks) assert.equal(block["@context"], "https://schema.org");

    const types = blocks.map((block) => block["@type"]);
    assert.ok(types.includes("WebSite"), "no WebSite node");

    const application = blocks.find((block) => {
      const type = block["@type"];
      return Array.isArray(type) && type.includes("WebApplication");
    });
    assert.ok(application, "no WebApplication node");
    assert.equal(application.applicationCategory, "GameApplication");
    assert.equal(application.url, config.site.baseUrl);
    assert.equal(application.isAccessibleForFree, true);
    assert.deepEqual(application.offers, { "@type": "Offer", price: "0", priceCurrency: "USD" });

    // Nothing we do not have: no invented ratings, reviews or publisher.
    for (const block of blocks) {
      for (const invented of ["aggregateRating", "review", "ratingValue", "publisher", "author"]) {
        assert.equal(invented in block, false, `${invented} is asserted without evidence`);
      }
    }
  });

  it("keeps every collection page's structured data pointing at itself", async () => {
    for (const slug of config.MUSEUM_ORDER) {
      const blocks = structured((await call(`/museum/${slug}`)).text);
      const collection = blocks.find((block) => block["@type"] === "CollectionPage");
      assert.ok(collection, `${slug} has no CollectionPage node`);
      assert.equal(collection.url, `${config.site.baseUrl}/museum/${slug}`);
    }
  });

  // --- what has to be in the HTML before anything runs ---------------------

  /**
   * The whole point of rendering on the server. If the explanatory copy ever
   * moves into a script, a crawler is left with an empty shell -- and so is
   * anybody whose JavaScript did not arrive.
   */
  it("gives every indexable page exactly one h1, in order", async () => {
    const urls = sitemapUrls((await call("/sitemap.xml")).text);
    for (const url of urls) {
      const path = url.slice(config.site.baseUrl.length);
      const html = (await call(path)).text;
      const h1 = [...html.matchAll(/<h1[^>]*>/g)];
      assert.equal(h1.length, 1, `${path} has ${h1.length} <h1> elements`);

      // No level skipped on the way down: h3 never arrives before an h2.
      const levels = [...html.matchAll(/<h([1-6])[^>]*>/g)].map((m) => Number(m[1]));
      let deepest = 0;
      for (const level of levels) {
        assert.ok(level <= deepest + 1, `${path} jumps from h${deepest} to h${level}`);
        deepest = Math.max(deepest, level);
      }
    }
  });

  it("puts the copy and the links in the first response", async () => {
    for (const path of ["/", "/museums", "/how-to-play", "/museum/met"]) {
      const html = (await call(path)).text;
      const body = html.slice(html.indexOf("<main"));
      const words = body.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").split(/\s+/);
      assert.ok(words.length > 120, `${path} renders only ${words.length} words of text`);

      // Navigation a crawler can follow, not an onclick.
      assert.ok(html.includes('<a href="/how-to-play"'), `${path} has no crawlable footer links`);
    }
  });

  it("links every collection from a plain anchor", async () => {
    const html = (await call("/museums")).text;
    for (const slug of config.MUSEUM_ORDER) {
      assert.ok(html.includes(`href="/museum/${slug}"`), `${slug} is not linked from /museums`);
      assert.ok(html.includes(`href="/daily/${slug}"`), `${slug}'s daily is not linked from /museums`);
    }
  });

  /** The social card work, which the SEO metadata sits alongside and must not disturb. */
  it("still serves the share preview tags the card work put there", async () => {
    const html = (await call("/")).text;
    assert.equal(tag(html, "property", "og:title"), config.SOCIAL_TITLE);
    assert.equal(tag(html, "property", "og:description"), config.SOCIAL_DESCRIPTION);
    assert.equal(tag(html, "property", "og:image"), `${config.site.baseUrl}${config.SOCIAL_IMAGE}`);
    assert.equal(tag(html, "name", "twitter:card"), "summary_large_image");
  });
});
