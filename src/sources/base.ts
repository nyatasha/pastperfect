/** Shared plumbing for the museum adapters: one record shape, one HTTP client. */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import * as config from "../config.ts";

/**
 * One museum object, flattened but not yet judged.
 *
 * Adapters fill this in verbatim from the source. Date reconciliation, the
 * rights gate and the taxonomy heuristics all happen afterwards in ingest.ts,
 * so each adapter stays a thin translation layer.
 */
export interface RawObject {
  museum: string;
  source_id: string;
  title: string;
  object_url: string;
  image_url: string;
  licence_raw: string | null;
  rights_basis: string;
  date_display: string;
  year_start: number | null;
  year_end: number | null;
  artist: string | null;
  artist_note: string | null;
  medium: string | null;
  classification: string | null;
  culture: string | null;
  department: string | null;
  credit_line: string | null;
}

export const objectId = (raw: RawObject): string => `${raw.museum}:${raw.source_id}`;

export class HttpError extends Error {}

/**
 * The source is refusing us outright -- rate limit, WAF, or ban.
 *
 * Worth its own type: the right response is to stop asking this museum for a
 * while, not to retry the next object and collect another few hundred 403s.
 */
export class BlockedError extends HttpError {}

/**
 * Minimum spacing between requests to the same host. These are free public APIs
 * run by museums; hammering them is rude and gets us blocked -- the Met sits
 * behind a WAF that starts returning 403 well before its documented rate limit.
 */
export const DEFAULT_INTERVAL = 200;
export const HOST_INTERVALS: Record<string, number> = {
  "collectionapi.metmuseum.org": 1600,
  "images.metmuseum.org": 350,
  "api.artic.edu": 250,
  "www.artic.edu": 600,
  "api.wellcomecollection.org": 250,
  "iiif.wellcomecollection.org": 300,
  "data.rijksmuseum.nl": 150,
  "id.rijksmuseum.nl": 150,
  "iiif.micr.io": 150,
};

/**
 * Headers a particular host needs beyond the defaults. The Art Institute's
 * image host rejects requests that omit the AIC-User-Agent header its API docs
 * ask callers to send -- so we send it, and identify ourselves honestly.
 */
export const HOST_HEADERS: Record<string, Record<string, string>> = {
  "www.artic.edu": { "AIC-User-Agent": config.USER_AGENT },
};

const lastRequest = new Map<string, number>();
const hostQueue = new Map<string, Promise<void>>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Serialise per host and keep a polite gap between requests. */
async function throttle(host: string): Promise<void> {
  const interval = HOST_INTERVALS[host] ?? DEFAULT_INTERVAL;
  const previous = hostQueue.get(host) ?? Promise.resolve();
  const turn = previous.then(async () => {
    const wait = interval - (Date.now() - (lastRequest.get(host) ?? 0));
    if (wait > 0) await sleep(wait);
    lastRequest.set(host, Date.now());
  });
  hostQueue.set(
    host,
    turn.catch(() => undefined),
  );
  await turn;
}

function cachePath(museum: string, url: string): string {
  const digest = createHash("sha1").update(url).digest("hex");
  return path.join(config.paths.cache, museum, digest.slice(0, 2), `${digest}.json`);
}

/**
 * GET JSON with an on-disk cache, polite throttling and retries.
 *
 * Returns null for 404/410 so an adapter can skip a withdrawn record. Throws
 * HttpError when the request genuinely failed.
 */
export async function fetchJson(
  url: string,
  options: { museum: string; useCache?: boolean; headers?: Record<string, string> },
): Promise<unknown | null> {
  const { museum, useCache = true, headers = {} } = options;
  const file = cachePath(museum, url);
  if (useCache) {
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      /* not cached, or unreadable */
    }
  }

  const host = new URL(url).host;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < config.HTTP_RETRIES; attempt++) {
    await throttle(host);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": config.USER_AGENT,
          Accept: "application/json",
          ...(HOST_HEADERS[host] ?? {}),
          ...headers,
        },
        signal: AbortSignal.timeout(config.HTTP_TIMEOUT_MS),
      });
      if (response.status === 404 || response.status === 410) return null;
      if (response.status === 401 || response.status === 403) {
        throw new BlockedError(`${host} refused the request (${response.status})`);
      }
      if (!response.ok) {
        lastError = new HttpError(`${url}: HTTP ${response.status}`);
        if ([429, 500, 502, 503, 504].includes(response.status)) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        break;
      }
      const payload = await response.json();
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(payload), "utf8");
      return payload;
    } catch (error) {
      if (error instanceof BlockedError) throw error;
      lastError = error;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new HttpError(`${url}: ${lastError instanceof Error ? lastError.message : lastError}`);
}

export async function fetchBytes(url: string, timeoutMs?: number): Promise<Buffer> {
  const host = new URL(url).host;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < config.HTTP_RETRIES; attempt++) {
    await throttle(host);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": config.USER_AGENT,
          Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
          ...(HOST_HEADERS[host] ?? {}),
        },
        signal: AbortSignal.timeout(timeoutMs ?? config.HTTP_TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403) {
        throw new BlockedError(`${host} refused the request (${response.status})`);
      }
      if (response.status === 404 || response.status === 410) {
        throw new HttpError(`${url}: HTTP ${response.status}`);
      }
      if (!response.ok) {
        lastError = new HttpError(`${url}: HTTP ${response.status}`);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof BlockedError || error instanceof HttpError) throw error;
      lastError = error;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new HttpError(`${url}: ${lastError instanceof Error ? lastError.message : lastError}`);
}

export function clean(text: unknown): string | null {
  if (text === null || text === undefined) return null;
  const value = String(text).split(/\s+/).filter(Boolean).join(" ").trim();
  return value || null;
}

/** A blank record, so adapters only name the fields they actually have. */
export function raw(partial: Partial<RawObject> & Pick<RawObject, "museum" | "source_id" | "title" | "object_url" | "image_url" | "rights_basis">): RawObject {
  return {
    licence_raw: null,
    date_display: "",
    year_start: null,
    year_end: null,
    artist: null,
    artist_note: null,
    medium: null,
    classification: null,
    culture: null,
    department: null,
    credit_line: null,
    ...partial,
  };
}
