# Past Perfect

**Which came first? Trust your eye.**

A daily visual dating game built on the open collections of four museums. Two
objects appear side by side, each labelled with what it is and who holds it and
with nothing that dates it. Pick the older one. Ten a day.

**Live site:** <https://pastperfect.fly.dev/>. `nyatasha.github.io/pastperfect`
serves this README rather than the game, because GitHub Pages hosts static files
and Past Perfect renders its pages, and decides its answers, on a server.

---

## What it does

- **Daily Challenge** — ten questions, the same ten for every player worldwide,
  changing at midnight UTC. Two minutes, then a share card you can actually send.
- **Endless** — an unlimited run that mixes difficulty as you go and never
  repeats a question, from a pool of 23,002.
- **Museum editions** — the same engine narrowed to one collection: a Met daily,
  a Rijksmuseum endless, and so on for all four.
- **No dates before you answer** — a question tells you the form of each object
  ("Photograph", "Side chair") and the museum that holds it, because you cannot
  read a picture without knowing what kind of thing it is. Titles, makers and
  dates arrive only once you have committed. The line is enforced by the type
  system: see [`src/contract.ts`](src/contract.ts).
- **Look closer without answering** — every picture has its own zoom control
  that opens a pannable, magnifiable stage. Opening it is never a guess.
- **The reveal** — both dates, the gap between them, one line of grounded
  context, and full credit with a link to the object at its museum.
- **Provable answers** — a pair is only asked when the two date ranges do not
  overlap, so one object is unambiguously older whatever the true year turns out
  to be. Close calls are close on purpose; they are never ambiguous.
- **Review your ten** — the result screen is a row of ten tiles, and each one
  opens the pair behind it: both objects, both dates, and what the difference
  was.
- **A share card, not a wall of emoji** — the result draws itself onto a card
  carrying your score, the ten, the most surprising thing you learned, and how
  you did against everyone else. Shared as an image where the browser allows it,
  copied as text where it does not.
- **Streaks and stats** — streak, finishing scores, a tiered Museum Passport,
  eighteen achievements in four categories, and an Art Eye rating that names the
  century you are worst at.
- **Light and dark** — warm ivory by default, a darkened gallery at night,
  following your system until you choose otherwise.

Your streak and statistics live in this browser's `localStorage`. There are no
accounts, no advertising, and nothing that identifies you.

## Running it locally

Node 24 and nothing else. There is no build step: Node runs the TypeScript
directly by stripping types, and `tsc` is used only as a checker.

```bash
nvm use            # Node 24, per .nvmrc
npm install
npm start          # http://localhost:8000
```

The first run needs a collection. Rebuild from the committed snapshot (no
network, fast):

```bash
npm run pp -- import-seed   # 1,034 normalised objects from data/seed
npm run pp -- images        # fetch the pictures (~165 MB)
npm run build               # pairs, daily sets, share cards, checks
```

Or harvest the museums directly, which takes about ten minutes:

```bash
npm run ingest
npm run build
```

## Tests

```bash
npm test           # 135 tests
npm run typecheck  # tsc, strict; emits nothing
npm run doctor     # checks every stored answer is still provable
```

| Suite | Covers |
| --- | --- |
| `dates.test.ts` | 25 tests on the date parser — the correctness core |
| `pairs.test.ts` | Non-overlap, difficulty scoring, near-duplicate rejection, captions |
| `daily.test.ts` | Determinism, no repeats, cooldown, the difficulty curve |
| `app.test.ts` | Every route, the JSON API, and the no-spoiler guarantee |
| `rights.test.ts` | The licence allow list and what it refuses |
| `links.test.ts` | What a status means: a bot wall is not a dead link |
| `taxonomy.test.ts` | Form labels, including that one can never carry a digit |
| `theme.test.ts` | That dark mode stays a token swap and cannot rot |

`node:test` is the runner, so the suite adds no dependencies.

## Data pipeline

The game only asks questions it can prove the answer to.

