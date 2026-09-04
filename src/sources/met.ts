/**
 * The Metropolitan Museum of Art — Collection API.
 *
 * https://metmuseum.github.io/ — no key required. Rights come from the API's
 * own `isPublicDomain` flag, which the Met sets on the objects it has released
 * under Creative Commons Zero.
 */

import { makeRng, shuffle } from "../rng.ts";
import { BlockedError, clean, fetchJson, raw, type RawObject } from "./base.ts";

export const MUSEUM = "met";
const API = "https://collectionapi.metmuseum.org/public/collection/v1";

/**
 * How many candidate ids to try per window before giving up. Without a cap a
 * source that starts refusing requests would be walked to the end of a 15,000
 * item result list one 403 at a time.
 */
const CANDIDATE_FACTOR = 5;

async function search(begin: number, end: number): Promise<number[]> {
  const url =
    `${API}/search?hasImages=true&isPublicDomain=true&dateBegin=${begin}&dateEnd=${end}&q=*`;
  const payload = (await fetchJson(url, { museum: MUSEUM })) as { objectIDs?: number[] } | null;
  return payload?.objectIDs ?? [];
}

function toRecord(data: Record<string, unknown>): RawObject | null {
  const image = clean(data["primaryImageSmall"]) ?? clean(data["primaryImage"]);
  const title = clean(data["title"]);
  if (!image || !title) return null;
  return raw({
    museum: MUSEUM,
    source_id: String(data["objectID"]),
    title,
    object_url: clean(data["objectURL"]) ?? "",
    image_url: image,
    licence_raw: data["isPublicDomain"] ? "cc0" : null,
    rights_basis: "isPublicDomain flag on the Met Collection API object record",
    date_display: clean(data["objectDate"]) ?? "",
    year_start: (data["objectBeginDate"] as number | undefined) ?? null,
    year_end: (data["objectEndDate"] as number | undefined) ?? null,
    artist: clean(data["artistDisplayName"]),
    artist_note: clean(data["artistDisplayBio"]),
    medium: clean(data["medium"]),
    classification: clean(data["classification"]),
    culture: clean(data["culture"]) ?? clean(data["country"]),
    department: clean(data["department"]),
    credit_line: clean(data["creditLine"]),
  });
}

export async function* harvest(
  windows: ReadonlyArray<readonly [number, number]>,
  perWindow: number,
  seed = 7,
): AsyncGenerator<RawObject> {
  const rng = makeRng(seed);
  for (const [begin, end] of windows) {
    const ids = await search(begin, end);
    if (ids.length === 0) continue;
    shuffle(ids, rng);
    let wanted = 0;
    for (const objectId of ids.slice(0, perWindow * CANDIDATE_FACTOR)) {
      if (wanted >= perWindow) break;
      let data: unknown;
      try {
        data = await fetchJson(`${API}/objects/${objectId}`, { museum: MUSEUM });
      } catch (error) {
        if (error instanceof BlockedError) throw error;
        continue;
      }
      if (!data) continue;
      const record = toRecord(data as Record<string, unknown>);
      if (!record) continue;
      wanted += 1;
      yield record;
    }
  }
}
