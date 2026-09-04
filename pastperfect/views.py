"""The pages.

Each of these is a complete HTML document before any script runs. The game
pages then mount an interactive board on top of a shell that already explains
itself -- which is what keeps /daily and /museum/<slug> worth indexing.
"""

from __future__ import annotations

import datetime as _dt

from . import config, daily, dates, db, http, store
from .render import ad_slot, esc, page

MUSEUM_BLURBS = {
    "met": (
        "Two million years of making, from Cycladic marble to a Bauhaus teapot. "
        "The Met's open-access programme releases images of its public-domain "
        "objects under Creative Commons Zero, and flags each one through its API."
    ),
    "aic": (
        "A collection that runs from ancient bronzes to Chicago's own modernism. "
        "The Art Institute publishes a public-domain flag per artwork and serves "
        "the images over IIIF, which is exactly what a dating game needs."
    ),
    "wellcome": (
        "Medicine, magic, anatomy and the strange edges of both. Wellcome's "
        "catalogue is unusually honest about rights, stating a licence per "
        "digital image, so the openly licensed material is easy to separate."
    ),
    "rijksmuseum": (
        "The Dutch Golden Age and four centuries either side of it. The "
        "Rijksmuseum publishes its collection as Linked Art, with the rights "
        "statement attached to the image rather than to the record."
    ),
}


# --- shared components ----------------------------------------------------


def display_date(row: dict) -> str:
    """The museum's own label, or a range built from its dates when it gave none."""
    if row.get("date_display"):
        return row["date_display"]
    start, end = row.get("year_start"), row.get("year_end")
    if start is None or end is None:
        return "date unrecorded"
    if start == end:
        return dates.format_year(start)
    return f"{dates.format_year(start)}\u2013{dates.format_year(end)}"


def headline_date(row: dict) -> str:
    """The short date shown large at the reveal.

    Derived from the museum's own label where that label names a year or a
    century, so the big number on the card and the small line under it never
    disagree with each other.
    """
    parsed = dates.parse_display(row.get("date_display") or "")
    if parsed and parsed.precision == "year" and parsed.span == 0:
        return dates.format_year(parsed.start)
    if row.get("date_precision") == "century":
        return dates.century_label(row["year_mid"])
    start, end = row.get("year_start"), row.get("year_end")
    if start is None or end is None or start == end:
        return dates.format_year(row.get("year_mid", 0))
    return f"{dates.format_year(start)}\u2013{dates.format_year(end)}"


def _object_figure(row: dict, credit: bool = True) -> str:
    museum = config.MUSEUMS.get(row["museum"], {})
    artist = esc(row["artist"]) if row["artist"] else "Maker unrecorded"
    line = f'<span>{esc(museum.get("short_name", row["museum"]))}</span>' if credit else ""
    return f"""<figure>
  <div class="gallery-frame">
    <img src="/img/{esc(row['image_key'])}.t.jpg" alt="{esc(row['title'])}"
         loading="lazy" decoding="async" width="{row['image_w'] or 480}" height="{row['image_h'] or 480}">
  </div>
  <figcaption><b>{esc(row['title'])}</b>{artist} · {esc(display_date(row))}<br>{line}</figcaption>
</figure>"""


def _museum_card(slug: str) -> str:
    museum = config.MUSEUMS[slug]
    stats = store.museum_stats(slug)
    span = _span_text(stats["earliest"], stats["latest"])
    return f"""<a class="card" href="/museum/{slug}">
  <h3>{esc(museum['name'])}</h3>
  <p class="card-meta">{esc(museum['city'])}, {esc(museum['country'])}</p>
  <p>{stats['objects']:,} objects in play{span}.</p>
</a>"""


def slug_label(slug: str) -> str:
    """Museum name for use after "the" -- "The Met" would otherwise double it."""
    name = config.MUSEUMS[slug]["short_name"]
    return name[4:] if name.startswith("The ") else name


def _span_text(earliest, latest) -> str:
    if earliest is None or latest is None:
        return ""
    return f", spanning {dates.format_year(earliest)} to {dates.format_year(latest)}"


