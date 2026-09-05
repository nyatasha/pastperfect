/**
 * Server-rendered HTML.
 *
 * Every page a search engine or a share preview might land on is rendered here,
 * in full, before any JavaScript runs. The game itself hydrates on top of that
 * shell -- but the homepage, the museum pages and the explanatory pages are
 * complete documents on their own.
 */

import * as config from "./config.ts";

export const ADS_NOTE = "v0 ships without advertising; see config.ADS_ENABLED.";

/**
 * Runs before the stylesheet paints, so a returning player never sees a flash
 * of the theme they did not choose. Absent a stored choice the page falls
 * through to the operating system's preference, handled entirely in CSS.
 */
export const THEME_BOOTSTRAP =
  "(function(){try{var t=localStorage.getItem('pastperfect.theme');" +
  "if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}" +
  "catch(e){}})();";

export const THEME_TOGGLE = `<button class="theme-toggle" id="theme-toggle" type="button"
  aria-label="Switch colour theme" title="Switch colour theme">
  <svg class="icon-light" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4.2"/>
    <path d="M12 2.4v2.2M12 19.4v2.2M4.2 12H2M22 12h-2.2M5.9 5.9 4.4 4.4M19.6 19.6l-1.5-1.5M18.1 5.9l1.5-1.5M4.4 19.6l1.5-1.5"/>
  </svg>
  <svg class="icon-dark" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1Z"/>
  </svg>
</button>`;

export function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

export function nav(active = ""): string {
  const items: Array<[string, string, string]> = [
    ["/daily", "Daily", "daily"],
    ["/endless", "Endless", "endless"],
    ["/museums", "Museums", "museums"],
    ["/stats", "Your stats", "stats"],
  ];
  const links =
    items
      .map(([href, label, key]) => `<a href="${href}"${key === active ? " class=is-active" : ""}>${label}</a>`)
      .join("") + THEME_TOGGLE;
  return `<header class="site-head">
  <a class="wordmark" href="/" aria-label="${esc(config.SITE_NAME)} home">
    <span class="wordmark-past">Past</span> <span class="wordmark-perfect">Perfect</span>
  </a>
  <nav class="site-nav" aria-label="Main">${links}</nav>
</header>`;
}

/**
 * How a link off to a museum behaves on a page with a game running.
 *
 * A player mid-round who clicks a museum credit means "show me that, I am
 * coming back", and in the same tab there is nothing to come back to: the run
 * lives in memory and reloading the board starts it again. So on a game page
 * every incidental museum link opens beside the game instead of on top of it.
 */
export const asideLink = (inGame: boolean): string => (inGame ? ' target="_blank" rel="noopener"' : "");

export function footer(inGame = false): string {
  const museums = config.MUSEUM_ORDER.map(
    (slug) => `<a href="/museum/${slug}"${asideLink(inGame)}>${esc(config.MUSEUMS[slug]!.shortName)}</a>`,
  ).join(" · ");
  return `<footer class="site-foot">
  <p class="foot-museums">Objects and images from ${museums}.</p>
  <p class="foot-links">
    <a href="/how-to-play">How to play</a>
    <a href="/about">About</a>
    <a href="/rights">Image rights</a>
  </p>
  <p class="foot-fine">Every image is used under an open licence stated by the
  museum that holds the object. Past Perfect is not affiliated with, and does not
  imply endorsement by, any of these institutions.</p>
</footer>`;
}

/**
 * Render an advertising slot -- which, in v0, means rendering nothing.
 *
 * The PRD is specific about where advertising may eventually go and, more
 * importantly, where it may not: never between a question and its answer, and
 * never over an artwork. Keeping the permitted placements in code means a
 * future change has to name a placement that already passed that review, and
 * means personalised ads cannot quietly precede a consent platform.
 */
export function adSlot(placement: string): string {
  if (!config.AD_PLACEMENTS.has(placement)) {
    throw new Error(`${placement} is not a reviewed ad placement`);
  }
  if (!config.ADS_ENABLED) return `<!-- ad slot ${placement}: ${ADS_NOTE} -->`;
  return `<div class="ad-slot" data-placement="${esc(placement)}"></div>`;
}

/**
 * The GoatCounter tag, or nothing at all.
 *
 * Nothing is the default: unconfigured deployments and every local run serve no
 * third-party script whatsoever. The endpoint is checked for an https URL
 * rather than trusted, so a fat-fingered environment variable cannot turn into
 * an inline script on every page.
 */
export function analyticsTag(): string {
  const endpoint = config.GOATCOUNTER;
  if (!endpoint.startsWith("https://")) return "";
  return (
    `<script data-goatcounter="${esc(endpoint)}" async ` +
    `src="${esc(config.GOATCOUNTER_SCRIPT)}"></script>`
  );
}

export const jsonLd = (payload: unknown): string =>
  `<script type="application/ld+json">${JSON.stringify(payload)}</script>`;

export interface PageOptions {
  title: string;
  description: string;
  body: string;
  path?: string;
  active?: string;
  /**
   * What a share preview says, when that should differ from what the tab and
   * the search result say. A <title> is read next to a browser's own chrome
   * and can lean on the site name alone; a card pasted into a chat arrives
   * with no such context, so it has to name the game and ask the question.
   */
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  ogType?: string;
  scripts?: readonly string[];
  /** True on the two pages that run a board, so museum links open in a new tab. */
  inGame?: boolean;
  structured?: readonly unknown[];
  headExtra?: string;
  bodyClass?: string;
  robots?: string;
}

export function page(options: PageOptions): string {
  const {
    title, description, body, path = "/", active = "", ogImage, ogType = "website",
    ogTitle = title, ogDescription = description,
    scripts = [], structured = [], headExtra = "", bodyClass = "", robots = "index, follow",
    inGame = false,
  } = options;

  const canonical = `${config.site.baseUrl}${path}`;
  let image = ogImage ?? "/og/default.png";
  if (image.startsWith("/")) image = `${config.site.baseUrl}${image}`;
  const fullTitle = title === config.SITE_NAME ? title : `${title} · ${config.SITE_NAME}`;
  const scriptTags = scripts.map((src) => `<script src="${esc(src)}" defer></script>`).join("");
  const structuredTags = structured.map(jsonLd).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<script>${THEME_BOOTSTRAP}</script>
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${esc(robots)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:site_name" content="${esc(config.SITE_NAME)}">
<meta property="og:title" content="${esc(ogTitle)}">
<meta property="og:description" content="${esc(ogDescription)}">
<meta property="og:type" content="${esc(ogType)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(ogTitle)}">
<meta name="twitter:description" content="${esc(ogDescription)}">
<meta name="twitter:image" content="${esc(image)}">
<meta name="theme-color" content="#FBF6EC" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#100F0D" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/static/img/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/static/img/icon-180.png">
<link rel="stylesheet" href="/static/css/app.css?v=${config.CSS_VERSION}">
${structuredTags}
${headExtra}
</head>
<body class="${esc(bodyClass)}">
${nav(active)}
<main id="main">${body}</main>
${footer(inGame)}
<script src="/static/js/app.js" defer></script>
${scriptTags}
${analyticsTag()}
</body>
</html>`;
}
