/**
 * The pages.
 *
 * Each of these is a complete HTML document before any script runs. The game
 * pages then mount an interactive board on top of a shell that already explains
 * itself -- which is what keeps /daily and /museum/<slug> worth indexing.
 */

import * as config from "./config.ts";
import * as daily from "./daily.ts";
import * as dates from "./dates.ts";
import * as db from "./db.ts";
import { adSlot, esc, page } from "./render.ts";
import * as rights from "./rights.ts";
import * as store from "./store.ts";

export const MUSEUM_BLURBS: Record<string, string> = {
  met:
    "Two million years of making, from Cycladic marble to a Bauhaus teapot. " +
    "The Met's open-access programme releases images of its public-domain " +
    "objects under Creative Commons Zero, and flags each one through its API.",
  aic:
    "A collection that runs from ancient bronzes to Chicago's own modernism. " +
    "The Art Institute publishes a public-domain flag per artwork and serves " +
    "the images over IIIF, which is exactly what a dating game needs.",
  wellcome:
    "Medicine, magic, anatomy and the strange edges of both. Wellcome's " +
    "catalogue is unusually honest about rights, stating a licence per " +
    "digital image, so the openly licensed material is easy to separate.",
  rijksmuseum:
    "The Dutch Golden Age and four centuries either side of it. The " +
    "Rijksmuseum publishes its collection as Linked Art, with the rights " +
    "statement attached to the image rather than to the record.",
};

/** Museum name for use after "the" -- "The Met" would otherwise double it. */
export function slugLabel(slug: string): string {
  const name = config.MUSEUMS[slug]!.shortName;
  return name.startsWith("The ") ? name.slice(4) : name;
}

function objectFigure(row: store.ObjectRow, credit = true): string {
  const museum = config.MUSEUMS[row.museum];
  const artist = row.artist ? esc(row.artist) : "Maker unrecorded";
  const line = credit ? `<span>${esc(museum?.shortName ?? row.museum)}</span>` : "";
  return `<figure>
  <div class="gallery-frame">
    <img src="/img/${esc(row.image_key)}.t.jpg" alt="${esc(row.title)}"
         loading="lazy" decoding="async" width="${row.image_w ?? 480}" height="${row.image_h ?? 480}">
  </div>
  <figcaption><b>${esc(row.title)}</b>${artist} · ${esc(dates.displayDate(row))}<br>${line}</figcaption>
</figure>`;
}

function museumCard(slug: string): string {
  const museum = config.MUSEUMS[slug]!;
  const stats = store.museumStats(slug);
  return `<a class="card" href="/museum/${slug}">
  <h3>${esc(museum.name)}</h3>
  <p class="card-meta">${esc(museum.city)}, ${esc(museum.country)}</p>
  <p>${stats.objects.toLocaleString("en-US")} objects in play${spanText(stats.earliest, stats.latest)}.</p>
</a>`;
}

function spanText(earliest: number | null, latest: number | null): string {
  if (earliest === null || latest === null) return "";
  return `, spanning ${dates.formatYear(earliest)} to ${dates.formatYear(latest)}`;
}