def _game_shell(*, title: str, subtitle: str, mode: str, attrs: str) -> str:
    """The board markup. JavaScript fills it; the copy explains it without."""
    pips = "".join('<span class="pip"></span>' for _ in range(config.DAILY_QUESTIONS))
    return f"""<section class="game wrap" id="game" data-mode="{esc(mode)}"{attrs}>
  <div class="game-bar">
    <h1 class="game-title">{title} <small id="game-sub">{esc(subtitle)}</small></h1>
    <div class="pips" id="pips" role="img" aria-label="Progress">{pips}</div>
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
</section>"""


# --- pages ----------------------------------------------------------------


def home(request: http.Request) -> http.Response:
    stats = store.overall_stats()
    featured = store.featured_objects(limit=4)
    strip = "".join(
        f'<figure><img src="/img/{esc(row["image_key"])}.t.jpg" alt="" loading="eager" '
        f'decoding="async" width="480" height="480"></figure>'
        for row in featured
    )
    museums = "".join(_museum_card(slug) for slug in config.MUSEUM_ORDER)
    span = _span_text(stats["earliest"], stats["latest"]).lstrip(", ").capitalize()

    body = f"""
<section class="hero wrap">
  <div class="hero-grid">
    <div>
      <p class="eyebrow">Daily · {stats['objects']:,} objects · {stats['museums']} museums</p>
      <h1>Which came first?<br><span class="hero-tagline">Trust your eye.</span></h1>
      <p class="hero-lede">Two objects from the world's open museum collections.
      No labels, no dates, no hints. Pick the older one. Ten a day.</p>
      <div class="hero-actions">
        <a class="btn btn-lg" href="/daily">Play today's ten</a>
        <a class="btn btn-lg btn-quiet" href="/endless">Endless mode</a>
      </div>
      <p class="hero-note">Free, no account, takes about two minutes.</p>
    </div>
    <div class="hero-strip" aria-hidden="true">{strip}</div>
  </div>
</section>

{ad_slot('home-below-cta')}

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
  <p class="hero-lede" style="max-width:52ch">{esc(span)}. Every object is drawn
  from a museum's own open data, and only ever when that museum states an open
  licence for the image.</p>
  <div class="cards">{museums}</div>
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
"""
    structured = [
        {
            "@context": "https://schema.org",
            "@type": "WebSite",
            "name": config.SITE_NAME,
            "url": config.BASE_URL,
            "description": config.SITE_DESCRIPTION,
        },
        {
            "@context": "https://schema.org",
            "@type": "Game",
            "name": config.SITE_NAME,
            "url": config.BASE_URL,
            "description": config.SITE_DESCRIPTION,
            "genre": "Puzzle",
            "gamePlatform": "Web browser",
            "numberOfPlayers": {"@type": "QuantitativeValue", "minValue": 1},
        },
        {
            "@context": "https://schema.org",
            "@type": "FAQPage",
            "mainEntity": [
                {"@type": "Question", "name": "Is it the same puzzle for everyone?",
                 "acceptedAnswer": {"@type": "Answer", "text":
                  "Yes. The Daily Challenge is ten fixed questions, the same for every "
                  "player, changing at midnight UTC."}},
                {"@type": "Question", "name": "Where do the images come from?",
                 "acceptedAnswer": {"@type": "Answer", "text":
                  "Four museums publishing open data: the Metropolitan Museum of Art, "
                  "the Art Institute of Chicago, Wellcome Collection and the Rijksmuseum."}},
                {"@type": "Question", "name": "Do I need an account?",
                 "acceptedAnswer": {"@type": "Answer", "text":
                  "No. Your streak and statistics are stored in your own browser."}},
            ],
        },
    ]
    return http.html(page(
        title=config.SITE_NAME,
        description=config.SITE_DESCRIPTION,
        body=body,
        path="/",
        structured=structured,
        og_image=f"/og/daily/{daily.today().isoformat()}.png",
    ))


