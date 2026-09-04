/** A small synthetic collection, so tests never depend on a live harvest. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

import * as config from "../src/config.ts";
import * as db from "../src/db.ts";
import * as ingest from "../src/ingest.ts";
import * as media from "../src/media.ts";
import * as taxonomy from "../src/taxonomy.ts";

const MUSEUMS = ["met", "aic", "wellcome", "rijksmuseum"];

type Spec = [
  title: string, artist: string | null, label: string, start: number, end: number,
  medium: string, classification: string, culture: string,
];

const SPECIMENS: Spec[] = [
  ["Kneeling bull", null, "ca. 3000 BC", -3005, -2995, "Silver", "Sculpture", "Iran"],
  ["Funerary stele", null, "1st century", 0, 99, "Limestone", "Sculpture", "Egypt"],
  ["Reliquary cross", null, "ca. 1050", 1045, 1055, "Gilded silver", "Metalwork", "Germany"],
  ["Book of hours", null, "1420", 1420, 1420, "Vellum", "Manuscript", "France"],
  ["Portrait of a lady", "Anon", "ca. 1510", 1505, 1515, "Oil on panel", "Painting", "Netherlands"],
  ["Still life with lemons", "Claesz", "1642", 1642, 1642, "Oil on canvas", "Painting", "Netherlands"],
  ["Kabuki actor", "Toyokuni", "1795", 1795, 1795, "Woodblock print", "Print", "Japan"],
  ["View of the harbour", "Turner", "1830", 1830, 1830, "Watercolour", "Drawing", "England"],
  ["Portrait of a surgeon", "Hill", "1845", 1845, 1845, "Calotype", "Photograph", "Scotland"],
  ["Seated woman", "Cameron", "1867", 1867, 1867, "Albumen silver print", "Photograph", "England"],
  ["Poster for a revue", "Cheret", "1893", 1893, 1893, "Colour lithograph", "Poster", "France"],
  ["Side chair", "Rietveld", "1918", 1918, 1918, "Painted wood", "Furniture", "Netherlands"],
  ["Study in grey", "Anon", "1955", 1955, 1955, "Gelatin silver print", "Photograph", "United States"],
  ["Woven hanging", null, "1972", 1972, 1972, "Wool", "Textile", "Peru"],
];

/**
 * Enough further objects that a full ten-question day, with distinct objects
 * and a working cooldown, is actually possible. Generated rather than written
 * out so the interesting hand-made cases above stay easy to read.
 */
function generated(): Spec[] {
  const forms: Array<[string, string]> = [
    ["Oil on canvas", "Painting"], ["Engraving", "Print"], ["Watercolour", "Drawing"],
    ["Marble", "Sculpture"], ["Porcelain", "Ceramic"], ["Silk", "Textile"],
    ["Silver", "Metalwork"], ["Albumen silver print", "Photograph"],
  ];
  const places = ["France", "Japan", "Netherlands", "England", "Mexico", "Iran", "United States", "Italy"];
  const out: Spec[] = [];
  for (let index = 0; index < 96; index++) {
    const year = 1400 + index * 6;
    let [medium, classification] = forms[index % forms.length]!;
    // Keep photographs plausible: the process did not exist before 1839.
    if (classification === "Photograph" && year < 1840) [medium, classification] = forms[0]!;
    out.push([
      `Specimen ${String(index).padStart(2, "0")}`, `Maker ${index % 11}`, String(year),
      year, year, medium, classification, places[index % places.length]!,
    ]);
  }
  return out;
}

async function writeImage(key: string): Promise<void> {
  for (const [target, size] of [[media.largePath(key), [400, 300]], [media.thumbPath(key), [240, 180]]] as const) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await sharp({
      create: { width: size[0], height: size[1], channels: 3, background: { r: 200, g: 190, b: 170 } },
    })
      .jpeg()
      .toFile(target);
  }
}

/** Point config at a temporary tree and fill it with the specimens above. */
export async function build(tmp: string): Promise<void> {
  config.paths.db = path.join(tmp, "test.db");
  config.paths.media = path.join(tmp, "media");
  config.paths.og = path.join(tmp, "og");
  config.paths.cache = path.join(tmp, "cache");
  db.resetConnection();
  db.init();

  const now = db.nowIso();
  const rows: ingest.ObjectRecord[] = [];
  const specs = [...SPECIMENS, ...generated()];
  for (const [index, spec] of specs.entries()) {
    const [title, artist, label, start, end, medium, classification, culture] = spec;
    const museum = MUSEUMS[index % MUSEUMS.length]!;
    const id = `${museum}:test${index}`;
    const key = media.imageKey(id);
    await writeImage(key);
    rows.push({
      id, museum, source_id: `test${index}`, title, artist, artist_note: null,
      date_display: label, year_start: start, year_end: end,
      year_mid: Math.floor((start + end) / 2),
      date_precision: start === end ? "year" : "range",
      medium, classification, culture, department: null,
      region: taxonomy.regionFor(culture),
      credit_line: "Test collection", object_url: `https://example.org/${id}`,
      image_url: `https://example.org/${id}.jpg`, image_key: key,
      image_w: 400, image_h: 300, local_image: 1,
      license_id: "cc0", license_label: "CC0 1.0",
      license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
      rights_basis: "test fixture",
      looks_modern: taxonomy.readsModern(medium, classification, title) ? 1 : 0,
      playable: 1, exclude_reason: null, ingested_at: now,
    });
  }
  ingest.store(rows);
}

const saved = { ...config.paths };
let temp: string | null = null;

/** Give a test file its own database and media tree. */
export async function sandbox(): Promise<void> {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "pastperfect-test-"));
  await build(temp);
}

export function teardown(): void {
  db.resetConnection();
  Object.assign(config.paths, saved);
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
  temp = null;
}
