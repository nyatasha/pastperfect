/**
 * Rijksmuseum — Linked Art data service.
 *
 * https://data.rijksmuseum.nl/docs/search — no key required. The collection is
 * published as Linked Art, so a single object takes three hops: the object
 * record names a VisualItem, which carries the rights statement and names a
 * DigitalObject, which finally carries the IIIF image URL. Responses are cached
 * on disk, so the cost is paid once per object.
 */

import { BlockedError, clean, fetchJson, raw, type RawObject } from "./base.ts";

export const MUSEUM = "rijksmuseum";
const SEARCH = "https://data.rijksmuseum.nl/search/collection";

const AAT_EN = "http://vocab.getty.edu/aat/300388277";
const AAT_TITLE = "http://vocab.getty.edu/aat/300404670";
const AAT_CREDIT = "http://vocab.getty.edu/aat/300026687";
const AAT_DESCRIPTION = "http://vocab.getty.edu/aat/300435416";

/**
 * A spread of object types, so the game is not all prints. Rijksmuseum search
 * accepts English or Dutch terms for these.
 */
const TYPES = [
  "painting", "drawing", "photograph", "sculpture", "furniture", "print",
  "glass", "textile", "jewellery", "silver", "ceramic", "costume",
];

/** Names that mean "we do not know", which the interface should leave blank. */
const UNNAMED = new Set(["anonymous", "anoniem", "onbekend", "unknown", "unidentified"]);

type Node = Record<string, unknown>;

/**
 * Linked Art serialises a single value as an object, not a one-item array.
 * Every traversal below goes through this, so a record with one title behaves
 * exactly like a record with three.
 */
function asList(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function dicts(node: unknown, key: string): Node[] {
  if (typeof node !== "object" || node === null) return [];
  return asList((node as Node)[key]).filter(
    (item): item is Node => typeof item === "object" && item !== null,
  );
}

function notation(node: unknown, preferEn = true): string | null {
  if (typeof node === "string") return clean(node);
  if (typeof node !== "object" || node === null) return null;
  const values = asList((node as Node)["notation"]);
  if (values.length === 0) return clean((node as Node)["_label"]);
  const english = values.filter(
    (v) => typeof v === "object" && v !== null && (v as Node)["@language"] === "en",
  );
  const pool = preferEn && english.length > 0 ? english : values;
  for (const value of pool) {
    if (typeof value === "object" && value !== null) {
      const text = clean((value as Node)["@value"]);
      if (text) return text;
    } else if (typeof value === "string" && clean(value)) {
      return clean(value);
    }
  }
  return null;
}

const isEnglish = (node: Node): boolean =>
  dicts(node, "language").some((lang) => lang["id"] === AAT_EN);

const classified = (node: Node, aat: string): boolean =>
  dicts(node, "classified_as").some((c) => c["id"] === aat);

function title(obj: Node): string | null {
  const names = dicts(obj, "identified_by").filter((n) => n["type"] === "Name");
  for (const wantEnglish of [true, false]) {
    for (const name of names) {
      if (!classified(name, AAT_TITLE)) continue;
      if (wantEnglish && !isEnglish(name)) continue;
      const text = clean(name["content"]);
      if (text) return text;
    }
  }
  for (const name of names) {
    const text = clean(name["content"]);
    if (text) return text;
  }
  return null;
}

function referred(obj: unknown, aat: string): string | null {
  const notes = dicts(obj, "referred_to_by").filter((n) => classified(n, aat));
  for (const wantEnglish of [true, false]) {
    for (const note of notes) {
      if (wantEnglish && !isEnglish(note)) continue;
      const text = clean(note["content"]);
      if (text) return text;
    }
  }
  return null;
}

function yearOf(iso: unknown): number | null {
  if (!iso) return null;
  const text = String(iso);
  const negative = text.startsWith("-");
  const digits = text.replace(/^-/, "").split("-")[0]!;
  if (!/^\d+$/.test(digits)) return null;
  return negative ? -Number(digits) : Number(digits);
}

function productions(obj: Node): Node[] {
  const produced = obj["produced_by"];
  if (typeof produced !== "object" || produced === null) return [];
  return [produced as Node, ...dicts(produced, "part")];
}

function creator(obj: Node): string | null {
  for (const production of productions(obj)) {
    for (const actor of dicts(production, "carried_out_by")) {
      const name = notation(actor);
      if (name) return name;
    }
  }
  return referred(obj["produced_by"], AAT_DESCRIPTION);
}

function artistName(obj: Node): string | null {
  const name = clean(
    (creator(obj) ?? "").replace(/\s*\((?:mentioned on object|possibly|attributed to)[^)]*\)/g, ""),
  );
  if (!name || UNNAMED.has(name.toLowerCase())) return null;
  return name;
}