/** The board markup. JavaScript fills it; the copy explains it without. */
function gameShell(opts: { title: string; subtitle: string; mode: string; attrs: string }): string {
  const pips = Array.from({ length: config.DAILY_QUESTIONS }, () => '<span class="pip"></span>').join("");
  return `<section class="game wrap" id="game" data-mode="${esc(opts.mode)}"${opts.attrs}>
  <div class="game-bar">
    <h1 class="game-title">${opts.title} <small id="game-sub">${esc(opts.subtitle)}</small></h1>
    <div class="pips" id="pips" role="img" aria-label="Progress">${pips}</div>
  </div>

  <p class="question" id="question">Which came first?</p>

  <div class="board" id="board">
    <button class="choice" id="choice-a" type="button" data-choice="a" aria-label="Choose the left object">
      <span class="choice-key" aria-hidden="true">A</span>
      <span class="choice-verdict" data-verdict></span>
      <span class="choice-frame"><img alt="" data-image decoding="async"></span>
      <span class="choice-label" data-label></span>
    </button>
    <button class="choice" id="choice-b" type="button" data-choice="b" aria-label="Choose the right object">
      <span class="choice-key" aria-hidden="true">B</span>
      <span class="choice-verdict" data-verdict></span>
      <span class="choice-frame"><img alt="" data-image decoding="async"></span>
      <span class="choice-label" data-label></span>
    </button>
  </div>

  <div class="reveal" id="reveal" hidden>
    <div>
      <p class="reveal-verdict" id="reveal-verdict"></p>
      <p class="reveal-insight" id="reveal-insight"></p>
      <p class="reveal-gap" id="reveal-gap"></p>
    </div>
  </div>

  <div class="game-foot">
    <p class="hint">Press <kbd>&larr;</kbd> or <kbd>&rarr;</kbd> to choose · <kbd>Enter</kbd> for next</p>
    <button class="btn" id="next" type="button" hidden>Next</button>
  </div>

  <div id="results" hidden></div>
  <p class="loading" id="loading">Hanging the pictures&hellip;</p>
</section>`;
}

// --- pages ----------------------------------------------------------------

export function home(): string {
  const stats = store.overallStats();
  const featured = store.featuredObjects(null, 4);
  const strip = featured
    .map(
      (row) =>
        `<figure><img src="/img/${esc(row.image_key)}.t.jpg" alt="" loading="eager" ` +
        `decoding="async" width="480" height="480"></figure>`,
    )
    .join("");
  const museums = config.MUSEUM_ORDER.map(museumCard).join("");
  const raw = spanText(stats.earliest, stats.latest).replace(/^, /, "");
  const span = raw.charAt(0).toUpperCase() + raw.slice(1);

  const body = `
<section class="hero wrap">
  <div class="hero-grid">
    <div>
      <p class="eyebrow">Daily · ${stats.objects.toLocaleString("en-US")} objects · ${stats.museums} museums</p>
      <h1>Which came first?<br><span class="hero-tagline">Trust your eye.</span></h1>
      <p class="hero-lede">Two objects from the world's open museum collections.
      No labels, no dates, no hints. Pick the older one. Ten a day.</p>
      <div class="hero-actions">
        <a class="btn btn-lg" href="/daily">Play today's ten</a>
        <a class="btn btn-lg btn-quiet" href="/endless">Endless mode</a>
      </div>
      <p class="hero-note">Free, no account, takes about two minutes.</p>
    </div>
    <div class="hero-strip" aria-hidden="true">${strip}</div>
  </div>
</section>

${adSlot("home-below-cta")}

<hr class="rule">

<section class="wrap">
  <h2>How it works</h2>
  <div class="cards">
    <div class="card">
      <h3>Two objects, no labels</h3>
      <p>You see the work and nothing else. Materials, wear, palette, subject —
      that is the whole evidence base.</p>
    </div>
    <div class="card">
      <h3>The answer is provable</h3>
      <p>A pair is only asked when the two date ranges do not overlap, so one
      object is unambiguously older whatever the exact year turns out to be.</p>
    </div>
    <div class="card">
      <h3>Everybody gets the same ten</h3>
      <p>The Daily Challenge is identical worldwide. Compare, share the grid,
      argue about number seven.</p>
    </div>
  </div>
</section>

<hr class="rule">

<section class="wrap">
  <h2>The collections</h2>
  <p class="hero-lede" style="max-width:52ch">${esc(span)}. Every object is drawn
  from a museum's own open data, and only ever when that museum states an open
  licence for the image.</p>
  <div class="cards">${museums}</div>
</section>

<hr class="rule">

<section class="wrap wrap-narrow prose">
  <h2>Questions</h2>
  <h3>Is it the same puzzle for everyone?</h3>
  <p>Yes. The Daily Challenge is ten fixed questions, the same for every player,
  changing at midnight UTC.</p>
  <h3>Where do the images come from?</h3>
  <p>Four museums publishing open data: the Met, the Art Institute of Chicago,
  Wellcome Collection and the Rijksmuseum. Rights are checked
  <a href="/rights">object by object</a>.</p>
  <h3>Do I need an account?</h3>
  <p>No. Your streak and stats live in this browser and nowhere else.</p>
</section>
`;

  return page({
    title: config.SITE_NAME,
    description: config.SITE_DESCRIPTION,
    body,
    path: "/",
    ogImage: `/og/daily/${daily.today()}.png`,
    structured: [
      {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: config.SITE_NAME,
        url: config.site.baseUrl,
        description: config.SITE_DESCRIPTION,
      },
      {
        "@context": "https://schema.org",
        "@type": "Game",
        name: config.SITE_NAME,
        url: config.site.baseUrl,
        description: config.SITE_DESCRIPTION,
        genre: "Puzzle",
        gamePlatform: "Web browser",
        numberOfPlayers: { "@type": "QuantitativeValue", minValue: 1 },
      },
      {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: [
          {
            "@type": "Question",
            name: "Is it the same puzzle for everyone?",
            acceptedAnswer: {
              "@type": "Answer",
              text:
                "Yes. The Daily Challenge is ten fixed questions, the same for every " +
                "player, changing at midnight UTC.",
            },
          },
          {
            "@type": "Question",
            name: "Where do the images come from?",
            acceptedAnswer: {
              "@type": "Answer",
              text:
                "Four museums publishing open data: the Metropolitan Museum of Art, " +
                "the Art Institute of Chicago, Wellcome Collection and the Rijksmuseum.",
            },
          },
          {
            "@type": "Question",
            name: "Do I need an account?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "No. Your streak and statistics are stored in your own browser.",
            },
          },
        ],
      },
    ],
  });
}

