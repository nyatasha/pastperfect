/**
 * Harvest, normalise and store museum objects.
 *
 * This is the only place that talks to the museums. Everything downstream --
 * the pair builder, the daily sets, the web app -- reads the local database,
 * which is what the PRD means by precomputed content and low maintenance.
 */

import * as config from "./config.ts";
import * as dates from "./dates.ts";
import * as db from "./db.ts";
import * as media from "./media.ts";
import * as rights from "./rights.ts";
import * as taxonomy from "./taxonomy.ts";
import { ADAPTERS } from "./sources/index.ts";
import { BlockedError, objectId, type RawObject } from "./sources/base.ts";

/**
 * Sampling windows. Harvesting a quota per window rather than "the first N
 * results" is what gives the game a usable spread of centuries -- without it
 * every pair would be two 19th-century prints.
 */
export const DATE_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [-4000, 500], [500, 1200], [1200, 1450], [1450, 1600], [1600, 1700],
  [1700, 1800], [1800, 1860], [1860, 1900], [1900, 1940], [1940, 2000],
];

/**
 * Roughly how many objects to aim for per museum. Rijksmuseum costs three HTTP
 * round trips per object, so it gets a smaller quota.
 */
export const DEFAULT_TARGETS: Record<string, number> = {
  met: 320, aic: 400, wellcome: 400, rijksmuseum: 220,
};

export const COLUMNS = [
  "id", "museum", "source_id", "title", "artist", "artist_note", "date_display",
  "year_start", "year_end", "year_mid", "date_precision", "medium",
  "classification", "culture", "department", "region", "credit_line",
  "object_url", "image_url", "image_key", "image_w", "image_h", "local_image",
  "license_id", "license_label", "license_url", "rights_basis", "looks_modern",
  "playable", "exclude_reason", "ingested_at",
] as const;

export type ObjectRecord = Record<(typeof COLUMNS)[number], unknown>;

export interface MuseumReport {
  museum: string;
  seen: number;
  stored: number;
  playable: number;
  excluded: Record<string, number>;
  error: string | null;
}

/** A readable date for objects whose museum published numbers but no label. */
function syntheticLabel(estimate: dates.DateEstimate | null): string {
  if (!estimate) return "";
  if (estimate.start === estimate.end) return dates.formatYear(estimate.start);
  return `${dates.formatYear(estimate.start)}–${dates.formatYear(estimate.end)}`;
}

/** Apply the date logic, the rights gate and the offline taxonomy. */
export function normalise(rawObject: RawObject): ObjectRecord {
  const now = db.nowIso();
  const estimate = dates.estimate(rawObject.date_display, rawObject.year_start, rawObject.year_end);
  const verdict = rights.evaluate(rawObject.licence_raw, rawObject.rights_basis);

  let playable = true;
  let excludeReason: string | null = null;
  if (!verdict.allowed) {
    playable = false;
    excludeReason = verdict.reason;
  } else if (!estimate) {
    playable = false;
    excludeReason = `no usable date ('${rawObject.date_display || "absent"}')`;
  } else if (!dates.playable(estimate)) {
    playable = false;
    excludeReason = `date range too wide or out of bounds (${estimate.start}-${estimate.end})`;
  }

  const id = objectId(rawObject);
  return {
    id,
    museum: rawObject.museum,
    source_id: rawObject.source_id,
    title: rawObject.title,
    artist: rawObject.artist,
    artist_note: rawObject.artist_note,
    date_display: rawObject.date_display || syntheticLabel(estimate),
    year_start: estimate ? estimate.start : 0,
    year_end: estimate ? estimate.end : 0,
    year_mid: estimate ? dates.representativeYear(estimate) : 0,
    date_precision: estimate ? estimate.precision : "unknown",
    medium: rawObject.medium,
    classification: rawObject.classification,
    culture: rawObject.culture,
    department: rawObject.department,
    region: taxonomy.regionFor(
      rawObject.culture, rawObject.department, rawObject.title, rawObject.artist_note,
    ),
    credit_line: rawObject.credit_line,
    object_url: rawObject.object_url,
    image_url: rawObject.image_url,
    image_key: media.imageKey(id),
    image_w: null,
    image_h: null,
    local_image: 0,
    license_id: verdict.detail?.license_id ?? "",
    license_label: verdict.detail?.license_label ?? "",
    license_url: verdict.detail?.license_url ?? "",
    rights_basis: verdict.detail?.rights_basis ?? rawObject.rights_basis,
    looks_modern: taxonomy.readsModern(
      rawObject.medium, rawObject.classification, rawObject.title, rawObject.department,
    ) ? 1 : 0,
    playable: playable ? 1 : 0,
    exclude_reason: excludeReason,
    ingested_at: now,
  };
}

export function store(rows: readonly ObjectRecord[]): number {
  if (rows.length === 0) return 0;
  const placeholders = COLUMNS.map(() => "?").join(", ");
  const updates = COLUMNS.filter(
    (c) => !["id", "image_w", "image_h", "local_image"].includes(c),
  )
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  const sql =
    `INSERT INTO objects (${COLUMNS.join(", ")}) VALUES (${placeholders}) ` +
    `ON CONFLICT(id) DO UPDATE SET ${updates}`;
  db.transaction((conn) => {
    const insert = conn.prepare(sql);
    for (const row of rows) insert.run(...db.params(COLUMNS.map((c) => row[c])));
  });
  return rows.length;
}