1. **Harvest.** Objects are sampled from the Met, the Art Institute of Chicago,
   Wellcome Collection and the Rijksmuseum across ten date windows, so the pool
   spans centuries instead of piling up in the 1800s.
2. **Date.** Each museum's structured begin/end fields are reconciled with its
   written date label into an interval. A label that admits vagueness — *ca.*,
   *17th century*, *18--* — widens the interval; it never produces a confident
   guess. Anything dated more loosely than 150 years never plays.
3. **Rights.** Image rights are evaluated per object against an allow list, from
   the statement the museum itself published. NonCommercial, NoDerivatives, in
   copyright and anything unrecognised are excluded. How each decision was
   reached is stored with the object and shown at `/rights`.
4. **Pair.** Two objects become a question only when their intervals do not
   overlap. Overlapping ranges are not close calls; they are unanswerable.
5. **Serve.** Images are cached locally and served under an opaque hash, so the
   URL in devtools reveals nothing about which object you are looking at.

```bash
npm run pp -- retag    # recompute the derived heuristics without re-harvesting
npm run pp -- stats    # what is in the database
```

## The contract

`src/contract.ts` is why this is TypeScript. The game's premise is that a player
cannot learn *when* an object was made before answering, and that promise lives
in the shape of two payloads.

`QuestionSide` holds an image URL, its dimensions, the object's form and the
slug of the museum that holds it — the two things you need in order to know what
you are looking at, neither of which can date a thing. `form` comes from a fixed
vocabulary and is rejected if it contains a digit. The type structurally cannot
hold a title, a maker, a medium or a date, and `api.ts` builds one in exactly one
place — so a leak is a compile error rather than a spoiler in production. Add
`year: number` to it and `npm run typecheck` fails in two places, one of them a
test asserting the type is exactly those five fields.

The runtime test that greps a question payload for date-shaped strings is still
there, now as the second line of defence rather than the only one.

## Where AI is, and is not

No language model decides which object came first, and normal play makes no
model call at all. The offline work lives in two modules:

- `taxonomy.ts` — classifies metadata by region and estimates whether an object
  *reads* older or newer than it is, which is what makes a pair deceptive.
- `insights.ts` — assembles the one-line reveal caption from fields already in
  the database. Grounded by construction: it cannot state a fact the record does
  not contain, and never claims a year the museum did not.

Both are transparent keyword heuristics. They are the seam where an offline
model pass would slot in; everything downstream only reads the columns they
write, and `retag` recomputes them without touching the museums.

## Light and dark

The default is warm ivory with an editorial serif. Dark is a darkened
exhibition room, where the object is the only bright thing on screen.

With no stored preference the page follows your operating system, in CSS alone.
The toggle in the header pins a choice; toggling back to what the system already
wants releases the pin. A small script in `<head>` applies a stored choice before
the stylesheet paints, so a returning player never sees a flash of the wrong
theme.

Dark is a swap of custom properties, not a second stylesheet. That holds only
while every colour comes from a token, so `test/theme.test.ts` fails the build if
a colour literal appears outside the palette blocks, or if the two dark blocks —
one for a system preference, one for an explicit choice — drift apart.

## Project layout

```
src/
  contract.ts    the payload shapes the compiler enforces
  config.ts      every tunable rule in one auditable place
  dates.ts       museum date labels -> intervals   (the correctness core)
  rights.ts      the per-object image rights gate
  taxonomy.ts    offline metadata heuristics
  rng.ts         seeded randomness, so a day regenerates identically
  sources/       one thin adapter per museum API
  links.ts       whether the museums' own object URLs still resolve
  ingest.ts      harvest -> normalise -> store
  pairs.ts       the provable question pool
  daily.ts       deterministic daily sets
  insights.ts    the grounded reveal caption
  media.ts       local image derivatives, served under an opaque key
  og.ts          spoiler-free share cards, SVG rasterised by sharp
  db.ts          node:sqlite, confined to this file
  store.ts       read and write queries
  metrics.ts     usage, read off the tables the game already writes
  app.ts         Hono routing;  views.ts  pages;  api.ts  JSON;  render.ts  HTML
  server.ts      the only Node-shaped file in the web layer
static/          one stylesheet, three scripts, no build step
tools/shoot.ts   drive and screenshot the running site over CDP (dev only)
data/seed/       the normalised collection, so the database rebuilds offline
test/            135 tests on node:test
docs/            why this is TypeScript, and what it was weighed against
```

