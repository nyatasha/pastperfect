# Past Perfect

**Which came first? Trust your eye.**

A daily visual dating game built entirely from open museum data. Two objects
appear side by side with no title, no maker, no date and no museum. Pick the
older one. Ten a day.

Built against `Past_Perfect_PRD.md` (P0 launch scope).

---

## Running it

Nothing to install. Python 3.11+ and a browser.

```bash
python3 run.py                     # http://localhost:8000
```

The first run needs a collection. Either rebuild from the committed snapshot
(no network, fast) or harvest fresh from the four museums:

```bash
python3 -m pastperfect import-seed   # 1,034 normalised objects from data/seed
python3 -m pastperfect images        # fetch the pictures (~170 MB)
python3 -m pastperfect build         # pairs, daily sets, share cards, checks
```

```bash
python3 -m pastperfect ingest        # or: harvest the museums directly
python3 -m pastperfect build
```

Run the tests with `python3 -m unittest discover -s tests -t .`.

## The command line

| Command | What it does |
| --- | --- |
| `ingest` | Harvest objects and images from the four museums |
| `images` | Fetch any missing image derivatives |
| `retag` | Recompute the derived heuristics without re-harvesting |
| `pairs` | Rebuild the question pool and the daily sets |
| `daily` | Precompute daily sets only |
| `cards` | Render the spoiler-free OpenGraph share cards |
| `build` | `pairs` + `cards` + `doctor` |
| `doctor` | Check every stored answer is still provable |
| `serve` | Run the site |
| `stats` | What is in the database |
| `export-seed` / `import-seed` | Move the normalised collection in and out of JSON |

## How a question is made

The game only asks questions it can prove the answer to.

1. **Harvest.** Objects are sampled from the Met, the Art Institute of Chicago,
   Wellcome Collection and the Rijksmuseum across ten date windows, so the pool
   spans centuries instead of piling up in the 1800s.
2. **Date.** Each museum's structured begin/end fields are reconciled with its
   written date label into an interval. A label that admits vagueness — *ca.*,
   *17th century*, *18--* — widens the interval; it never produces a confident
   guess. Objects dated more loosely than 150 years never play.
3. **Rights.** Image rights are evaluated per object against an allow list, from
   the statement the museum itself published. NonCommercial, NoDerivatives, in
   copyright and anything unrecognised are all excluded. How each decision was
   reached is stored alongside the object and shown at `/rights`.
4. **Pair.** Two objects become a question only when their intervals do not
   overlap. Whatever the true date of each turns out to be inside its range, one
   is unambiguously earlier. Overlapping ranges are not close calls; they are
   unanswerable, and they are never asked.
5. **Serve.** A question payload contains two opaque image URLs and nothing
   else. Dates, titles, makers and museums arrive only after the player commits,
   from `POST /api/answer`, where the answer is computed by comparing two stored
   intervals.

`python3 -m pastperfect doctor` re-checks all of this against the live database.

## Where AI is, and is not

No language model decides which object came first, and normal play makes no
model call at all. The PRD's AI responsibilities are all offline, in the build
step, and live in two modules:

- `taxonomy.py` — classifies metadata by region and estimates whether an object
  *reads* older or newer than it is, which is what makes a pair deceptive.
- `insights.py` — assembles the one-line reveal caption from fields already in
  the database. Grounded by construction: it cannot state a fact the record does
  not contain.

Both are transparent keyword heuristics today. They are the seam where an
offline model pass would slot in; everything downstream only reads the columns
they write, and `retag` recomputes them without touching the museums.

## What is here

**P0, complete.** Daily Challenge (ten questions, identical worldwide, changing
at midnight UTC), Endless mode, museum-specific editions of both, responsive
mobile and desktop UI with keyboard support, local streak and statistics with no
account, precomputed deterministic answers, all four museums ingested into a
normalised SQLite database, a per-object rights gate, spoiler-free OpenGraph
share cards, first-party cookieless analytics, and SEO-ready homepage and museum
pages with structured data and a sitemap.

**Deliberately not here.** No advertising — v0 ships clean, and
`config.ADS_ENABLED` stays off. The permitted placements are encoded in
`render.ad_slot()` so that a future change has to name a placement that already
passed review, and so personalised advertising cannot quietly precede the
certified consent platform the PRD requires for the UK and EEA. No accounts, no
subscription, no museum dashboards, and no P1 modes.

**Retention, local only.** Streak, score distribution, Museum Passport,
achievements, and an Art Eye rating with a weak-period insight — all computed in
the browser from local storage. A daily reminder is offered only after several
completed dailies, and never on a first visit.

## Layout

```
pastperfect/
  config.py      every tunable rule in one auditable place
  dates.py       museum date labels -> intervals   (the correctness core)
  rights.py      the per-object image rights gate
  taxonomy.py    offline metadata heuristics
  sources/       one thin adapter per museum API
  ingest.py      harvest -> normalise -> store
  pairs.py       the provable question pool
  daily.py       deterministic daily sets
  insights.py    the grounded reveal caption
  media.py       local image derivatives, served under an opaque key
  og.py          spoiler-free share cards
  store.py       read and write queries
  app.py         routing;  views.py  pages;  api.py  JSON;  http.py  WSGI core
  server.py      threaded standard-library dev server
static/          one stylesheet, three scripts, no build step
data/seed/       the normalised collection, so the database rebuilds offline
tests/           76 tests, no third-party runner
```

## Data sources

| Museum | API | Rights signal used |
| --- | --- | --- |
| The Metropolitan Museum of Art | [metmuseum.github.io](https://metmuseum.github.io/) | `isPublicDomain` on the object record |
| Art Institute of Chicago | [api.artic.edu](https://api.artic.edu/docs/) | `is_public_domain` on the artwork record |
| Wellcome Collection | [developers.wellcomecollection.org](https://developers.wellcomecollection.org/api/catalogue) | licence stated on each IIIF image location |
| Rijksmuseum | [data.rijksmuseum.nl](https://data.rijksmuseum.nl/docs/search) | rights statement on the object's VisualItem |

All four are used without an API key, at a request rate each host tolerates, and
identified by a `User-Agent` naming this application.

Past Perfect is not affiliated with any of these institutions and implies no
endorsement.
