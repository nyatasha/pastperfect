# Developing and running Past Perfect

Everything operational lives here: how to run it, how to test it, how to read
the numbers, and how it gets deployed. [`README.md`](README.md) is about what
the game is; this is about working on it.

---

## Getting started

Node 24 and nothing else. There is no build step: Node runs the TypeScript
directly by stripping types, and `tsc` is used only as a checker.

```bash
nvm use            # Node 24, per .nvmrc
npm install
npm start          # http://localhost:8000
```

The first run needs a collection, and there is no snapshot in the repository to
rebuild it from: `data/seed/objects.json` maps each `image_key` to its object's
dates, which is exactly the lookup the opaque image key exists to prevent, so it
is not committed. If you have one — from a previous run, or copied off a machine
that does — it still rebuilds without touching the network:

```bash
npm run pp -- import-seed   # normalised objects from data/seed
npm run pp -- images        # fetch the pictures (~165 MB)
npm run build               # pairs, daily sets, share cards, checks
```

Otherwise harvest the museums directly, which takes about ten minutes:

```bash
npm run ingest
npm run build
```

`npm run dev` is the same server under `--watch`.

## Tests

```bash
npm test           # 170 tests
npm run typecheck  # tsc, strict; emits nothing
npm run doctor     # checks every stored answer is still provable
```

| Suite | Covers |
| --- | --- |
| `dates.test.ts` | 25 tests on the date parser — the correctness core |
| `pairs.test.ts` | Non-overlap, difficulty scoring, near-duplicate rejection, captions |
| `daily.test.ts` | Determinism, no repeats, cooldown, the difficulty curve |
| `app.test.ts` | Every route, the JSON API, the no-spoiler guarantee, the metrics door |
| `rights.test.ts` | The licence allow list and what it refuses |
| `links.test.ts` | What a status means: a bot wall is not a dead link |
| `taxonomy.test.ts` | Form labels, including that one can never carry a digit |
| `theme.test.ts` | That dark mode stays a token swap and cannot rot |

`node:test` is the runner, so the suite adds no dependencies.

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
tools/social-card.ts  regenerate static/img/social.png, the link preview card
data/seed/       the normalised collection, gitignored; rebuilds the db offline
test/            170 tests on node:test
docs/            why this is TypeScript, and what it was weighed against
```

Four runtime dependencies: `hono`, `@hono/node-server`, `sharp`, and Node's own
`node:sqlite`.

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
   copyright and anything unrecognised are excluded.
4. **Pair.** Two objects become a question only when their intervals do not
   overlap. Overlapping ranges are not close calls; they are unanswerable.
5. **Serve.** Images are cached locally and served under an opaque hash.

```bash
npm run pp -- retag    # recompute the derived heuristics without re-harvesting
npm run pp -- stats    # what is in the database
```

---

# Checking the metrics

## The two things that measure anything

| | What it sees | Where it lives |
| --- | --- | --- |
| **First-party events** | What players *do* — rounds, answers, completions, shares, errors | Your own SQLite, on the Fly volume |
| **GoatCounter** | Page views and **where visitors came from** | goatcounter.com, cookieless |

They are deliberately not joined up. The first-party pipe cannot see a visitor
who never starts a round, and cannot see a referrer; GoatCounter cannot see
anything about gameplay. Between them there are no cookies and nothing stored
on a visitor's device by either, which is the whole basis for the site carrying
no consent banner.

## Read the words correctly

The single most important thing to understand before quoting any of these
numbers:

> **`session` is not a session, and it is not a user.** It is a random id the
> browser generated for itself and put in `localStorage`, which never rotates
> and never expires. It is a **browser profile**. One person on a phone and a
> laptop is two. A cleared browser is a third. A browser with storage blocked
> reports the literal string `anon`, which collapses all such visitors into one.

| Word | What it actually means |
| --- | --- |
| **browsers seen** | Distinct localStorage ids that emitted any event. The honest ceiling of "users" — never call it unique users. |
| **player** | A browser that **finished** a daily. Someone who starts and abandons is not a player. |
| **played today** | Finished at least one daily edition today. Not "visited today". |
| **round / board** | One loaded set of questions — a daily ten *or* an endless page. `round_start` fires for both, split by its `mode` prop. |
| **dailies finished** | Rows in `daily_results`: one per (date, edition, browser). Three museum editions in a day is 3 finishes, 1 player. Reloading cannot double it. |
| **reached the result** | The `daily_complete` *event*, which does not dedupe. Higher than "dailies finished" by exactly the replays. |
| **endless** | Has no completion. `round_start{mode:endless}` starts it, `endless_end` ends it — and a player who wanders off mid-run sends neither an end nor anything else, so endless ends undercount by design. |
| **questions answered** | Rows in `answer_log`, which stores a browser's **first** answer to a given pair only. Undercounts volume; the `answer` event row under EVENTS is the truer count. |
| **accuracy** | Correct ÷ answers over that deduped first-attempt log. A difficulty signal, not "how often people are right". |
| **came back at all** | Browsers that finished a daily on 2+ distinct dates. The most trustworthy number in the report, and it under-reports rather than over-reports. |

## Reading the first-party numbers

Locally, against your own database:

```bash
npm run pp -- metrics            # 30-day window by default
npm run pp -- metrics --days 7   # a shorter one
npm run pp -- stats              # what is in the collection
```

On production the database lives on the Fly volume, so run it there:

```bash
fly ssh console -a pastperfect -C "node src/cli.ts metrics"
```

Or over HTTP, which needs `PASTPERFECT_METRICS_TOKEN` set as a Fly secret:

```bash
fly secrets set PASTPERFECT_METRICS_TOKEN="$(openssl rand -hex 24)" -a pastperfect

