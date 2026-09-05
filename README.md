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

Running it, testing it, reading the numbers and deploying it are all in
**[DEVELOPMENT.md](DEVELOPMENT.md)**.

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

## What is measured

Two things, neither of which identifies anybody and neither of which uses a
cookie.

**What players do** is recorded first-party: `POST /api/events` stores an event
name, the random id the browser made up for itself, and a small bag of
properties. No IP address is written, nothing is sent to a third party, and
nothing can be joined back to a person. It is readable only by whoever runs the
site, through a token-protected endpoint — how many people played today is an
operator's number, and the results screen tells a player only what share of the
field they beat.

**How many people visit, and where they came from** is counted by
[GoatCounter](https://www.goatcounter.com/), because the first-party events
cannot see either: they do not fire until a round starts. It sets no cookie,
stores nothing on the device and does not fingerprint.

Your streak, statistics, passport and achievements are yours alone: they live in
this browser's `localStorage` and are never uploaded.

Reading any of it: [DEVELOPMENT.md](DEVELOPMENT.md#checking-the-metrics).

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
