/**
 * Command line: harvest, build, serve, inspect.
 *
 *   npm run pp -- ingest      fetch objects and images from the museums
 *   npm run pp -- build       rebuild pairs, daily sets and share cards
 *   npm start                 run the site on localhost
 *   npm run pp -- doctor      check the database can actually run a game
 */

import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";

import * as config from "./config.ts";
import * as daily from "./daily.ts";
import * as dates from "./dates.ts";
import * as db from "./db.ts";
import * as ingest from "./ingest.ts";
import * as media from "./media.ts";
import * as og from "./og.ts";
import * as pairs from "./pairs.ts";
import * as store from "./store.ts";
import * as taxonomy from "./taxonomy.ts";

interface Options {
  museum?: string[];
  target?: number;
  days: number;
  force: boolean;
  host?: string;
  port?: number;
}

async function cmdIngest(options: Options): Promise<number> {
  const slugs = options.museum?.length ? options.museum : undefined;
  const targets = options.target
    ? Object.fromEntries((slugs ?? config.MUSEUM_ORDER).map((s) => [s, options.target!]))
    : undefined;
  console.log(JSON.stringify(await ingest.run(slugs, targets), null, 2));
  return 0;
}

async function cmdImages(): Promise<number> {
  db.init();
  const fetched = await ingest.fetchImages();
  console.log(`${fetched} derivatives fetched · ${(media.diskUsage() / 1e6).toFixed(1)} MB on disk`);
  return 0;
}

/**
 * Recompute the derived taxonomy columns from stored metadata.
 *
 * Region, the "reads modern" signal and the representative year are all derived
 * from fields we already hold, so improving any of them should not mean
 * re-harvesting four museums.
 */
function cmdRetag(): number {
  const rows = db.all<Record<string, string | number | null>>(
    "SELECT id, medium, classification, title, department, culture, artist_note, " +
      "date_display, year_start, year_end, date_precision FROM objects",
  );
  const updates = rows.map((row) => {
    const estimate: dates.DateEstimate = {
      start: Number(row["year_start"]),
      end: Number(row["year_end"]),
      precision: String(row["date_precision"]) as dates.Precision,
      display: String(row["date_display"] ?? ""),
    };
    return [
      taxonomy.regionFor(row["culture"] as string, row["department"] as string, row["title"] as string, row["artist_note"] as string),
      taxonomy.readsModern(row["medium"] as string, row["classification"] as string, row["title"] as string, row["department"] as string) ? 1 : 0,
      dates.representativeYear(estimate),
      row["id"],
    ];
  });
  db.transaction((conn) => {
    const update = conn.prepare("UPDATE objects SET region = ?, looks_modern = ?, year_mid = ? WHERE id = ?");
    for (const row of updates) update.run(...db.params(row));
  });
  const modern = updates.filter((u) => u[1] === 1).length;
  console.log(`${rows.length.toLocaleString("en-US")} objects retagged · ${modern.toLocaleString("en-US")} read as modern`);
  console.log("Run 'pairs' next: difficulty and insights are derived from these columns.");
  return 0;
}

function cmdPairs(options: Options): number {
  console.log("Building pairs ...");
  pairs.build();
  for (const row of pairs.distribution()) {
    console.log(
      `  difficulty ${row.difficulty}  ${row.n.toLocaleString("en-US").padStart(6)} pairs  ` +
        `gaps ${row.min_gap}-${row.max_gap}y  ${row.surprising ?? 0} surprising`,
    );
  }
  // Rebuilding the pool invalidates every stored daily set, so regenerate them
  // here rather than leaving the site with no puzzle until someone remembers.
  console.log("Rebuilding daily sets ...");
  daily.ensure(options.days);
  return 0;
}

function cmdDaily(options: Options): number {
  console.log("Building daily sets ...");
  daily.ensure(options.days);
  return 0;
}