/**
 * Repair a Rijksmuseum object page URL.
 *
 * The Linked Art data still publishes the museum's *previous* public URL --
 * `/en/collectie/object/<object number>--<hash>` -- and every one of those now
 * returns 404. The live scheme is `/en/collection/<object number>`, which
 * redirects to whatever slug the museum currently uses, so it keeps working
 * when they rename a thing.
 *
 * The object number is the only durable part, and the dead URL still contains
 * it. Anything this cannot recognise returns "" rather than a guess: an empty
 * `object_url` renders as no link at all, which is honest, and a link to a 404
 * is not.
 */
export function objectPageUrl(published: string | null | undefined): string {
  const url = (published ?? "").trim();
  if (!url) return "";
  // Already the live scheme.
  const live = /^https?:\/\/(?:www\.)?rijksmuseum\.nl\/en\/collection\/[^/?#]+$/;
  if (live.test(url)) return url;
  const dead = /\/(?:collectie|collection)\/object\/([^/?#]+?)(?:--[0-9a-f]{8,})?$/;
  const number = dead.exec(url)?.[1];
  if (!number) return "";
  return `https://www.rijksmuseum.nl/en/collection/${number}`;
}

function pageUrl(obj: Node): string | null {
  for (const note of dicts(obj, "subject_of")) {
    for (const carrier of dicts(note, "digitally_carried_by")) {
      if (carrier["format"] !== "text/html") continue;
      for (const point of dicts(carrier, "access_point")) {
        const url = clean(point["id"]);
        if (url) return url;
      }
    }
  }
  return null;
}

/** Rijksmuseum search filters dates by wildcard, so windows become centuries. */
function centuries(windows: ReadonlyArray<readonly [number, number]>): string[] {
  const out: string[] = [];
  for (const [begin, end] of windows) {
    for (let year = Math.max(begin, 1000); year < Math.min(end, 2100); year += 100) {
      const token = String(Math.floor(year / 100)).padStart(2, "0") + "??";
      if (!out.includes(token)) out.push(token);
    }
  }
  return out;
}

async function loadObject(objectId: string | undefined): Promise<RawObject | null> {
  if (!objectId) return null;
  const obj = (await fetchJson(objectId, { museum: MUSEUM })) as Node | null;
  if (!obj) return null;

  const name = title(obj);
  if (!name) return null;

  const visualIds = dicts(obj, "shows").map((v) => v["id"]).filter(Boolean) as string[];
  if (visualIds.length === 0) return null;
  const visual = (await fetchJson(visualIds[0]!, { museum: MUSEUM })) as Node | null;
  if (!visual) return null;

  let licenceRaw: string | null = null;
  for (const right of dicts(visual, "subject_to")) {
    for (const kind of dicts(right, "classified_as")) {
      if (String(kind["id"] ?? "").includes("creativecommons.org")) {
        licenceRaw = String(kind["id"]);
        break;
      }
    }
  }

  const digitalIds = dicts(visual, "digitally_shown_by").map((d) => d["id"]).filter(Boolean) as string[];
  if (digitalIds.length === 0) return null;
  const digital = (await fetchJson(digitalIds[0]!, { museum: MUSEUM })) as Node | null;
  let imageUrl: string | null = null;
  for (const point of dicts(digital ?? {}, "access_point")) {
    const url = clean(point["id"]);
    if (url) {
      imageUrl = url;
      break;
    }
  }
  if (!imageUrl) return null;
  // The IIIF endpoint serves any width; ask for something a browser can use.
  imageUrl = imageUrl.replace("/full/max/", "/full/1100,/");

  const produced = typeof obj["produced_by"] === "object" && obj["produced_by"] !== null
    ? (obj["produced_by"] as Node) : {};
  const timespan = typeof produced["timespan"] === "object" && produced["timespan"] !== null
    ? (produced["timespan"] as Node) : {};
  let dateDisplay = "";
  for (const label of dicts(timespan, "identified_by")) {
    const text = clean(label["content"]);
    if (text) {
      dateDisplay = text;
      break;
    }
  }

  let objectType: string | null = null;
  for (const kind of dicts(obj, "classified_as")) objectType = notation(kind) ?? objectType;
  const materials = dicts(obj, "made_of").map((m) => notation(m)).filter((m): m is string => Boolean(m));
  let place: string | null = null;
  for (const production of productions(obj)) {
    for (const spot of dicts(production, "took_place_at")) place ??= notation(spot, false);
  }

  const sourceId = String(objectId).replace(/\/+$/, "").split("/").pop()!;
  const page = objectPageUrl(
    (pageUrl(obj) ?? "").replace("rijksmuseum.nl/nl/", "rijksmuseum.nl/en/"),
  );

  return raw({
    museum: MUSEUM,
    source_id: sourceId,
    title: name,
    object_url: page,
    image_url: imageUrl,
    licence_raw: licenceRaw,
    rights_basis: "rights statement on the object's VisualItem in the Rijksmuseum Linked Art data",
    date_display: dateDisplay,
    year_start: yearOf(timespan["begin_of_the_begin"]),
    year_end: yearOf(timespan["end_of_the_end"]),
    artist: artistName(obj),
    medium: materials.slice(0, 3).join(", ") || null,
    classification: objectType,
    culture: place,
    credit_line: referred(obj, AAT_CREDIT) ?? "Rijksmuseum, Amsterdam",
  });
}

/**
 * Round-robin across century x object-type, stopping at the overall target.
 *
 * Each object costs three requests, so the walk is breadth-first: one pass
 * takes a couple of objects from every combination before any combination gets
 * a second look. That keeps a small quota spread across the whole collection.
 */
export async function* harvest(
  windows: ReadonlyArray<readonly [number, number]>,
  perWindow: number,
): AsyncGenerator<RawObject> {
  const total = Math.max(1, perWindow * windows.length);
  const combos: Array<[string, string]> = [];
  for (const century of centuries(windows)) for (const kind of TYPES) combos.push([century, kind]);
  if (combos.length === 0) return;

  const listings = new Map<string, string[]>();
  let yielded = 0;
  const perPass = 2;
  let offset = 0;

  while (yielded < total && offset < 40) {
    let progressed = false;
    for (const [century, kind] of combos) {
      if (yielded >= total) return;
      const key = `${century}|${kind}`;
      if (!listings.has(key)) {
        const url = `${SEARCH}?type=${kind}&imageAvailable=True&creationDate=${century}`;
        try {
          const payload = (await fetchJson(url, { museum: MUSEUM })) as Node | null;
          listings.set(
            key,
            dicts(payload ?? {}, "orderedItems").map((item) => item["id"]).filter(Boolean) as string[],
          );
        } catch (error) {
          if (error instanceof BlockedError) throw error;
          listings.set(key, []);
          continue;
        }
      }
      for (const objectId of (listings.get(key) ?? []).slice(offset, offset + perPass)) {
        progressed = true;
        let record: RawObject | null;
        try {
          record = await loadObject(objectId);
        } catch (error) {
          if (error instanceof BlockedError) throw error;
          continue;
        }
        if (!record) continue;
        yielded += 1;
        yield record;
        if (yielded >= total) return;
      }
    }
    if (!progressed) return;
    offset += perPass;
  }
}