curl -H "Authorization: Bearer $TOKEN" \
  "https://pastperfect.fly.dev/api/metrics?days=30"
```

`?token=…` works too. With no token configured the route **404s rather than
403s**, so a deployment that has not opted in does not advertise a door for
somebody to knock on. The comparison is constant-time, so it cannot be probed a
character at a time.

Everything in the report respects `--days` / `?days=`, including the funnel.
None of it reaches a player: how many people played today is an operator's
number, and `Standing` tells a player only what share of the field they beat.

### What the report contains

- **ALL TIME** — browsers seen, dailies finished, questions answered, accuracy.
- **TODAY** — players, finishes, median score, and the 0–10 distribution.
- **BY DAY** — players, finishes, answers and accuracy per date.
- **RETENTION** — browsers bucketed by how many distinct days they played.
- **WHAT THEY DID** — boards loaded split daily/endless, the daily start →
  result rate, endless runs ended, zooms, reviews, shares, and browser errors.
- **EDITIONS** — which museum dailies people actually play.
- **EVENTS** — every event name, its count and how many browsers sent it.
- **HARDEST QUESTIONS** — the ten lowest-scoring pairs above the sample floor.

### Digging past the summary

The summary is a view over `events`, whose props are JSON. Anything not
summarised is one query away:

```bash
fly ssh console -a pastperfect
sqlite3 /data/pastperfect.db

-- what people shared, broken out by how
SELECT json_extract(props,'$.mode') AS how, COUNT(*)
FROM events WHERE name='share' GROUP BY how;

-- which achievements get shared
SELECT json_extract(props,'$.achievement') AS id, COUNT(*)
FROM events WHERE name='share' AND json_extract(props,'$.mode')='achievement'
GROUP BY id ORDER BY 2 DESC;

-- how long endless runs get
SELECT json_extract(props,'$.answered') AS answered, COUNT(*)
FROM events WHERE name='endless_end' GROUP BY answered ORDER BY 1;