async function cmdCards(options: Options): Promise<number> {
  db.init();
  const today = daily.today();
  for (let offset = 0; offset < options.days; offset++) {
    await og.render(daily.addDays(today, offset), "", options.force);
  }
  await og.defaultCard(options.force);
  console.log(`${options.days} share cards rendered`);
  return 0;
}

async function cmdBuild(options: Options): Promise<number> {
  cmdPairs(options);
  await cmdCards(options);
  return cmdDoctor();
}

async function cmdServe(options: Options): Promise<number> {
  const { start } = await import("./server.ts");
  await start(options.host ?? config.HOST, options.port ?? config.PORT);
  return 0;
}

function cmdStats(): number {
  const counts = db.counts();
  const overall = store.overallStats();
  console.log(`objects        ${counts.objects.toLocaleString("en-US")} stored, ${overall.objects.toLocaleString("en-US")} in play`);
  console.log(`pairs          ${counts.pairs.toLocaleString("en-US")}`);
  console.log(`daily days     ${counts.daily_days}`);
  console.log(`results        ${counts.results.toLocaleString("en-US")}`);
  console.log(`events         ${counts.events.toLocaleString("en-US")}`);
  console.log(`span           ${overall.earliest} to ${overall.latest}`);
  console.log(`media on disk  ${(media.diskUsage() / 1e6).toFixed(1)} MB`);
  const events = store.eventSummary();
  if (events.length > 0) {
    console.log("\nrecent events");
    for (const row of events) {
      console.log(`  ${row.name.padEnd(26)} ${row.n.toLocaleString("en-US").padStart(6)}  from ${row.sessions} sessions`);
    }
  }
  return 0;
}

/** Check the database can run a game, and that answers are provable. */
export function cmdDoctor(): number {
  db.init();
  const problems: string[] = [];
  const overall = store.overallStats();
  if (overall.objects < 50) problems.push(`only ${overall.objects} objects in play`);
  if (overall.pairs < 200) problems.push(`only ${overall.pairs} pairs built`);

  const overlapping = db.scalar(
    "SELECT COUNT(*) AS n FROM pairs p JOIN objects l ON l.id = p.left_id " +
      "JOIN objects r ON r.id = p.right_id " +
      "WHERE NOT (l.year_end < r.year_start OR r.year_end < l.year_start)",
  );
  if (overlapping) problems.push(`${overlapping} pairs have overlapping date ranges`);

  const mislabelled = db.scalar(
    "SELECT COUNT(*) AS n FROM pairs p JOIN objects l ON l.id = p.left_id " +
      "JOIN objects r ON r.id = p.right_id WHERE " +
      "(p.earlier = 'left'  AND NOT l.year_end < r.year_start) OR " +
      "(p.earlier = 'right' AND NOT r.year_end < l.year_start)",
  );
  if (mislabelled) problems.push(`${mislabelled} pairs record the wrong earlier side`);

  const allowed = Object.keys(config.ALLOWED_LICENCES);
  const unlicensed = db.scalar(
    `SELECT COUNT(*) AS n FROM objects WHERE playable = 1 AND license_id NOT IN (${allowed.map(() => "?").join(",")})`,
    allowed,
  );
  if (unlicensed) problems.push(`${unlicensed} playable objects carry a licence outside the allow list`);

  const imageless = db.scalar(
    "SELECT COUNT(*) AS n FROM pairs p JOIN objects l ON l.id = p.left_id " +
      "JOIN objects r ON r.id = p.right_id WHERE l.local_image = 0 OR r.local_image = 0",
  );
  if (imageless) problems.push(`${imageless} pairs reference an object with no local image`);

  const today = daily.today();
  for (const edition of ["", ...config.MUSEUM_ORDER]) {
    const rows = daily.questions(today, edition);
    if (rows.length < config.DAILY_QUESTIONS) {
      problems.push(`today's ${edition || "mixed"} daily has ${rows.length} questions`);
    }
  }

  if (problems.length > 0) {
    console.log("FAIL");
    for (const problem of problems) console.log(`  - ${problem}`);
    return 1;
  }
  console.log(
    `OK · ${overall.objects.toLocaleString("en-US")} objects · ${overall.pairs.toLocaleString("en-US")} pairs · ` +
      `${daily.availableDays().length} daily days · every answer provable`,
  );
  return 0;
}