def daily_page(request: http.Request) -> http.Response:
    edition = request.params.get("edition", daily.MIXED)
    date_text = request.params.get("date", "")
    day = daily.parse_date(date_text) if date_text else daily.today()

    if edition and edition not in config.MUSEUMS:
        return not_found(request)
    if day is None:
        return not_found(request)
    if not daily.playable_day(day):
        return _closed_puzzle(day)

    museum = config.MUSEUMS.get(edition)
    number = daily.puzzle_number(day)
    label = f"{museum['short_name']} edition" if museum else "Daily Challenge"
    title = f"{label} #{number}"
    pretty = day.strftime("%-d %B %Y")
    others = "".join(
        f'<a class="card" href="/daily/{slug}"><h3>{esc(config.MUSEUMS[slug]["short_name"])} edition</h3>'
        f'<p class="card-meta">Ten questions from one collection</p></a>'
        for slug in config.MUSEUM_ORDER if slug != edition
    )
    shell = _game_shell(
        title=esc(label),
        subtitle=f"#{number} · {pretty}",
        mode="daily",
        attrs=f' data-date="{day.isoformat()}" data-edition="{esc(edition)}" '
              f'data-puzzle="{number}" data-reminder-after="{config.REMINDER_OFFER_AFTER_DAILIES}"',
    )
    body = f"""{shell}
{ad_slot('daily-after-result')}
<section class="wrap" style="margin-top:clamp(32px,6vw,64px)">
  <h2>Play a single collection</h2>
  <div class="cards">{others}
    <a class="card" href="/endless"><h3>Endless</h3>
    <p class="card-meta">No limit, mixed difficulty, your own pace</p></a>
  </div>
</section>"""
    description = (
        f"Past Perfect {label} #{number} for {pretty}: ten pairs of museum objects, "
        "no labels. Guess which came first."
    )
    return http.html(page(
        title=title,
        description=description,
        body=body,
        path=f"/daily/{edition}" if edition else "/daily",
        active="daily",
        scripts=("/static/js/game.js",),
        og_image=f"/og/daily/{day.isoformat()}.png",
        structured=[{
            "@context": "https://schema.org",
            "@type": "Game",
            "name": f"{config.SITE_NAME} — {title}",
            "url": f"{config.BASE_URL}/daily",
            "description": description,
            "datePublished": day.isoformat(),
        }],
    ))


def _closed_puzzle(day: _dt.date) -> http.Response:
    body = f"""<section class="wrap wrap-narrow prose">
  <p class="eyebrow">Puzzle #{daily.puzzle_number(day)}</p>
  <h1>That one has closed.</h1>
  <p>The Daily Challenge for {day.strftime('%-d %B %Y')} is no longer open. Past
  puzzles will return later as an archive; for now there is today's, and endless.</p>
  <p><a class="btn" href="/daily">Play today</a>
     <a class="btn btn-quiet" href="/endless">Endless mode</a></p>
</section>"""
    return http.html(
        page(title="Puzzle closed", description="This Past Perfect daily puzzle has closed.",
             body=body, path="/daily", active="daily", robots="noindex, follow"),
        status="410 Gone",
    )


def endless_page(request: http.Request) -> http.Response:
    slug = request.params.get("museum", "")
    if slug and slug not in config.MUSEUMS:
        return not_found(request)
    museum = config.MUSEUMS.get(slug)
    label = f"{museum['short_name']} endless" if museum else "Endless"
    subtitle = "Keep going for as long as your eye holds"
    shell = _game_shell(
        title=esc(label), subtitle=subtitle, mode="endless",
        attrs=f' data-museum="{esc(slug)}"',
    )
    body = f"""{shell}
{ad_slot('endless-interstitial')}
<section class="wrap" style="margin-top:clamp(32px,6vw,64px)">
  <h2>Or narrow it down</h2>
  <div class="cards">
    {''.join(
        f'<a class="card" href="/endless/{s}"><h3>{esc(config.MUSEUMS[s]["short_name"])}</h3>'
        f'<p class="card-meta">{esc(config.MUSEUMS[s]["city"])}</p></a>'
        for s in config.MUSEUM_ORDER if s != slug)}
    <a class="card" href="/daily"><h3>Daily Challenge</h3>
    <p class="card-meta">Ten questions, same for everyone</p></a>
  </div>
</section>"""
    description = (
        f"{label} mode: an unlimited run of museum objects to date by eye, "
        "drawn from open collections."
    )
    return http.html(page(
        title=label, description=description, body=body,
        path=f"/endless/{slug}" if slug else "/endless",
        active="endless", scripts=("/static/js/game.js",),
    ))