export function closedPuzzle(day: string): string {
  const body = `<section class="wrap wrap-narrow prose">
  <p class="eyebrow">Puzzle #${daily.puzzleNumber(day)}</p>
  <h1>That one has closed.</h1>
  <p>The Daily Challenge for ${esc(prettyDate(day))} is no longer open. Past
  puzzles will return later as an archive; for now there is today's, and endless.</p>
  <p><a class="btn" href="/daily">Play today</a>
     <a class="btn btn-quiet" href="/endless">Endless mode</a></p>
</section>`;
  return page({
    title: "Puzzle closed",
    description: "This Past Perfect daily puzzle has closed.",
    body,
    path: "/daily",
    active: "daily",
    robots: "noindex, follow",
  });
}

function prettyDate(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const month = date.toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
  return `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}`;
}

export function dailyPage(edition: string, day: string): string {
  const museum = config.MUSEUMS[edition];
  const number = daily.puzzleNumber(day);
  const label = museum ? `${museum.shortName} edition` : "Daily Challenge";
  const title = `${label} #${number}`;
  const pretty = prettyDate(day);
  const others = config.MUSEUM_ORDER.filter((slug) => slug !== edition)
    .map(
      (slug) =>
        `<a class="card" href="/daily/${slug}"><h3>${esc(config.MUSEUMS[slug]!.shortName)} edition</h3>` +
        `<p class="card-meta">Ten questions from one collection</p></a>`,
    )
    .join("");

  const shell = gameShell({
    title: esc(label),
    subtitle: `#${number} · ${pretty}`,
    mode: "daily",
    attrs:
      ` data-date="${day}" data-edition="${esc(edition)}" ` +
      `data-puzzle="${number}" data-reminder-after="${config.REMINDER_OFFER_AFTER_DAILIES}"`,
  });

  const body = `${shell}
${adSlot("daily-after-result")}
<section class="wrap" style="margin-top:clamp(32px,6vw,64px)">
  <h2>Play a single collection</h2>
  <div class="cards">${others}
    <a class="card" href="/endless"><h3>Endless</h3>
    <p class="card-meta">No limit, mixed difficulty, your own pace</p></a>
  </div>
</section>`;

  const description =
    `Past Perfect ${label} #${number} for ${pretty}: ten pairs of museum objects, ` +
    "no labels. Guess which came first.";

  return page({
    title,
    description,
    body,
    path: edition ? `/daily/${edition}` : "/daily",
    active: "daily",
    bodyClass: "is-game",
    scripts: ["/static/js/game.js"],
    ogImage: edition ? `/og/daily/${edition}/${day}.png` : `/og/daily/${day}.png`,
    structured: [
      {
        "@context": "https://schema.org",
        "@type": "Game",
        name: `${config.SITE_NAME} — ${title}`,
        url: `${config.site.baseUrl}/daily`,
        description,
        datePublished: day,
      },
    ],
  });
}

