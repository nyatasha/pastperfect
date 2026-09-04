/**
 * Local image derivatives.
 *
 * Images are fetched once at ingest time and served from disk under an opaque
 * key. Two reasons: the game stays fast and works without reaching back out to
 * four museums on every round, and the URL a player sees in devtools reveals
 * nothing about which object they are looking at.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

import * as config from "./config.ts";
import { BlockedError, fetchBytes, HttpError } from "./sources/base.ts";

export function imageKey(objectId: string): string {
  return createHash("sha256")
    .update(`${config.IMAGE_KEY_SALT}:${objectId}`)
    .digest("hex")
    .slice(0, 20);
}

export const largePath = (key: string): string =>
  path.join(config.paths.media, key.slice(0, 2), `${key}.jpg`);

export const thumbPath = (key: string): string =>
  path.join(config.paths.media, key.slice(0, 2), `${key}.t.jpg`);

export const hasLocal = (key: string): boolean => fs.existsSync(largePath(key));

const IIIF = /^(?<base>.*)\/full\/(?<size>[^/]+)\/(?<rot>[\d.!]+)\/(?<rest>[\w.]+)$/;

/**
 * Sizes to try, widest first, for an image served over IIIF.
 *
 * Each service draws its own line. Wellcome answers a request above roughly
 * 1024px with an empty body rather than an error; the Art Institute documents
 * 843px and simply hangs above it. Rather than encode a rule per museum, ask
 * for what we want and walk down until something usable comes back.
 */
export function iiifVariants(url: string): string[] {
  const match = IIIF.exec(url);
  if (!match?.groups) return [url];
  const { base, size, rot, rest } = match.groups as Record<string, string>;
  const sizes: string[] = [];
  for (const candidate of [size, `!${config.IMAGE_LARGE_PX},${config.IMAGE_LARGE_PX}`, "1024,", "843,", "full"]) {
    if (!sizes.includes(candidate!)) sizes.push(candidate!);
  }
  return sizes.map((s) => `${base}/full/${s}/${rot}/${rest}`);
}

async function write(image: sharp.Sharp, longest: number, target: string): Promise<sharp.OutputInfo> {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return image
    .clone()
    .resize({ width: longest, height: longest, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: config.IMAGE_QUALITY, progressive: true, mozjpeg: true })
    .toFile(target);
}

/** Download and derive the two sizes we serve. Returns the large size. */
export async function ensure(
  key: string,
  url: string,
  force = false,
): Promise<{ width: number; height: number } | null> {
  const target = largePath(key);
  if (fs.existsSync(target) && !force) {
    try {
      const meta = await sharp(target).metadata();
      if (meta.width && meta.height) return { width: meta.width, height: meta.height };
    } catch {
      fs.rmSync(target, { force: true });
    }
  }

  let flattened: sharp.Sharp | null = null;
  for (const candidate of iiifVariants(url)) {
    let payload: Buffer;
    try {
      payload = await fetchBytes(candidate, 35_000);
    } catch (error) {
      // Every variant shares a host; a refusal will not change on the next one.
      if (error instanceof BlockedError) return null;
      if (error instanceof HttpError) continue;
      continue;
    }
    // Some IIIF servers answer an oversized request with an empty 200.
    if (payload.length < 1024) continue;
    try {
      const image = sharp(payload, { limitInputPixels: 200_000_000 }).rotate();
      const meta = await image.metadata();
      if (!meta.width || !meta.height) continue;
      if (Math.min(meta.width, meta.height) < 200) return null; // too small to read
      flattened = image.flatten({ background: "#ffffff" });
      break;
    } catch {
      continue;
    }
  }
  if (!flattened) return null;

  const info = await write(flattened, config.IMAGE_LARGE_PX, target);
  await write(flattened, config.IMAGE_THUMB_PX, thumbPath(key));
  return { width: info.width, height: info.height };
}

export function diskUsage(): number {
  const root = config.paths.media;
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jpg")) total += fs.statSync(full).size;
    }
  };
  walk(root);
  return total;
}