Four runtime dependencies: `hono`, `@hono/node-server`, `sharp`, and Node's own
`node:sqlite`.

## Analytics

First-party and cookieless. `POST /api/events` stores an event name, the random
session id the browser made up for itself, and a small bag of properties. No IP
address is recorded and nothing can be joined back to a person.

```bash
npm run pp -- stats             # event counts and distinct sessions
npm run pp -- metrics           # players, retention, and what they did
npm run pp -- metrics --days 7  # over a shorter window than the default 30
```

The same numbers are served at `GET /api/metrics` for whoever runs the site.
That route needs `PASTPERFECT_METRICS_TOKEN`, as a `Bearer` header or a `token`
query parameter; with no token configured it 404s rather than 403s, so a
deployment that has not opted in does not advertise a door. None of it reaches a
player: how many people played today is an operator's number, and `Standing`
tells a player only what share of the field they beat.

## Configuration points

Everything tunable lives in `src/config.ts`.

| Setting | Default | Notes |
| --- | --- | --- |
| `ADS_ENABLED` | `false` | v0 ships clean. Permitted placements are encoded in `render.adSlot()`; anything else throws. Must not be enabled for UK/EEA traffic before a certified IAB TCF consent platform exists. |
| `MAX_OBJECT_SPAN_YEARS` | `150` | How loosely an object may be dated and still play. |
| `PERCENTILE_MIN_SAMPLE` | `20` | Players needed before a percentile is shown. |
| `DAILY_DIFFICULTY_CURVE` | `1,1,2,2,3,3,4,4,5,5` | The shape of a day. |
| `PASTPERFECT_BASE_URL` | `http://localhost:8000` | Canonical URLs, OpenGraph tags, sitemap. |
| `PASTPERFECT_ALLOW_ARCHIVE` | unset | Opens past dailies, which are closed in v0. |
| `PASTPERFECT_METRICS_TOKEN` | unset | Unlocks `GET /api/metrics`. Unset means the route does not exist. |
| `PASTPERFECT_HOST` | `127.0.0.1` | Set to `0.0.0.0` in a container. |
| `PASTPERFECT_DB` / `_MEDIA` / `_OG` | under `data/` | Where the database, pictures and share cards live. Split across image and volume in a deployment. |
| `PASTPERFECT_BAKED_DB` | `data/pastperfect.db` | The database inside a deployment image, copied to the volume on first boot only. |

## Deployment

Past Perfect needs a host that runs Node. Every page is server-rendered, and
`POST /api/answer` decides the answer on the server so a player cannot read it
out of the page. That rules out GitHub Pages, which serves static files only,
and is why `nyatasha.github.io/pastperfect` shows this document instead of
the game.

### Two images

The collection — 166 MB of pictures and a built database — is neither in git nor
rebuilt per deploy. Rebuilding it would mean re-downloading a thousand images
from four free museum APIs every time. It lives in its own image instead:

| | Built | Contains | Changes when |
| --- | --- | --- | --- |
| `Dockerfile.collection` | locally, rarely | pictures + database | the museums are re-harvested |
| `Dockerfile` | anywhere, per deploy | the app | code changes |

The app build pulls the collection with `COPY --from`, so it builds
identically on a laptop that has `data/` and on a runner that does not. A
code deploy pushes about a megabyte.

### First deploy