export function endlessPage(slug: string): string {
  const museum = config.MUSEUMS[slug];
  const label = museum ? `${museum.shortName} endless` : "Endless";
  const shell = gameShell({
    title: esc(label),
    subtitle: "Keep going for as long as your eye holds",
    mode: "endless",
    attrs: ` data-museum="${esc(slug)}"`,
  });
  const cards = config.MUSEUM_ORDER.filter((s) => s !== slug)
    .map(
      (s) =>
        `<a class="card" href="/endless/${s}"><h3>${esc(config.MUSEUMS[s]!.shortName)}</h3>` +
        `<p class="card-meta">${esc(config.MUSEUMS[s]!.city)}</p></a>`,
    )
    .join("");

  const body = `${shell}
${adSlot("endless-interstitial")}
<section class="wrap" style="margin-top:clamp(32px,6vw,64px)">
  <h2>Or narrow it down</h2>
  <div class="cards">
    ${cards}
    <a class="card" href="/daily"><h3>Daily Challenge</h3>
    <p class="card-meta">Ten questions, same for everyone</p></a>
  </div>
</section>`;

  return page({
    title: label,
    description:
      `${label} mode: an unlimited run of museum objects to date by eye, ` +
      "drawn from open collections.",
    body,
    path: slug ? `/endless/${slug}` : "/endless",
    active: "endless",
    bodyClass: "is-game",
    scripts: ["/static/js/game.js"],
  });
}

export function museumsIndex(): string {
  const stats = store.overallStats();
  const cards = config.MUSEUM_ORDER.map(museumCard).join("");
  const body = `<section class="wrap prose">
  <p class="eyebrow">The launch mix</p>
  <h1>Four collections, one timeline.</h1>
  <p>Past Perfect is built entirely from museum open data. Every object here
  comes with a licence its museum published, and the game never uses an image
  whose rights are unclear.</p>
</section>
<section class="wrap"><div class="cards">${cards}</div></section>
<section class="wrap prose">
  <h2>What "in play" means</h2>
  <p>${stats.objects.toLocaleString("en-US")} objects have cleared all three gates: an open licence
  stated by the museum, a date precise enough to compare, and an image we could
  actually fetch. Those objects generate ${stats.pairs.toLocaleString("en-US")} questions whose
  answers are provable. <a href="/rights">How the rights gate works &rarr;</a></p>
</section>`;

  return page({
    title: "Museums",
    description:
      "The Metropolitan Museum of Art, the Art Institute of Chicago, " +
      "Wellcome Collection and the Rijksmuseum — the four open collections " +
      "behind Past Perfect.",
    body,
    path: "/museums",
    active: "museums",
    structured: [
      {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: "Museums in Past Perfect",
        url: `${config.site.baseUrl}/museums`,
        about: config.MUSEUM_ORDER.map((slug) => ({
          "@type": "Museum",
          name: config.MUSEUMS[slug]!.name,
          url: config.MUSEUMS[slug]!.site,
        })),
      },
    ],
  });
}