def museums_index(request: http.Request) -> http.Response:
    stats = store.overall_stats()
    cards = "".join(_museum_card(slug) for slug in config.MUSEUM_ORDER)
    body = f"""<section class="wrap prose">
  <p class="eyebrow">The launch mix</p>
  <h1>Four collections, one timeline.</h1>
  <p>Past Perfect is built entirely from museum open data. Every object here
  comes with a licence its museum published, and the game never uses an image
  whose rights are unclear.</p>
</section>
<section class="wrap"><div class="cards">{cards}</div></section>
<section class="wrap prose">
  <h2>What "in play" means</h2>
  <p>{stats['objects']:,} objects have cleared all three gates: an open licence
  stated by the museum, a date precise enough to compare, and an image we could
  actually fetch. Those objects generate {stats['pairs']:,} questions whose
  answers are provable. <a href="/rights">How the rights gate works &rarr;</a></p>
</section>"""
    return http.html(page(
        title="Museums", description=(
            "The Metropolitan Museum of Art, the Art Institute of Chicago, "
            "Wellcome Collection and the Rijksmuseum — the four open collections "
            "behind Past Perfect."),
        body=body, path="/museums", active="museums",
        structured=[{
            "@context": "https://schema.org", "@type": "CollectionPage",
            "name": "Museums in Past Perfect", "url": f"{config.BASE_URL}/museums",
            "about": [
                {"@type": "Museum", "name": config.MUSEUMS[s]["name"],
                 "url": config.MUSEUMS[s]["site"]}
                for s in config.MUSEUM_ORDER
            ],
        }],
    ))