/**
 * Harvest one museum, keeping whatever it managed to hand over.
 *
 * A museum that starts refusing requests mid-run is a normal Tuesday for a free
 * public API, so a block ends that museum's harvest and leaves the rest of the
 * run -- and everything already collected -- untouched.
 */
export async function harvestMuseum(
  slug: string,
  target: number,
): Promise<{ rows: ObjectRecord[]; report: MuseumReport }> {
  const adapter = ADAPTERS[slug]!;
  const perWindow = Math.max(1, Math.ceil(target / DATE_WINDOWS.length));
  const report: MuseumReport = { museum: slug, seen: 0, stored: 0, playable: 0, excluded: {}, error: null };
  const rows = new Map<string, ObjectRecord>();

  try {
    for await (const rawObject of adapter.harvest(DATE_WINDOWS, perWindow)) {
      report.seen += 1;
      const row = normalise(rawObject);
      if (row.exclude_reason) {
        const key = String(row.exclude_reason).split("(")[0]!.trim();
        report.excluded[key] = (report.excluded[key] ?? 0) + 1;
      }
      rows.set(String(row.id), row);
    }
  } catch (error) {
    const label = error instanceof BlockedError ? String(error.message) : `${(error as Error).name}: ${(error as Error).message}`;
    report.error = `stopped early: ${label}`;
  }

  const ordered = [...rows.values()];
  report.stored = ordered.length;
  report.playable = ordered.filter((row) => row.playable === 1).length;
  return { rows: ordered, report };
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function pool<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Download derivatives for every playable object that lacks one. */
export async function fetchImages(workers = config.INGEST_WORKERS): Promise<number> {
  const rows = db.all<{ id: string; image_key: string; image_url: string }>(
    "SELECT id, image_key, image_url FROM objects WHERE playable = 1 AND local_image = 0",
  );
  if (rows.length === 0) return 0;

  const outcomes = await pool(rows, workers, async (row) => {
    try {
      return { id: row.id, size: await media.ensure(row.image_key, row.image_url) };
    } catch {
      return { id: row.id, size: null };
    }
  });

  const good = outcomes.filter((o) => o.size !== null);
  const bad = outcomes.filter((o) => o.size === null);

  // An image we could not fetch says nothing about the object's rights or its
  // date, so it clears local_image and nothing else. Only objects that are
  // playable *and* have a local image ever reach the pair builder.
  db.transaction((conn) => {
    const ok = conn.prepare(
      "UPDATE objects SET local_image = 1, image_w = ?, image_h = ?, " +
        "exclude_reason = CASE WHEN exclude_reason LIKE 'image %' THEN NULL " +
        "ELSE exclude_reason END WHERE id = ?",
    );
    for (const outcome of good) ok.run(outcome.size!.width, outcome.size!.height, outcome.id);
    const fail = conn.prepare(
      "UPDATE objects SET local_image = 0, exclude_reason = " +
        "COALESCE(NULLIF(exclude_reason, ''), 'image unavailable from the source') WHERE id = ?",
    );
    for (const outcome of bad) fail.run(outcome.id);
  });
  return good.length;
}

export async function run(
  museums?: readonly string[],
  targets?: Record<string, number>,
  log: (line: string) => void = console.log,
): Promise<db.Counts> {
  db.init();
  const slugs = museums ?? config.MUSEUM_ORDER;
  const quotas = { ...DEFAULT_TARGETS, ...(targets ?? {}) };
  const reports: Record<string, MuseumReport> = {};

  log(`Harvesting ${slugs.join(", ")} ...`);
  // Museums run concurrently: different hosts, and the throttle is per host.
  // Each result is stored as it lands, so a slow or blocked source never costs
  // us work another source already completed.
  await Promise.all(
    slugs.map(async (slug) => {
      const { rows, report } = await harvestMuseum(slug, quotas[slug] ?? 250);
      store(rows);
      reports[slug] = report;
      log(
        `  ${config.museumName(slug).padEnd(38)} ${String(report.playable).padStart(4)} playable ` +
          `of ${String(report.stored).padStart(4)} stored`,
      );
      if (report.error) log(`      ! ${report.error}`);
      for (const [reason, count] of Object.entries(report.excluded).sort((a, b) => b[1] - a[1])) {
        log(`      excluded ${String(count).padStart(4)}  ${reason}`);
      }
    }),
  );

  log("Fetching images ...");
  const fetched = await fetchImages();
  log(`  ${fetched} image derivatives on disk (${(media.diskUsage() / 1e6).toFixed(1)} MB)`);

  db.setMeta("last_ingest", db.nowIso());
  db.setMeta(
    "ingest_report",
    Object.fromEntries(
      Object.entries(reports).map(([slug, report]) => [
        slug,
        { stored: report.stored, playable: report.playable, excluded: report.excluded, error: report.error },
      ]),
    ),
  );
  return db.counts();
}