export function museumPage(slug: string): string {
  const museum = config.MUSEUMS[slug]!;
  const stats = store.museumStats(slug);
  const gallery = store.featuredObjects(slug, 8).map((row) => objectFigure(row, false)).join("");
  const licences =
    stats.licences
      .map(
        (item) =>
          `<a href="${esc(item.url)}" rel="license">${esc(item.label)}</a> (${item.n.toLocaleString("en-US")})`,
      )
      .join(" · ") || "—";
  const forms = stats.forms.map((item) => `${esc(item.label).toLowerCase()} (${item.n})`).join(", ");
  const earliest = stats.earliest === null ? "—" : dates.formatYear(stats.earliest);
  const latest = stats.latest === null ? "—" : dates.formatYear(stats.latest);

  const body = `<section class="wrap museum-head">
  <div>
    <span class="museum-flag"></span>
    <p class="eyebrow">${esc(museum.city)}, ${esc(museum.country)}</p>
    <h1>${esc(museum.name)}</h1>
    <p class="hero-lede" style="max-width:56ch">${esc(MUSEUM_BLURBS[slug] ?? "")}</p>
    <div class="hero-actions">
      <a class="btn" href="/daily/${slug}">Play the ${esc(slugLabel(slug))} edition</a>
      <a class="btn btn-quiet" href="/endless/${slug}">Endless from this collection</a>
    </div>
  </div>
</section>

<section class="wrap">
  <div class="facts">
    <div class="fact"><b>${stats.objects.toLocaleString("en-US")}</b><span>Objects in play</span></div>
    <div class="fact"><b>${esc(earliest)}</b><span>Earliest</span></div>
    <div class="fact"><b>${esc(latest)}</b><span>Latest</span></div>
    <div class="fact"><b>${stats.own_pairs.toLocaleString("en-US")}</b><span>Single-collection questions</span></div>
  </div>
</section>

<section class="wrap">
  <h2>From the collection</h2>
  <p class="card-meta" style="margin-bottom:18px">A rotating selection, held back
  from the current puzzle window so nothing here spoils today's ten.</p>
  <div class="gallery">${gallery || '<p class="empty">Nothing ingested yet.</p>'}</div>
</section>

<section class="wrap prose">
  <h2>Rights and provenance</h2>
  <p>${esc(museum.dataPolicy)}</p>
  <table>
    <tr><th>Licences in play</th><td>${licences}</td></tr>
    <tr><th>Common object types</th><td>${esc(forms) || "—"}</td></tr>
    <tr><th>Source API</th><td><a href="${esc(museum.apiDocs)}" rel="nofollow noopener">${esc(museum.apiDocs)}</a></td></tr>
    <tr><th>Museum</th><td><a href="${esc(museum.site)}" rel="noopener">${esc(museum.site)}</a></td></tr>
  </table>
  <p class="card-meta">Past Perfect uses this museum's published open data. It is
  not affiliated with ${esc(museum.shortName)} and implies no endorsement.</p>
</section>`;

  const description =
    `${stats.objects.toLocaleString("en-US")} openly licensed objects from ${museum.name} ` +
    `(${earliest}–${latest}) in Past Perfect. Play the ${museum.shortName} edition.`;

  return page({
    title: museum.name,
    description,
    body,
    path: `/museum/${slug}`,
    active: "museums",
    structured: [
      {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: `${museum.name} in Past Perfect`,
        url: `${config.site.baseUrl}/museum/${slug}`,
        description,
        about: {
          "@type": "Museum",
          name: museum.name,
          url: museum.site,
          address: {
            "@type": "PostalAddress",
            addressLocality: museum.city,
            addressCountry: museum.country,
          },
        },
      },
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Museums", item: `${config.site.baseUrl}/museums` },
          { "@type": "ListItem", position: 2, name: museum.name, item: `${config.site.baseUrl}/museum/${slug}` },
        ],
      },
    ],
  });
}

