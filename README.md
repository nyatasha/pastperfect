# Past Perfect

**Which came first? Trust your eye.**

A daily visual dating game built entirely from open museum data. Two objects
appear side by side with no title, no maker, no date and no museum. Pick the
older one. Ten a day.

Built against `Past_Perfect_PRD.md` (P0 launch scope). TypeScript on Node 24.

---

## Running it

```bash
nvm use            # Node 24, per .nvmrc
npm install
npm start          # http://localhost:8000
```

The first run needs a collection. Either rebuild from the committed snapshot
(no network, fast) or harvest fresh from the four museums:

```bash
npm run pp -- import-seed   # 1,034 normalised objects from data/seed
npm run pp -- images        # fetch the pictures (~170 MB)
npm run build               # pairs, daily sets, share cards, checks
```

```bash
npm run ingest              # or: harvest the museums directly
npm run build
```

```bash
npm test                    # 99 tests, no test framework to install
npm run typecheck           # tsc in strict mode; emits nothing
```

There is no build step. Node 24 runs the TypeScript directly by stripping
types; `tsc` is used only as a checker.

## The command line

`npm run pp -- <command>`

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

`npm run doctor` re-checks all of this against the live database.

## The contract

`src/contract.ts` is the reason this is TypeScript. The game's whole premise is
that a player cannot learn anything about an object before answering, and that
promise lives in the shape of two payloads.

`QuestionSide` holds an image URL and its dimensions. It cannot hold a title, a
date or a museum, and `api.ts` builds one in exactly one place, so a leak is a
compile error rather than a spoiler in production. Try it: add `year: number` to
`QuestionSide` and `npm run typecheck` fails in two places, one of them the test
that asserts the type is exactly those three fields.

The runtime test that greps a question payload for date-shaped strings is still
there. It is now the second line of defence rather than the only one.

## Where AI is, and is not

No language model decides which object came first, and normal play makes no
model call at all. The PRD's AI responsibilities are all offline, in the build
step, and live in two modules:

- `taxonomy.ts` — classifies metadata by region and estimates whether an object
  *reads* older or newer than it is, which is what makes a pair deceptive.
- `insights.ts` — assembles the one-line reveal caption from fields already in
  the database. Grounded by construction: it cannot state a fact the record does
  not contain, and it never claims a year the museum did not.

Both are transparent keyword heuristics today. They are the seam where an
offline model pass would slot in; everything downstream only reads the columns
they write, and `retag` recomputes them without touching the museums.

## Light and dark

The default is Museum Publication: warm ivory, editorial serif, generous
margins. Dark is Gallery Dark — a darkened exhibition room, where the object is
the only bright thing on screen, which is where the eye belongs in a game about
looking.

With no stored preference the page follows the operating system, in CSS alone.
The toggle in the header pins a choice; toggling back to whatever the system
already wants releases the pin. A small script in `<head>` applies a stored
choice before the stylesheet paints, so a returning player never sees a flash of
the wrong theme.

Dark mode is a swap of custom properties, not a second stylesheet. That holds
only while every colour comes from a token, so `test/theme.test.ts` fails the
build if a colour literal appears outside the palette blocks, or if the two dark
blocks — one for a system preference, one for an explicit choice — drift apart.

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
`render.adSlot()` so that a future change has to name a placement that already
passed review, and so personalised advertising cannot quietly precede the
certified consent platform the PRD requires for the UK and EEA. No accounts, no
subscription, no museum dashboards, and no P1 modes.

**Retention, local only.** Streak, score distribution, Museum Passport,
achievements, and an Art Eye rating with a weak-period insight — all computed in
the browser from local storage. A daily reminder is offered only after several
completed dailies, and never on a first visit.

## Layout

```
src/
  contract.ts    the payload shapes the compiler enforces
  config.ts      every tunable rule in one auditable place
  dates.ts       museum date labels -> intervals   (the correctness core)
  rights.ts      the per-object image rights gate
  taxonomy.ts    offline metadata heuristics
  rng.ts         seeded randomness, so a day regenerates identically
  sources/       one thin adapter per museum API
  ingest.ts      harvest -> normalise -> store
  pairs.ts       the provable question pool
  daily.ts       deterministic daily sets
  insights.ts    the grounded reveal caption
  media.ts       local image derivatives, served under an opaque key
  og.ts          spoiler-free share cards, SVG rasterised by sharp
  db.ts          node:sqlite, confined to this file
  store.ts       read and write queries
  app.ts         Hono routing;  views.ts  pages;  api.ts  JSON;  render.ts  HTML
  server.ts      the only Node-shaped file in the web layer
static/          one stylesheet, three scripts, no build step
tools/shoot.ts   drive and screenshot the running site over CDP (dev only)
data/seed/       the normalised collection, so the database rebuilds offline
test/            99 tests on node:test
docs/            why this is TypeScript, and what it was weighed against
```

Four runtime dependencies: `hono`, `@hono/node-server`, `sharp`, and Node's own
`node:sqlite`. Tests and the type checker add two dev dependencies.

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