def museum_page(request: http.Request) -> http.Response:
    slug = request.params.get("slug", "")
    museum = config.MUSEUMS.get(slug)
    if not museum:
        return not_found(request)
    stats = store.museum_stats(slug)
    featured = store.featured_objects(slug, limit=8)
    gallery = "".join(_object_figure(row, credit=False) for row in featured)
    licences = " · ".join(
        f'<a href="{esc(item["url"])}" rel="license">{esc(item["label"])}</a> ({item["n"]:,})'
        for item in stats["licences"]
    ) or "—"
    forms = ", ".join(f'{esc(item["label"]).lower()} ({item["n"]})' for item in stats["forms"])
    earliest = dates.format_year(stats["earliest"]) if stats["earliest"] is not None else "—"
    latest = dates.format_year(stats["latest"]) if stats["latest"] is not None else "—"

    body = f"""<section class="wrap museum-head">
  <div>
    <span class="museum-flag"></span>
    <p class="eyebrow">{esc(museum['city'])}, {esc(museum['country'])}</p>
    <h1>{esc(museum['name'])}</h1>
    <p class="hero-lede" style="max-width:56ch">{esc(MUSEUM_BLURBS.get(slug, ''))}</p>
    <div class="hero-actions">
      <a class="btn" href="/daily/{slug}">Play the {esc(slug_label(slug))} edition</a>
      <a class="btn btn-quiet" href="/endless/{slug}">Endless from this collection</a>
    </div>
  </div>
</section>

<section class="wrap">
  <div class="facts">
    <div class="fact"><b>{stats['objects']:,}</b><span>Objects in play</span></div>
    <div class="fact"><b>{esc(earliest)}</b><span>Earliest</span></div>
    <div class="fact"><b>{esc(latest)}</b><span>Latest</span></div>
    <div class="fact"><b>{stats['own_pairs']:,}</b><span>Single-collection questions</span></div>
  </div>
</section>

<section class="wrap">
  <h2>From the collection</h2>
  <p class="card-meta" style="margin-bottom:18px">A rotating selection, held back
  from the current puzzle window so nothing here spoils today's ten.</p>
  <div class="gallery">{gallery or '<p class="empty">Nothing ingested yet.</p>'}</div>
</section>

<section class="wrap prose">
  <h2>Rights and provenance</h2>
  <p>{esc(museum['data_policy'])}</p>
  <table>
    <tr><th>Licences in play</th><td>{licences}</td></tr>
    <tr><th>Common object types</th><td>{esc(forms) or '—'}</td></tr>
    <tr><th>Source API</th><td><a href="{esc(museum['api_docs'])}" rel="nofollow noopener">{esc(museum['api_docs'])}</a></td></tr>
    <tr><th>Museum</th><td><a href="{esc(museum['site'])}" rel="noopener">{esc(museum['site'])}</a></td></tr>
  </table>
  <p class="card-meta">Past Perfect uses this museum's published open data. It is
  not affiliated with {esc(museum['short_name'])} and implies no endorsement.</p>
</section>"""
    description = (
        f"{stats['objects']:,} openly licensed objects from {museum['name']} "
        f"({earliest}–{latest}) in Past Perfect. Play the {museum['short_name']} edition."
    )
    return http.html(page(
        title=museum["name"], description=description, body=body,
        path=f"/museum/{slug}", active="museums",
        structured=[
            {"@context": "https://schema.org", "@type": "CollectionPage",
             "name": f"{museum['name']} in Past Perfect",
             "url": f"{config.BASE_URL}/museum/{slug}",
             "description": description,
             "about": {"@type": "Museum", "name": museum["name"], "url": museum["site"],
                       "address": {"@type": "PostalAddress", "addressLocality": museum["city"],
                                   "addressCountry": museum["country"]}}},
            {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": "Museums",
                 "item": f"{config.BASE_URL}/museums"},
                {"@type": "ListItem", "position": 2, "name": museum["name"],
                 "item": f"{config.BASE_URL}/museum/{slug}"},
            ]},
        ],
    ))


def stats_page(request: http.Request) -> http.Response:
    import json

    museum_data = json.dumps({
        slug: {"name": config.MUSEUMS[slug]["short_name"]} for slug in config.MUSEUM_ORDER
    })
    body = f"""<script type="application/json" id="museum-data">{museum_data}</script>
<section class="wrap prose" style="padding-bottom:0">
  <p class="eyebrow">Stored in this browser only</p>
  <h1>Your eye, measured.</h1>
</section>
<section class="wrap" id="stats-root" data-min-answers="{config.ART_EYE_MIN_ANSWERS}"
         data-reminder-after="{config.REMINDER_OFFER_AFTER_DAILIES}">
  <p class="loading">Reading your local record&hellip;</p>
</section>
<section class="wrap wrap-narrow prose">
  <h2>Where this lives</h2>
  <p>Everything on this page is computed in your browser from a record kept in
  local storage. There is no account, and none of it is sent anywhere. Clearing
  your browser data clears your streak with it.</p>
</section>"""
    return http.html(page(
        title="Your stats",
        description="Your Past Perfect streak, distribution, museum passport and Art Eye rating.",
        body=body, path="/stats", active="stats",
        scripts=("/static/js/stats.js",), robots="noindex, follow",
    ))


def how_to_play(request: http.Request) -> http.Response:
    body = f"""<section class="wrap wrap-narrow prose">
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
</section>"""
    return http.html(page(
        title="How to play",
        description="How Past Perfect works: two museum objects, no labels, guess which came first.",
        body=body, path="/how-to-play",
    ))


