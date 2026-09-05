/** The HTTP application: routing, static files and the small non-page endpoints. */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";

import * as api from "./api.ts";
import * as config from "./config.ts";
import * as daily from "./daily.ts";
import * as media from "./media.ts";
import * as metrics from "./metrics.ts";
import * as og from "./og.ts";
import * as views from "./views.ts";

const DATE = "\\d{4}-\\d{2}-\\d{2}";
const IMAGE_KEY = /^[0-9a-f]{20}$/;

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

export const app = new Hono();

function html(body: string, status = 200, cache = 0): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": cache ? `public, max-age=${cache}` : "no-store",
    },
  });
}

function json(payload: unknown, status = 200): Response {
  if (status === 204) return new Response(null, { status: 204 });
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function sendFile(file: string, cache = 3600, contentType?: string): Promise<Response> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    return html(views.notFound(), 404);
  }
  const type = contentType ?? MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  return new Response(await fsp.readFile(file), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(stat.size),
      "Cache-Control": `public, max-age=${cache}`,
    },
  });
}

// --- middleware -----------------------------------------------------------

app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    return c.redirect(url.pathname.replace(/\/+$/, "") + url.search, 301);
  }
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Frame-Options", "SAMEORIGIN");
});

app.onError((error, c) => {
  // Never leak a stack trace to a player.
  console.error(error);
  if (new URL(c.req.url).pathname.startsWith("/api/")) {
    return json({ error: "internal" }, 500);
  }
  return new Response("Something went wrong.", { status: 500 });
});

app.notFound(() => html(views.notFound(), 404));

// --- pages ----------------------------------------------------------------

app.get("/", () => html(views.home()));
app.get("/daily", () => html(views.dailyPage("", daily.today())));

app.get(`/daily/:date{${DATE}}`, (c) => {
  const day = daily.parseDate(c.req.param("date"));
  if (!day) return html(views.notFound(), 404);
  if (!daily.playableDay(day)) return html(views.closedPuzzle(day), 410);
  return html(views.dailyPage("", day));
});

app.get("/daily/:edition", (c) => {
  const edition = c.req.param("edition");
  if (!(edition in config.MUSEUMS)) return html(views.notFound(), 404);
  return html(views.dailyPage(edition, daily.today()));
});

app.get("/endless", () => html(views.endlessPage("")));
app.get("/endless/:museum", (c) => {
  const museum = c.req.param("museum");
  if (!(museum in config.MUSEUMS)) return html(views.notFound(), 404);
  return html(views.endlessPage(museum));
});

app.get("/museums", () => html(views.museumsIndex()));
app.get("/museum/:slug", (c) => {
  const slug = c.req.param("slug");
  if (!(slug in config.MUSEUMS)) return html(views.notFound(), 404);
  return html(views.museumPage(slug));
});

app.get("/how-to-play", () => html(views.howToPlay()));
app.get("/about", () => html(views.about()));
app.get("/rights", () => html(views.rightsPage()));
app.get("/stats", () => html(views.statsPage()));

// --- api ------------------------------------------------------------------

