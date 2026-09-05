/**
 * Are the "See the object" links still real?
 *
 * Every reveal ends with a link to the object at its own museum, which is both
 * the point of the game and the attribution these open licences require. Those
 * links are the one part of the data we do not control: a museum can change its
 * URL scheme without telling anybody, and ours rot silently. The Rijksmuseum
 * did exactly that -- `/en/collectie/object/<no>--<hash>` became
 * `/en/collection/<no>` -- and every link we held 404'd for weeks.
 *
 * So this samples them and says which museums still resolve. It is a network
 * check, deliberately not part of `doctor`: `doctor` must stay offline and
 * deterministic.
 */

import * as config from "./config.ts";
import * as db from "./db.ts";

/**
 * Statuses that mean "a bot asked and was turned away", not "gone".
 *
 * The Met answers curl with 429 and Wellcome with 403 while serving both pages
 * perfectly to a browser. Treating those as breakage would cry wolf every run,
 * which is how a check stops being read.
 */
export const BLOCKED = new Set([401, 403, 405, 406, 418, 429, 503]);

/** Statuses that mean the object page is genuinely not there any more. */
export const BROKEN = new Set([404, 410]);

export type Verdict = "ok" | "blocked" | "broken" | "unreachable";

export interface LinkResult {
  museum: string;
  url: string;
  status: number | null;
  verdict: Verdict;
}

export interface MuseumReport {
  museum: string;
  checked: number;
  ok: number;
  blocked: number;
  broken: number;
  unreachable: number;
  examples: string[];
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function classify(status: number | null): Verdict {
  if (status === null) return "unreachable";
  if (BROKEN.has(status)) return "broken";
  if (BLOCKED.has(status)) return "blocked";
  return status >= 200 && status < 400 ? "ok" : "broken";
}

export async function check(url: string, timeoutMs = 20_000): Promise<number | null> {
  if (!url) return null;
  const abort = AbortSignal.timeout(timeoutMs);
  try {
    // A HEAD is cheaper, but several museum front ends do not implement it and
    // answer 405 to a page that is perfectly fine, so ask for the page.
    const response = await fetch(url, {
      redirect: "follow",
      signal: abort,
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
    });
    // The body is never read; releasing it keeps the socket from lingering.
    await response.body?.cancel();
    return response.status;
  } catch {
    return null;
  }
}

/** A deterministic spread of object links, `perMuseum` from each collection. */
export function sample(perMuseum: number): Array<{ museum: string; url: string }> {
  const out: Array<{ museum: string; url: string }> = [];
  for (const slug of config.MUSEUM_ORDER) {
    const rows = db.all<{ object_url: string }>(
      "SELECT object_url FROM objects WHERE museum = ? AND playable = 1 AND object_url <> '' " +
        "ORDER BY substr(id, -4), id LIMIT ?",
      [slug, perMuseum],
    );
    for (const row of rows) out.push({ museum: slug, url: row.object_url });
  }
  return out;
}

export async function run(perMuseum = 6): Promise<MuseumReport[]> {
  const targets = sample(perMuseum);
  const results: LinkResult[] = [];
  // One museum's links are checked in parallel with another's, but never a
  // museum's with its own: these are free public sites and we are a guest.
  const byMuseum = new Map<string, Array<{ museum: string; url: string }>>();
  for (const target of targets) {
    const bucket = byMuseum.get(target.museum);
    if (bucket) bucket.push(target);
    else byMuseum.set(target.museum, [target]);
  }
  await Promise.all(
    [...byMuseum.values()].map(async (bucket) => {
      for (const target of bucket) {
        const status = await check(target.url);
        results.push({ ...target, status, verdict: classify(status) });
      }
    }),
  );

  return config.MUSEUM_ORDER.map((slug) => {
    const mine = results.filter((r) => r.museum === slug);
    const bad = mine.filter((r) => r.verdict === "broken" || r.verdict === "unreachable");
    return {
      museum: slug,
      checked: mine.length,
      ok: mine.filter((r) => r.verdict === "ok").length,
      blocked: mine.filter((r) => r.verdict === "blocked").length,
      broken: mine.filter((r) => r.verdict === "broken").length,
      unreachable: mine.filter((r) => r.verdict === "unreachable").length,
      examples: bad.slice(0, 3).map((r) => `${r.status ?? "no response"} ${r.url}`),
    };
  });
}

/**
 * A museum is failing when nothing we sampled resolved and something was
 * refused outright. All-blocked is a bot wall, not breakage, and an empty
 * sample is a museum we hold no links for.
 */
export function failing(report: MuseumReport): boolean {
  return report.checked > 0 && report.ok === 0 && report.broken > 0;
}