/** Write the normalised objects to JSON so the database can be rebuilt offline. */
function cmdExportSeed(): number {
  const rows = db.all("SELECT * FROM objects WHERE playable = 1 ORDER BY museum, source_id");
  fs.mkdirSync(config.SEED_DIR, { recursive: true });
  const target = path.join(config.SEED_DIR, "objects.json");
  fs.writeFileSync(target, JSON.stringify(rows, null, 1), "utf8");
  console.log(`${rows.length.toLocaleString("en-US")} objects written to ${target}`);
  return 0;
}

function cmdImportSeed(): number {
  const source = path.join(config.SEED_DIR, "objects.json");
  if (!fs.existsSync(source)) {
    console.error(`no seed at ${source}`);
    return 1;
  }
  const rows = JSON.parse(fs.readFileSync(source, "utf8")) as ingest.ObjectRecord[];
  db.init();
  // The snapshot carries metadata, not pictures. Trust the disk rather than the
  // file for whether a derivative exists, so a fresh clone knows it still has
  // images to fetch and a repeat import does not re-download what it has.
  let present = 0;
  for (const row of rows) {
    row.local_image = media.hasLocal(String(row.image_key)) ? 1 : 0;
    present += Number(row.local_image);
  }
  ingest.store(rows);
  const missing = rows.length - present;
  console.log(`${rows.length.toLocaleString("en-US")} objects loaded, ${present.toLocaleString("en-US")} with images already on disk.`);
  console.log(missing ? `Run 'images' to fetch the remaining ${missing.toLocaleString("en-US")}, then 'build'.` : "Run 'build' next.");
  return 0;
}

const USAGE = `Past Perfect

  ingest        harvest objects and images from the museums
  images        fetch missing image derivatives
  retag         recompute region and visual-age heuristics
  pairs         rebuild the question pool and daily sets
  daily         precompute daily sets
  cards         render OpenGraph share cards
  build         pairs + cards + doctor
  serve         run the site on localhost
  stats         what is in the database
  doctor        check every answer is provable
  export-seed   write objects.json for offline rebuilds
  import-seed   rebuild the database from objects.json

Options: --museum <slug> (repeatable) --target <n> --days <n> --force --host <h> --port <p>`;

export async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      museum: { type: "string", multiple: true },
      target: { type: "string" },
      days: { type: "string", default: "45" },
      force: { type: "boolean", default: false },
      host: { type: "string" },
      port: { type: "string" },
    },
    allowPositionals: false,
  });

  const options: Options = {
    days: Number(values.days ?? 45),
    force: Boolean(values.force),
  };
  if (values.museum) options.museum = values.museum;
  if (values.target) options.target = Number(values.target);
  if (values.host) options.host = values.host;
  if (values.port) options.port = Number(values.port);

  db.init();
  switch (command) {
    case "ingest": return cmdIngest(options);
    case "images": return cmdImages();
    case "retag": return cmdRetag();
    case "pairs": return cmdPairs(options);
    case "daily": return cmdDaily(options);
    case "cards": return cmdCards({ ...options, days: values.days ? options.days : 14 });
    case "build": return cmdBuild(options);
    case "serve": return cmdServe(options);
    case "stats": return cmdStats();
    case "doctor": return cmdDoctor();
    case "export-seed": return cmdExportSeed();
    case "import-seed": return cmdImportSeed();
    default:
      console.error(`unknown command: ${command}\n`);
      console.log(USAGE);
      return 1;
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