-- what is actually breaking in players' browsers
SELECT created_at, props FROM events
WHERE name='client_error' ORDER BY created_at DESC LIMIT 20;
```

Props are always valid JSON — an oversized bag is dropped whole rather than
truncated, because `json_extract` raises on malformed text and one bad row
would take the whole report down.

## Reading GoatCounter

<https://pastperfect.goatcounter.com> — page views, top pages, referrers,
countries, browsers. This is the only place that answers *"did that post
work?"*, which is exactly why it is there.

It is one `<script>` tag rendered by `render.analyticsTag()`, pointed at
`config.GOATCOUNTER`. It sets no cookie, writes nothing to the device and does
not fingerprint; uniqueness is a server-side daily-rotating hash, and the data
is EU-hosted. The tag is omitted entirely unless the endpoint is an `https:`
URL, and `PASTPERFECT_GOATCOUNTER=off` removes it. GoatCounter's own script
declines to count anything served from localhost, so local work does not
pollute the numbers.

If you ever add a second third-party script, `app.test.ts` fails — the test
asserts there is exactly one, because "no consent banner" is a claim that has to
stay true.

## Application and service health

```bash
curl https://pastperfect.fly.dev/api/health   # ok, objects, pairs, today's puzzle, last ingest
fly status -a pastperfect                     # machine state
fly checks list -a pastperfect                # the /api/health check in fly.toml
fly logs -a pastperfect                       # live; short retention, not a record
```

**Do not build request-rate, status-code or latency metrics into the app.**
Fly already collects them: <https://fly-metrics.io> (sign in with your Fly
account) carries fly-proxy request counts by status code and request-duration
histograms per app, plus machine CPU, memory and disk. That is where to look
when something is slow or throwing 500s.

Server exceptions are `console.error`'d by `app.onError` and go to `fly logs`
only — nothing persists them. Client-side errors *are* persisted, as
`client_error` events, capped at five distinct problems per page load so a
render that throws on every frame cannot flood the server.

There is deliberately **no uptime monitor or alerting**. Fly restarts a machine
that fails its health check; nothing will email you, and nothing is watching
overnight.

---

## Configuration

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
| `PASTPERFECT_GOATCOUNTER` | the site's own endpoint | The GoatCounter count URL. `off` removes the tag. |
| `PASTPERFECT_HOST` | `127.0.0.1` | Set to `0.0.0.0` in a container. |
| `PASTPERFECT_DB` / `_MEDIA` / `_OG` | under `data/` | Where the database, pictures and share cards live. Split across image and volume in a deployment. |
| `PASTPERFECT_BAKED_DB` | `data/pastperfect.db` | The database inside a deployment image, copied to the volume on first boot only. |

## Search engines

Nothing here needs a build step or a plugin. `src/render.ts` puts the title,
description, canonical, robots directive, OpenGraph tags and JSON-LD into every
page's head; `src/app.ts` serves `/robots.txt` and `/sitemap.xml` from the same
route table the site is built from, so a new page cannot be added to one and
forgotten in the other. `test/seo.test.ts` fetches every URL the sitemap offers
and fails if it redirects, 404s, canonicalises elsewhere, carries `noindex`, or
repeats another page's title.

Two things are worth knowing before changing any of it.

**`PASTPERFECT_BASE_URL` is load-bearing.** Every canonical, every OpenGraph
URL and every `<loc>` in the sitemap is built from it. A deployment that
forgets it advertises `http://localhost:8000` to Google.

**The two OpenAI crawlers are different decisions.** `OAI-SearchBot` fetches
pages so they can appear in ChatGPT Search; it is named in `robots.txt` and
allowed, which is what makes the site eligible to be cited there. `GPTBot`
collects pages for model training, which is a separate question nobody has
answered yet -- so it is not named at all, and falls through to the `*` group
like any other crawler. Blocking one does not block the other.

## Deployment

Past Perfect needs a host that runs Node. Every page is server-rendered, and
`POST /api/answer` decides the answer on the server so a player cannot read it
out of the page. That rules out GitHub Pages, which serves static files only,
and is why `nyatasha.github.io/pastperfect` shows the README instead of the game.

### Two images

The collection — 166 MB of pictures and a built database — is neither in git nor
rebuilt per deploy. Rebuilding it would mean re-downloading a thousand images
from four free museum APIs every time. It lives in its own image instead:

| | Built | Contains | Changes when |
| --- | --- | --- | --- |
| `Dockerfile.collection` | locally, rarely | pictures + database | the museums are re-harvested |
| `Dockerfile` | anywhere, per deploy | the app | code changes |