```bash
brew install flyctl && fly auth login

npm run pp -- import-seed && npm run pp -- images && npm run build   # if data/ is empty
npm run collection:build
npm run image:build                     # check it builds before involving Fly

fly launch --no-deploy --copy-config --name pastperfect --region lhr
fly volumes create pastperfect_data --size 1 --region lhr
fly deploy --build-arg COLLECTION=pastperfect-collection:local
```

`app` in `fly.toml` and `PASTPERFECT_BASE_URL` must name the same
host, and the volume must be in `primary_region`. Neither mismatch fails
loudly: the site serves fine while every canonical URL and OpenGraph tag points
somewhere that does not exist.

### Deploys from GitHub Actions

Once the collection is in a registry, `.github/workflows/deploy.yml` runs
the tests and then ships every push to main.

```bash
echo $CR_PAT | docker login ghcr.io -u <you> --password-stdin
COLLECTION_IMAGE=ghcr.io/<you>/pastperfect-collection:2026-09 npm run collection:push
fly tokens create deploy        # -> Settings > Secrets > FLY_API_TOKEN
```

Then set `COLLECTION_IMAGE` in the workflow to that tag. It is pinned
rather than `:latest` so a deploy cannot quietly pick up a collection nobody
tested. Re-harvest the museums, push a new tag, bump the value.

The workflow re-runs the tests before deploying rather than trusting a parallel
job, and smoke-tests the live site afterwards — a deploy that goes green while
the site serves errors is worse than one that fails.

### Operating it

`prepare` runs at boot: it copies the baked database to `/data` the
first time and leaves it alone afterwards, so a deploy replaces the image
without resetting streaks, scores or per-question success rates. Share cards
render to the volume.

Daily sets are precomputed in batches, and a batch runs out. A day that is asked
for and missing is built on the spot, which is safe because generation is
deterministic from the date — a lazily built day is identical to the one a batch
would have produced. So the daily cannot simply stop, and `pp daily` is an
optimisation rather than an obligation.

Museum URL schemes rot without warning — the Rijksmuseum moved every object
page once already — and a dead "See the object" link breaks both the point of
the game and the attribution these licences require. So the links are checked
against the museums themselves:

```bash
npm run pp -- check-links   # samples object pages per collection and reports
```

It exits non-zero only when a museum's links are provably gone, never when a
museum merely refuses a bot, so it is safe to run on a schedule. It is kept out
of `doctor` deliberately: `doctor` is offline and deterministic, and this is
neither.

SQLite is a single writer on one disk, so `fly.toml` pins one machine and
scales to zero rather than out, waking in a few hundred milliseconds on the
first request.

| | |
| --- | --- |
| Image | ~618 MB, of which 166 MB is the collection |
| Machine | `shared-cpu-1x`, 512 MB — measured peak is 137 MB under load |
| Volume | 1 GB at `/data` for the database and share cards |
| Health check | `GET /api/health`, which reports whether questions exist |

Any host that runs a container works the same way: build the Dockerfile, mount a
disk at `/data`, set `PASTPERFECT_BASE_URL`. Hono is built on standard
`Request`/`Response` and `server.ts` is the only Node-shaped file
in the web layer, so another runtime is a one-file change.

## Sources and attribution

| Museum | API | Rights signal used |
| --- | --- | --- |
| The Metropolitan Museum of Art | [metmuseum.github.io](https://metmuseum.github.io/) | `isPublicDomain` on the object record |
| Art Institute of Chicago | [api.artic.edu](https://api.artic.edu/docs/) | `is_public_domain` on the artwork record |
| Wellcome Collection | [developers.wellcomecollection.org](https://developers.wellcomecollection.org/api/catalogue) | licence stated on each IIIF image location |
| Rijksmuseum | [data.rijksmuseum.nl](https://data.rijksmuseum.nl/docs/search) | rights statement on the object's VisualItem |

All four are used without an API key, at a request rate each host tolerates, and
identified by a `User-Agent` naming this application. Every image is used under
an open licence stated by the museum that holds the object, and attribution with
a link to that object is shown on every reveal.

Past Perfect is not affiliated with any of these institutions and implies no
endorsement.