def about(request: http.Request) -> http.Response:
    stats = store.overall_stats()
    last = db.get_meta("last_ingest") or "—"
    body = f"""<section class="wrap wrap-narrow prose">
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
    <tr><th>Objects in play</th><td>{stats['objects']:,}</td></tr>
    <tr><th>Questions available</th><td>{stats['pairs']:,}</td></tr>
    <tr><th>Museums</th><td>{stats['museums']}</td></tr>
    <tr><th>Last harvest</th><td>{esc(last)}</td></tr>
  </table>
</section>"""
    return http.html(page(
        title="About", description=(
            "Past Perfect is a daily visual dating game built from open museum "
            "data. How the questions are made, and where AI is and is not used."),
        body=body, path="/about",
    ))


def rights_page(request: http.Request) -> http.Response:
    from . import rights as rights_module

    report = db.get_meta("ingest_report", {}) or {}
    allowed = "".join(
        f'<tr><td><code>{esc(item["id"])}</code></td>'
        f'<td><a href="{esc(item["url"])}" rel="license">{esc(item["label"])}</a></td></tr>'
        for item in rights_module.allowed_summary()
    )
    refused = "".join(
        f'<tr><td><code>{esc(item["id"])}</code></td><td>{esc(item["reason"])}</td></tr>'
        for item in rights_module.refused_summary()
    )
    rows = []
    for slug in config.MUSEUM_ORDER:
        entry = report.get(slug, {})
        excluded = entry.get("excluded", {}) or {}
        detail = "; ".join(f"{reason} ({n})" for reason, n in sorted(excluded.items(), key=lambda kv: -kv[1]))
        rows.append(
            f"<tr><td>{esc(config.MUSEUMS[slug]['short_name'])}</td>"
            f"<td>{entry.get('stored', 0):,}</td><td>{entry.get('playable', 0):,}</td>"
            f"<td>{esc(detail) or '—'}</td></tr>"
        )
    body = f"""<section class="wrap wrap-narrow prose">
  <p class="eyebrow">Per object, not per museum</p>
  <h1>Image rights</h1>
  <p>Museums do not hold one licence. They hold thousands of individual rights
  positions, and a collection API will happily hand you an in-copyright
  photograph next to a public-domain painting. So rights are evaluated for each
  object, from the statement its own museum published, and anything unclear is
  excluded rather than guessed at.</p>

  <h2>Licences we play</h2>
  <table><tr><th>Identifier</th><th>Licence</th></tr>{allowed}</table>
  <p>Attribution is shown on every reveal, with a link to the object at its
  museum, which satisfies the attribution terms these licences carry.</p>

  <h2>Licences we refuse</h2>
  <table><tr><th>Identifier</th><th>Why</th></tr>{refused}</table>
  <div class="callout">
    <p>NonCommercial terms are refused because this product intends to carry
    advertising eventually, and a licence that would forbid that later forbids it
    now. NoDerivatives is refused because the game crops and resizes.
    An unrecognised statement is not a permissive one.</p>
  </div>

  <h2>What the last harvest did</h2>
  <table>
    <tr><th>Museum</th><th>Considered</th><th>Cleared</th><th>Excluded, by reason</th></tr>
    {''.join(rows)}
  </table>
  <p class="card-meta">If you hold rights in something here and believe it should
  not be, the object page linked from every reveal identifies it exactly.</p>
</section>"""
    return http.html(page(
        title="Image rights",
        description=("How Past Perfect evaluates museum image rights object by object, "
                     "which licences it plays, and which it refuses."),
        body=body, path="/rights",
    ))


def not_found(request: http.Request) -> http.Response:
    body = """<section class="wrap wrap-narrow prose">
  <p class="eyebrow">404</p>
  <h1>Nothing hanging here.</h1>
  <p>The page you asked for does not exist.</p>
  <p><a class="btn" href="/daily">Play today's ten</a>
     <a class="btn btn-quiet" href="/">Home</a></p>
</section>"""
    return http.html(
        page(title="Not found", description="Page not found.", body=body,
             path="/", robots="noindex, nofollow"),
        status="404 Not Found",
    )
