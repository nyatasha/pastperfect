# 1. Runtime language: TypeScript on Node, not Python

**Status:** accepted · **Date:** 2026-09-04

## Context

The first implementation was Python. That was not an architectural decision —
it was a forced one. At the time the only Node on this machine was v12.10.0 with
a broken `icu4c` link (`Library not loaded: libicui18n.64.dylib`), and the nvm
copies were v8 and v12. Python 3.14 worked, so Python it was, and the choice was
never weighed against what a long-lived web product actually needs.

Node 24.20 is now installed. The constraint is gone, so the decision is worth
making properly rather than inheriting.

## What this application actually is

- A server-rendered HTML site whose SEO surface matters (homepage, four museum
  pages, explanatory pages, sitemap, structured data).
- A small JSON API whose central correctness property is a **contract with a
  JavaScript client**: a question payload must carry two opaque image URLs and
  nothing else, and the reveal payload must carry everything.
- A SQLite database of ~1,000 objects and ~23,000 precomputed questions.
- An offline build pipeline: four museum API adapters, date parsing, a rights
  gate, image derivatives, and OpenGraph cards.

## Options

1. **Keep Python.** Zero migration cost; the code exists and passes 88 tests.
2. **TypeScript on Node.** One language across client and server; the API
   contract becomes checkable rather than merely tested.
3. **Go.** Excellent single-binary deployment and speed, but it doubles down on
   the client/server language split that is this codebase's weakest seam.
4. **Rust.** Wrong tool for a two-minute daily game; cost without a matching
   benefit here.

Go and Rust were dropped early: both are strong for the server and neither does
anything about the split with a JavaScript client, which is the actual problem.

## The weighing

Weights reflect what matters for a public web product intended to live for
years, not for a prototype.

| Criterion | Weight | Python | TypeScript | Note |
| --- | --: | --: | --: | --- |
| Deployment reach and cost | 5 | 3 | 5 | Node runs on every PaaS; a Hono app moves to Workers, Deno or Bun by swapping an adapter. Python needs a container and rules out edge entirely. |
| API contract safety | 5 | 2 | 5 | Today the no-spoiler guarantee is a runtime test that greps JSON for date-shaped strings. In TypeScript the question type structurally cannot hold reveal fields — the compiler enforces it. |
| One language, client and server | 4 | 1 | 5 | The client is already JavaScript. Two languages means the payload shape is written twice and agreed by hand. |
| Web ecosystem depth | 4 | 3 | 5 | Routing, SSR, sessions, edge runtimes, observability. |
| Contributor pool for a web product | 3 | 3 | 5 | |
| Data and image pipeline | 3 | 5 | 4 | Pillow and `re` are lovely. `sharp` is faster; the regex work ports directly. |
| Runtime performance here | 2 | 3 | 4 | Both are far above what this workload needs. |
| Migration cost | 4 | 5 | 2 | Counts against switching. |
| **Weighted total** | | **91** | **133** | |

## Decision

Reimplement in TypeScript on Node 24.

Two things decided it. The first is the contract: this game's whole premise is
that a player cannot see a date before they answer, and that guarantee currently
survives on a test that inspects a JSON string. Typed shared between the server
that produces the payload and the client that consumes it, the guarantee moves
from "we check" to "it cannot compile otherwise".

The second is timing. Migration cost is the only criterion that favours staying,
and it is at its lowest point it will ever reach: the code is one session old and
has 88 tests that serve as an executable specification to port against. That cost
only rises from here.

## Stack

- **Node 24, ESM, TypeScript** run directly via native type stripping — no build
  step in development, `tsc` used purely as a type checker.
- **Hono** for routing. Tiny, dependency-free, and built on standard `Request`
  and `Response`, which is what keeps the edge-deployment option open.
- **`node:sqlite`**, built into the runtime, so there is no native module to
  compile. It is still marked experimental, so all of it is confined to `db.ts`;
  swapping in `better-sqlite3` is a one-file change.
- **`sharp`** for image derivatives and for rasterising the OpenGraph cards from
  SVG, which avoids a canvas dependency.
- **`node:test`** for tests, so the test suite adds no dependencies at all.

Four runtime dependencies in total.

## Consequences

- The database, its schema and the committed seed are unchanged: this is a
  rewrite of the code around the data, not a data migration.
- `static/` is untouched. The stylesheet and client scripts were already
  framework-free and needed no port.
- The Python implementation is removed rather than left to rot beside its
  replacement. It remains in history at commit `d104b17`.
- `node:sqlite`'s experimental status is a real risk, accepted knowingly and
  contained to one module.
