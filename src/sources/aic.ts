/**
 * Art Institute of Chicago — public API.
 *
 * https://api.artic.edu/docs/ — no key required, but the docs ask callers to
 * identify themselves with an `AIC-User-Agent` header. Rights come from the
 * API's `is_public_domain` flag; images are served over IIIF.
 */

import * as config from "../config.ts";
import { BlockedError, clean, fetchJson, raw, type RawObject } from "./base.ts";

export const MUSEUM = "aic";
const API = "https://api.artic.edu/api/v1";
const IIIF = "https://www.artic.edu/iiif/2";

/**
 * The size the Art Institute documents and keeps warm. Asking for anything
 * larger makes the server derive a fresh image and the request simply hangs.
 */
export const IIIF_WIDTH = 843;

const HEADERS = { "AIC-User-Agent": config.USER_AGENT };

const FIELDS = [
  "id", "title", "artist_display", "artist_title", "date_display", "date_start",
  "date_end", "image_id", "is_public_domain", "credit_line", "medium_display",
  "classification_title", "place_of_origin", "department_title", "artwork_type_title",
].join(",");

/**
 * The search endpoint refuses deep pagination, so each window is sampled
 * shallowly and variety comes from having many windows rather than many pages.
 */
const MAX_PAGE = 15;
const PAGE_SIZE = 100;

function toRecord(row: Record<string, unknown>): RawObject | null {
  const imageId = clean(row["image_id"]);
  const title = clean(row["title"]);
  if (!imageId || !title) return null;

  let artist = clean(row["artist_title"]);
  const artistDisplay = clean(row["artist_display"]);
  let note: string | null = null;
  if (artistDisplay && artist && artistDisplay.startsWith(artist)) {
    note = clean(artistDisplay.slice(artist.length).replace(/^[\s,]+/, ""));
  } else if (artistDisplay && !artist) {
    artist = artistDisplay.split("\n")[0]!;
  }

  return raw({
    museum: MUSEUM,
    source_id: String(row["id"]),
    title,
    object_url: `https://www.artic.edu/artworks/${row["id"]}`,
    image_url: `${IIIF}/${imageId}/full/${IIIF_WIDTH},/0/default.jpg`,
    licence_raw: row["is_public_domain"] ? "cc0" : null,
    rights_basis: "is_public_domain flag on the Art Institute of Chicago API record",
    date_display: clean(row["date_display"]) ?? "",
    year_start: (row["date_start"] as number | undefined) ?? null,
    year_end: (row["date_end"] as number | undefined) ?? null,
    artist,
    artist_note: note,
    medium: clean(row["medium_display"]),
    classification: clean(row["classification_title"]) ?? clean(row["artwork_type_title"]),
    culture: clean(row["place_of_origin"]),
    department: clean(row["department_title"]),
    credit_line: clean(row["credit_line"]),
  });
}

export async function* harvest(
  windows: ReadonlyArray<readonly [number, number]>,
  perWindow: number,
): AsyncGenerator<RawObject> {
  for (const [begin, end] of windows) {
    let collected = 0;
    for (let page = 1; page <= MAX_PAGE; page++) {
      if (collected >= perWindow) break;
      const query =
        "query[bool][must][0][term][is_public_domain]=true" +
        `&query[bool][must][1][range][date_start][gte]=${begin}` +
        `&query[bool][must][2][range][date_end][lte]=${end}` +
        "&query[bool][must][3][exists][field]=image_id" +
        `&fields=${FIELDS}&limit=${PAGE_SIZE}&page=${page}`;
      let payload: unknown;
      try {
        payload = await fetchJson(`${API}/artworks/search?${query}`, {
          museum: MUSEUM,
          headers: HEADERS,
        });
      } catch (error) {
        if (error instanceof BlockedError) throw error;
        break;
      }
      const rows = ((payload as { data?: unknown[] } | null)?.data ?? []) as Array<Record<string, unknown>>;
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