export function statsPage(): string {
  const museumData = JSON.stringify(
    Object.fromEntries(config.MUSEUM_ORDER.map((slug) => [slug, { name: config.MUSEUMS[slug]!.shortName }])),
  );
  const body = `<script type="application/json" id="museum-data">${museumData}</script>
<section class="wrap prose" style="padding-bottom:0">
  <p class="eyebrow">Stored in this browser only</p>
  <h1>Your eye, measured.</h1>
</section>
<section class="wrap" id="stats-root" data-min-answers="${config.ART_EYE_MIN_ANSWERS}"
         data-reminder-after="${config.REMINDER_OFFER_AFTER_DAILIES}">
  <p class="loading">Reading your local record&hellip;</p>
</section>
<section class="wrap wrap-narrow prose">
  <h2>Where this lives</h2>
  <p>Everything on this page is computed in your browser from a record kept in
  local storage. There is no account, and none of it is sent anywhere. Clearing
  your browser data clears your streak with it.</p>
</section>`;

  return page({
    title: "Your stats",
    description: "Your Past Perfect streak, distribution, museum passport and Art Eye rating.",
    body,
    path: "/stats",
    active: "stats",
    scripts: ["/static/js/stats.js"],
    robots: "noindex, follow",
  });
}

export function howToPlay(): string {
  const body = `<section class="wrap wrap-narrow prose">
  <p class="eyebrow">Two minutes</p>
  <h1>How to play</h1>
  <p>Two objects appear side by side with nothing else — no title, no maker, no
  date, no museum. Pick the one you think was made first.</p>
  <h2>The rules</h2>
  <ul>
    <li>Ten questions in the Daily Challenge, the same ten for everyone, resetting at midnight UTC.</li>
    <li>Endless mode never stops and mixes difficulty as you go.</li>
    <li>Choose with a tap, a click, or <kbd>&larr;</kbd> / <kbd>&rarr;</kbd> on a keyboard.</li>
    <li>The reveal shows both dates, the gap between them, and one line of context.</li>
  </ul>
  <h2>What actually helps</h2>
  <ul>
    <li><b>Material before style.</b> Photographic processes, aniline dye, cast iron
    and plastics all carry hard earliest dates.</li>
    <li><b>Watch the format.</b> A carte de visite, a folio engraving and a poster
    all belong to particular decades of printing.</li>
    <li><b>Don't trust "modern-looking".</b> A great deal of very old work is
    startlingly clean, and a great deal of recent work is deliberately antique.</li>
    <li><b>Mind the region.</b> Most of us hold one timeline, usually a European
    one. Crossing continents is where the ranking instinct breaks.</li>
  </ul>
  <div class="callout">
    <p>A pair is only asked when the two objects' date ranges do not overlap at
    all. Close calls are close on purpose — but they always have a right answer.</p>
  </div>
  <p><a class="btn" href="/daily">Play today's ten</a></p>
</section>`;
  return page({
    title: "How to play",
    description: "How Past Perfect works: two museum objects, no labels, guess which came first.",
    body,
    path: "/how-to-play",
  });
}

export function about(): string {
  const stats = store.overallStats();
  const last = db.getMeta<string | null>("last_ingest", null) ?? "—";
  const body = `<section class="wrap wrap-narrow prose">
  <p class="eyebrow">About</p>
  <h1>Trust your eye.</h1>
  <p>Past Perfect is a small daily game about visual dating. It exists because
  the world's museums have quietly published enormous, openly licensed
  collections, and almost nobody plays with them.</p>

  <h2>How a question is made</h2>
  <ol>
    <li>Objects are harvested from four museum APIs across ten date windows, so
    the pool spans centuries rather than clustering in the 1800s.</li>
    <li>Each museum's date fields and its written date label are reconciled into
    a range. Vague labels produce wide ranges, never confident guesses.</li>
    <li>Image rights are evaluated per object against an allow list. Anything
    ambiguous is dropped. <a href="/rights">The gate is documented here.</a></li>
    <li>Two objects become a question only when their ranges do not overlap.</li>
  </ol>

  <h2>Where AI is, and is not</h2>
  <p>No language model is involved in deciding which object came first, and
  normal play makes no model call at all. Offline, in the build step, metadata is
  classified by region and object type, difficulty and surprise are estimated,
  and the one-line reveal caption is assembled from the object's own fields.</p>

  <h2>Advertising</h2>
  <p>There is none. If it ever appears it will not sit between a question and its
  answer, and never over an artwork. Personalised advertising in the UK and EEA
  would require a certified consent platform first, which does not exist here yet.</p>

  <h2>The current build</h2>
  <table>
    <tr><th>Objects in play</th><td>${stats.objects.toLocaleString("en-US")}</td></tr>
    <tr><th>Questions available</th><td>${stats.pairs.toLocaleString("en-US")}</td></tr>
    <tr><th>Museums</th><td>${stats.museums}</td></tr>
    <tr><th>Last harvest</th><td>${esc(last)}</td></tr>
  </table>
</section>`;
  return page({
    title: "About",
    description:
      "Past Perfect is a daily visual dating game built from open museum " +
      "data. How the questions are made, and where AI is and is not used.",
    body,
    path: "/about",
  });
}

