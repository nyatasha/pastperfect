/**
 * Share cards.
 *
 * A shared result must not spoil the puzzle for whoever receives it, so the
 * card carries the brand, the puzzle number and the date -- and, as decoration,
 * four extreme close crops of the day's objects. At that magnification the
 * crops read as texture and colour: enticing, and useless as a clue.
 *
 * Rendered by composing an SVG and letting sharp rasterise it, which avoids a
 * canvas dependency entirely.
 */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

import * as config from "./config.ts";
import * as daily from "./daily.ts";
import * as media from "./media.ts";
import { rngFor, shuffle, type Rng } from "./rng.ts";
import * as store from "./store.ts";

export const WIDTH = 1200;
export const HEIGHT = 630;
const IVORY = "#FBF6EC";
const IVORY_WARM = "#F5EDDF";
const INK = "#17140F";
const INK_SOFT = "#6F675A";
const ACCENT = "#A8432A";

const TILE = 180;
const BAND_TOP = 108;
const GAP = 16;
const COUNT = 4;

/**
 * A crop flatter than this is a patch of empty background -- true to the object
 * and useless as decoration, so we look elsewhere on the same image.
 */
const MIN_TILE_VARIANCE = 14;

/** An extreme close crop -- roughly a tenth of each edge, so nothing reads. */
async function cropTile(key: string, size: number, rng: Rng): Promise<Buffer | null> {
  const file = media.largePath(key);
  if (!fs.existsSync(file)) return null;
  try {
    const meta = await sharp(file).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (!width || !height) return null;
    const side = Math.max(24, Math.floor(Math.min(width, height) * 0.12));

    let best: Buffer | null = null;
    let bestVariance = -1;
    for (let attempt = 0; attempt < 7; attempt++) {
      const left = Math.floor(rng() * Math.max(1, width - side));
      const top = Math.floor(rng() * Math.max(1, height - side));
      const region = sharp(file).extract({ left, top, width: side, height: side });
      const stats = await region.stats();
      const variance =
        stats.channels.slice(0, 3).reduce((sum, channel) => sum + channel.stdev, 0) / 3;
      if (variance > bestVariance) {
        bestVariance = variance;
        best = await sharp(file)
          .extract({ left, top, width: side, height: side })
          .resize(size, size, { kernel: "lanczos3" })
          .png()
          .toBuffer();
      }
      if (variance >= MIN_TILE_VARIANCE) break;
    }
    return best;
  } catch {
    return null;
  }
}

const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function baseSvg(label: string, day: string): string {
  const line = `${label}  ·  #${daily.puzzleNumber(day)}  ·  ${formatDay(day)}`.toUpperCase();
  const slots = Array.from({ length: COUNT }, (_, i) => {
    const total = COUNT * TILE + (COUNT - 1) * GAP;
    const x = Math.round((WIDTH - total) / 2) + i * (TILE + GAP);
    return `<rect x="${x}" y="${BAND_TOP}" width="${TILE}" height="${TILE}" fill="${IVORY_WARM}" stroke="${INK_SOFT}" stroke-width="1"/>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${IVORY}"/>
  ${slots}
  <text x="${WIDTH / 2}" y="400" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif"
        font-size="74" fill="${INK}">Past Perfect</text>
  <text x="${WIDTH / 2}" y="452" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif"
        font-size="34" font-style="italic" fill="${ACCENT}">Which came first? Trust your eye.</text>
  <text x="${WIDTH / 2}" y="502" text-anchor="middle" font-family="Helvetica, Arial, sans-serif"
        font-size="24" letter-spacing="2" fill="${INK_SOFT}">${escapeXml(line)}</text>
  <rect x="0" y="${HEIGHT - 12}" width="${WIDTH}" height="12" fill="${ACCENT}"/>
</svg>`;
}

function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const month = date.toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
  return `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}`;
}

async function card(day: string, edition = ""): Promise<Buffer> {
  const rng = rngFor(`og:${edition}:${day}`);
  const rows = daily.questions(day, edition);
  let keys: string[] = [];
  if (rows.length > 0) {
    const ids = rows.flatMap((row) => [row.left_id, row.right_id]);
    const objects = store.objectsByIds(ids);
    keys = ids.map((id) => objects.get(id)?.image_key).filter((k): k is string => Boolean(k));
  }
  if (keys.length === 0) keys = store.featuredObjects(null, 8).map((row) => row.image_key);
  shuffle(keys, rng);

  const label = edition ? `${config.MUSEUMS[edition]!.shortName} edition` : "Daily Challenge";
  const base = sharp(Buffer.from(baseSvg(label, day)));

  const total = COUNT * TILE + (COUNT - 1) * GAP;
  const startX = Math.round((WIDTH - total) / 2);
  const composites: sharp.OverlayOptions[] = [];
  for (const [index, key] of keys.slice(0, COUNT).entries()) {
    const tile = await cropTile(key, TILE, rng);
    if (tile) {
      composites.push({ input: tile, left: startX + index * (TILE + GAP), top: BAND_TOP });
    }
  }
  return base.composite(composites).png({ compressionLevel: 9 }).toBuffer();
}

export function pathFor(day: string, edition = ""): string {
  return path.join(config.paths.og, `daily-${edition || "mixed"}-${day}.png`);
}

export async function render(day: string, edition = "", force = false): Promise<string> {
  const target = pathFor(day, edition);
  if (fs.existsSync(target) && !force) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, await card(day, edition));
  return target;
}

export async function defaultCard(force = false): Promise<string> {
  const target = path.join(config.paths.og, "default.png");
  if (fs.existsSync(target) && !force) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, await card(daily.today()));
  return target;
}