const readJson = async (c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> => {
  try {
    const payload = await c.req.json();
    return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

app.get("/api/round", (c) => {
  const result = api.round(new URL(c.req.url).searchParams);
  return json(result.body, result.status);
});
app.post("/api/answer", async (c) => {
  const result = api.answer(await readJson(c));
  return json(result.body, result.status);
});
app.post("/api/daily/complete", async (c) => {
  const result = api.complete(await readJson(c));
  return json(result.body, result.status);
});
app.post("/api/events", async (c) => {
  const result = api.events(await readJson(c));
  return json(result.body, result.status);
});
app.get("/api/health", () => {
  const result = api.health();
  return json(result.body, result.status);
});

/**
 * Usage metrics, for whoever runs this.
 *
 * Gated on PASTPERFECT_METRICS_TOKEN. With no token configured the route does
 * not exist at all -- a 404, not a 403 -- so a deployment that has not opted in
 * does not tell a stranger there is something here worth guessing at.
 */
app.get("/api/metrics", (c) => {
  if (!metrics.token()) return html(views.notFound(), 404);
  const header = c.req.header("Authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  const presented = bearer ?? new URL(c.req.url).searchParams.get("token");
  if (!metrics.authorised(presented)) {
    return new Response(JSON.stringify({ error: "unauthorised" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Bearer realm="past-perfect metrics"',
      },
    });
  }
  const raw = Number(new URL(c.req.url).searchParams.get("days") ?? 30);
  const days = Number.isFinite(raw) ? Math.max(1, Math.min(365, Math.trunc(raw))) : 30;
  return json(metrics.collect(days));
});

// --- media ----------------------------------------------------------------

app.get("/img/:file{[0-9a-f]{20}\\.t\\.jpg}", async (c) => {
  const key = c.req.param("file").slice(0, 20);
  if (!IMAGE_KEY.test(key)) return html(views.notFound(), 404);
  const thumb = media.thumbPath(key);
  const file = fs.existsSync(thumb) ? thumb : media.largePath(key);
  return sendFile(file, 31_536_000, "image/jpeg");
});

app.get("/img/:file{[0-9a-f]{20}\\.jpg}", async (c) => {
  const key = c.req.param("file").slice(0, 20);
  if (!IMAGE_KEY.test(key)) return html(views.notFound(), 404);
  // Content-addressed by an opaque key, so it can be cached indefinitely.
  return sendFile(media.largePath(key), 31_536_000, "image/jpeg");
});

app.get(`/og/daily/:file{${DATE}\\.png}`, async (c) => {
  const day = daily.parseDate(c.req.param("file").replace(/\.png$/, ""));
  if (!day) return html(views.notFound(), 404);
  return sendFile(await og.render(day), 86_400, "image/png");
});

app.get(`/og/daily/:edition/:file{${DATE}\\.png}`, async (c) => {
  const edition = c.req.param("edition");
  const day = daily.parseDate(c.req.param("file").replace(/\.png$/, ""));
  if (!day || !(edition in config.MUSEUMS)) return html(views.notFound(), 404);
  return sendFile(await og.render(day, edition), 86_400, "image/png");
});

app.get("/og/default.png", async () => sendFile(await og.defaultCard(), 86_400, "image/png"));

app.get("/static/*", async (c) => {
  const relative = decodeURIComponent(new URL(c.req.url).pathname.slice("/static/".length));
  const target = path.resolve(config.STATIC_DIR, relative);
  // Refuse anything that escapes the static directory.
  if (!target.startsWith(path.resolve(config.STATIC_DIR) + path.sep)) {
    return html(views.notFound(), 404);
  }
  return sendFile(target, 3600);
});

// --- site plumbing --------------------------------------------------------

/**
 * robots.txt.
 *
 * Everything a reader can see is open to every crawler. Only `/api/` is closed,
 * because it answers with JSON a search engine has no use for -- and because a
 * crawler walking `/api/round` would be playing the game rather than reading
 * about it.
 *
 * `/stats` is *not* disallowed here even though it must not be indexed. It
 * carries `noindex` in its own head, and a page that is disallowed is never
 * fetched, so its noindex is never read: blocking is how a page ends up listed
 * as a bare URL with no description. Crawl it, and let the tag do the work.
 *
 * OAI-SearchBot is named explicitly because a group of its own is the clearest
 * way to say ChatGPT Search is welcome. A named group replaces the `*` group
 * outright for that crawler, so `/api/` is repeated inside it rather than
 * inherited. GPTBot -- the training crawler, a separate decision -- is not
 * named at all, and so falls through to `*`.
 */
app.get("/robots.txt", () =>
  new Response(
    "User-agent: *\n" +
      "Allow: /\n" +
      "Disallow: /api/\n" +
      "\n" +
      "User-agent: OAI-SearchBot\n" +
      "Allow: /\n" +
      "Disallow: /api/\n" +
      "\n" +
      `Sitemap: ${config.site.baseUrl}/sitemap.xml\n`,
    { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } },
  ));

/**
 * The sitemap: the permanent, canonical, indexable URLs and nothing else.
 *
 * Not in here, on purpose: `/stats` (noindex, and personal to one browser),
 * `/daily/<date>` (every one of them canonicalises to `/daily`, and the closed
 * ones answer 410), and anything carrying a query string. A sitemap full of
 * URLs that resolve elsewhere teaches a crawler to distrust the file.
 *
 * `lastmod` is only claimed where it is true. The daily routes really do change
 * every day; the explanatory pages change when somebody edits them, which is
 * not today, and stamping them with today's date is the kind of small lie that
 * gets the whole signal ignored.
 */
app.get("/sitemap.xml", () => {
  const today = daily.today();
  type Entry = { path: string; freq: string; priority: string; daily?: boolean };
  const entries: Entry[] = [
    { path: "/", freq: "daily", priority: "1.0", daily: true },
    { path: "/daily", freq: "daily", priority: "0.9", daily: true },
    { path: "/endless", freq: "weekly", priority: "0.8" },
    { path: "/museums", freq: "weekly", priority: "0.7" },
    { path: "/how-to-play", freq: "monthly", priority: "0.5" },
    { path: "/about", freq: "monthly", priority: "0.4" },
    { path: "/rights", freq: "monthly", priority: "0.4" },
    ...config.MUSEUM_ORDER.map((slug): Entry => ({ path: `/museum/${slug}`, freq: "weekly", priority: "0.7" })),
    ...config.MUSEUM_ORDER.map((slug): Entry => ({
      path: `/daily/${slug}`, freq: "daily", priority: "0.6", daily: true,
    })),
    ...config.MUSEUM_ORDER.map((slug): Entry => ({ path: `/endless/${slug}`, freq: "weekly", priority: "0.5" })),
  ];
  const urls = entries
    .map(
      (entry) =>
        `<url><loc>${config.site.baseUrl}${entry.path}</loc>` +
        (entry.daily ? `<lastmod>${today}</lastmod>` : "") +
        `<changefreq>${entry.freq}</changefreq><priority>${entry.priority}</priority></url>`,
    )
    .join("");
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
    { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" } },
  );
});

app.get("/manifest.webmanifest", () => {
  const payload = {
    name: config.SITE_NAME,
    short_name: config.SITE_NAME,
    description: config.SITE_DESCRIPTION,
    start_url: "/daily",
    scope: "/",
    display: "standalone",
    background_color: "#FBF6EC",
    theme_color: "#FBF6EC",
    orientation: "portrait-primary",
    categories: ["games", "education"],
    icons: [
      { src: "/static/img/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/static/img/icon-180.png", sizes: "180x180", type: "image/png" },
      { src: "/static/img/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
    shortcuts: [
      { name: "Daily Challenge", url: "/daily" },
      { name: "Endless", url: "/endless" },
    ],
  };
  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
});

// Served from the root so its scope covers the whole site.
app.get("/sw.js", async () =>
  sendFile(path.join(config.STATIC_DIR, "js", "sw.js"), 0, "application/javascript; charset=utf-8"));
