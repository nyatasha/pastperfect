/**
 * Wellcome Collection — Catalogue API.
 *
 * https://developers.wellcomecollection.org/api/catalogue — no key required.
 * Unlike the Met and the Art Institute, Wellcome states a licence per digital
 * location, and a lot of the catalogue is in copyright, so the licence is read
 * off the actual IIIF image location rather than assumed.
 */

import * as config from "../config.ts";
import { BlockedError, clean, fetchJson, raw, type RawObject } from "./base.ts";

export const MUSEUM = "wellcome";
const API = "https://api.wellcomecollection.org/catalogue/v2";
const INCLUDE = "production,items,contributors,subjects,genres";

/**
 * Pictures and 3-D objects. The rest of the catalogue is books and archives,
 * which do not make a visual game.
 */
const WORK_TYPES = "k,r";
const PAGE_SIZE = 100;
const MAX_PAGE = 12;

interface Location {
  locationType?: { id?: string };
  license?: { id?: string };
  url?: string;
  credit?: string;
}

function imageLocation(row: Record<string, unknown>): Location | null {
  for (const item of (row["items"] as Array<{ locations?: Location[] }> | undefined) ?? []) {
    for (const location of item.locations ?? []) {
      if (location.locationType?.id === "iiif-image") return location;
    }
  }
  return null;
}

function toRecord(row: Record<string, unknown>): RawObject | null {
  const location = imageLocation(row);
  const title = clean(row["title"]);
  if (!location || !title) return null;
  const url = clean(location.url) ?? "";
  if (!url.endsWith("/info.json")) return null;
  const imageBase = url.slice(0, -"/info.json".length);

  let dateDisplay = "";
  let place: string | null = null;
  const productions =
    (row["production"] as Array<{ dates?: Array<{ label?: string }>; places?: Array<{ label?: string }> }> | undefined) ?? [];
  for (const production of productions) {
    for (const date of production.dates ?? []) {
      const label = clean(date.label);
      if (label) {
        dateDisplay = label;
        break;
      }
    }
    for (const p of production.places ?? []) place ??= clean(p.label);
    if (dateDisplay) break;
  }
  if (!dateDisplay) return null;

  const contributors = ((row["contributors"] as Array<{ agent?: { label?: string } }> | undefined) ?? [])
    .map((c) => clean(c.agent?.label))
    .filter((c): c is string => Boolean(c));
  const genres = ((row["genres"] as Array<{ label?: string }> | undefined) ?? [])
    .map((g) => clean(g.label))
    .filter((g): g is string => Boolean(g));

  const licence = location.license?.id ?? null;
  return raw({
    museum: MUSEUM,
    source_id: String(row["id"]),
    title,
    object_url: `https://wellcomecollection.org/works/${row["id"]}`,
    image_url: `${imageBase}/full/${config.IMAGE_LARGE_PX},/0/default.jpg`,
    licence_raw: licence,
    rights_basis: `licence '${licence}' stated on the IIIF image location in the Wellcome catalogue`,
    date_display: dateDisplay,
    artist: contributors[0] ?? null,
    artist_note: contributors.slice(1, 3).join(", ") || null,
    medium: genres.slice(0, 2).join(", ") || clean(row["physicalDescription"]),
    classification: (row["workType"] as { label?: string } | undefined)?.label ?? null,
    culture: place,
    credit_line: clean(location.credit) ?? "Wellcome Collection",
  });
}

export async function* harvest(
  windows: ReadonlyArray<readonly [number, number]>,
  perWindow: number,
): AsyncGenerator<RawObject> {
  for (const [begin, end] of windows) {
    if (end < 1) continue; // the catalogue does not describe BCE material
    let collected = 0;
    for (let page = 1; page <= MAX_PAGE; page++) {
      if (collected >= perWindow) break;
      const from = String(Math.max(begin, 1)).padStart(4, "0");
      const to = String(end).padStart(4, "0");
      const query =
        `include=${INCLUDE}` +
        "&items.locations.license=cc0,pdm" +
        "&items.locations.locationType=iiif-image" +
        `&workType=${WORK_TYPES}` +
        `&production.dates.from=${from}-01-01` +
        `&production.dates.to=${to}-12-31` +
        `&pageSize=${PAGE_SIZE}&page=${page}`;
      let payload: unknown;
      try {
        payload = await fetchJson(`${API}/works?${query}`, { museum: MUSEUM });
      } catch (error) {
        if (error instanceof BlockedError) throw error;
        break;
      }
      const rows = ((payload as { results?: unknown[] } | null)?.results ?? []) as Array<Record<string, unknown>>;
      if (rows.length === 0) break;
      for (const row of rows) {
        if (collected >= perWindow) break;
        const record = toRecord(row);
        if (!record) continue;
        collected += 1;
        yield record;
      }
    }
  }
}