export function rightsPage(): string {
  const report = db.getMeta<Record<string, { stored?: number; playable?: number; excluded?: Record<string, number> }>>(
    "ingest_report",
    {},
  );
  const allowed = rights
    .allowedSummary()
    .map(
      (item) =>
        `<tr><td><code>${esc(item.id)}</code></td>` +
        `<td><a href="${esc(item.url)}" rel="license">${esc(item.label)}</a></td></tr>`,
    )
    .join("");
  const refused = rights
    .refusedSummary()
    .map((item) => `<tr><td><code>${esc(item.id)}</code></td><td>${esc(item.reason)}</td></tr>`)
    .join("");
  const rows = config.MUSEUM_ORDER.map((slug) => {
    const entry = report[slug] ?? {};
    const excluded = Object.entries(entry.excluded ?? {}).sort((a, b) => b[1] - a[1]);
    const detail = excluded.map(([reason, n]) => `${reason} (${n})`).join("; ");
    return (
      `<tr><td>${esc(config.MUSEUMS[slug]!.shortName)}</td>` +
      `<td>${(entry.stored ?? 0).toLocaleString("en-US")}</td><td>${(entry.playable ?? 0).toLocaleString("en-US")}</td>` +
      `<td>${esc(detail) || "—"}</td></tr>`
    );
  }).join("");

  const body = `<section class="wrap wrap-narrow prose">
  <p class="eyebrow">Per object, not per museum</p>
  <h1>Image rights</h1>
  <p>Museums do not hold one licence. They hold thousands of individual rights
  positions, and a collection API will happily hand you an in-copyright
  photograph next to a public-domain painting. So rights are evaluated for each
  object, from the statement its own museum published, and anything unclear is
  excluded rather than guessed at.</p>

  <h2>Licences we play</h2>
  <table><tr><th>Identifier</th><th>Licence</th></tr>${allowed}</table>
  <p>Attribution is shown on every reveal, with a link to the object at its
  museum, which satisfies the attribution terms these licences carry.</p>

  <h2>Licences we refuse</h2>
  <table><tr><th>Identifier</th><th>Why</th></tr>${refused}</table>
  <div class="callout">
    <p>NonCommercial terms are refused because this product intends to carry
    advertising eventually, and a licence that would forbid that later forbids it
    now. NoDerivatives is refused because the game crops and resizes.
    An unrecognised statement is not a permissive one.</p>
  </div>

  <h2>What the last harvest did</h2>
  <table>
    <tr><th>Museum</th><th>Considered</th><th>Cleared</th><th>Excluded, by reason</th></tr>
    ${rows}
  </table>
  <p class="card-meta">If you hold rights in something here and believe it should
  not be, the object page linked from every reveal identifies it exactly.</p>
</section>`;

  return page({
    title: "Image rights",
    description:
      "How Past Perfect evaluates museum image rights object by object, " +
      "which licences it plays, and which it refuses.",
    body,
    path: "/rights",
  });
}

export function notFound(): string {
  const body = `<section class="wrap wrap-narrow prose">
  <p class="eyebrow">404</p>
  <h1>Nothing hanging here.</h1>
  <p>The page you asked for does not exist.</p>
  <p><a class="btn" href="/daily">Play today's ten</a>
     <a class="btn btn-quiet" href="/">Home</a></p>
</section>`;
  return page({
    title: "Not found",
    description: "Page not found.",
    body,
    path: "/",
    robots: "noindex, nofollow",
  });
}