The app build pulls the collection with `COPY --from`, so it builds identically
on a laptop that has `data/` and on a runner that does not. A code deploy pushes
about a megabyte.

### First deploy

```bash
brew install flyctl && fly auth login

npm run ingest && npm run build         # if data/ is empty; import-seed instead, given a seed
npm run collection:build
npm run image:build                     # check it builds before involving Fly

fly launch --no-deploy --copy-config --name pastperfect --region lhr
fly volumes create pastperfect_data --size 1 --region lhr
fly deploy --build-arg COLLECTION=pastperfect-collection:local
```

`app` in `fly.toml` and `PASTPERFECT_BASE_URL` must name the same host, and the
volume must be in `primary_region`. Neither mismatch fails loudly: the site
serves fine while every canonical URL and OpenGraph tag points somewhere that
does not exist.

### Deploys from GitHub Actions

Once the collection is in a registry, `.github/workflows/deploy.yml` runs the
tests and then ships every push to main.

```bash
echo $CR_PAT | docker login ghcr.io -u <you> --password-stdin
COLLECTION_IMAGE=ghcr.io/<you>/pastperfect-collection:2026-09 npm run collection:push
fly tokens create deploy        # -> Settings > Secrets > FLY_API_TOKEN
```

Then set `COLLECTION_IMAGE` in the workflow to that tag. It is pinned rather
than `:latest` so a deploy cannot quietly pick up a collection nobody tested.
Re-harvest the museums, push a new tag, bump the value.

The workflow re-runs the tests before deploying rather than trusting a parallel
job, and smoke-tests the live site afterwards — a deploy that goes green while
the site serves errors is worse than one that fails.

### Going back

A release is only an image, and the volume is not part of it, so going back a
version does not touch a single streak or score.

```bash
fly releases -a pastperfect                   # what shipped, and when
fly deploy -a pastperfect --image <ref>       # ship a previous one again
```

Take `<ref>` from the release list. Reverting the commit and letting main deploy
works too and leaves git honest about what is live, but it waits for the tests;
the image swap is the one to reach for when the site is actually broken.

Two things do *not* come back on their own. A database migration that has
already run against `/data` is still applied, because the volume outlives the
image. And a release pinned to an older `COLLECTION_IMAGE` brings that
collection's pictures with it, so a rollback across a re-harvest changes which
objects exist — check the tag in the release you are going back to.

## Operating it

`prepare` runs at boot: it copies the baked database to `/data` the first time
and leaves it alone afterwards, so a deploy replaces the image without resetting
streaks, scores or per-question success rates. Share cards render to the volume.

Daily sets are precomputed in batches, and a batch runs out. A day that is asked
for and missing is built on the spot, which is safe because generation is
deterministic from the date — a lazily built day is identical to the one a batch
would have produced. So the daily cannot simply stop, and `pp daily` is an
optimisation rather than an obligation.

Museum URL schemes rot without warning — the Rijksmuseum moved every object page
once already — and a dead "See the object" link breaks both the point of the
game and the attribution these licences require. So the links are checked
against the museums themselves:

```bash
npm run pp -- check-links   # samples object pages per collection and reports
```

It exits non-zero only when a museum's links are provably gone, never when a
museum merely refuses a bot, so it is safe to run on a schedule. It is kept out
of `doctor` deliberately: `doctor` is offline and deterministic, and this is
neither.

SQLite is a single writer on one disk, so `fly.toml` pins one machine and scales
to zero rather than out, waking in a few hundred milliseconds on the first
request.

| | |
| --- | --- |
| Image | ~618 MB, of which 166 MB is the collection |
| Machine | `shared-cpu-1x`, 512 MB — measured peak is 137 MB under load |
| Volume | 1 GB at `/data` for the database and share cards |
| Health check | `GET /api/health`, which reports whether questions exist |

Any host that runs a container works the same way: build the Dockerfile, mount a
disk at `/data`, set `PASTPERFECT_BASE_URL`. Hono is built on standard
`Request`/`Response` and `server.ts` is the only Node-shaped file in the web
layer, so another runtime is a one-file change.
