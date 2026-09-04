/**
 * Central configuration.
 *
 * Everything tunable about ingestion, the answer/date logic and the launch mix
 * lives here so the rules are auditable in one place rather than scattered
 * through the code.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(ROOT, "data");
export const SEED_DIR = path.join(DATA_DIR, "seed");
export const CACHE_DIR = path.join(DATA_DIR, "cache");
export const MEDIA_DIR_DEFAULT = path.join(DATA_DIR, "media");
export const OG_DIR_DEFAULT = path.join(DATA_DIR, "og");
export const STATIC_DIR = path.join(ROOT, "static");

/**
 * Paths a test can point somewhere else. Held in a mutable object rather than
 * as consts so a test sandbox can redirect them without a module registry hack.
 */
export const paths = {
  db: process.env.PASTPERFECT_DB ?? path.join(DATA_DIR, "pastperfect.db"),
  media: process.env.PASTPERFECT_MEDIA ?? MEDIA_DIR_DEFAULT,
  og: process.env.PASTPERFECT_OG ?? OG_DIR_DEFAULT,
  cache: process.env.PASTPERFECT_CACHE ?? CACHE_DIR,
};

/**
 * The database baked into a deployment image, copied to the runtime location on
 * first boot. Deploying replaces the image but not the volume, so player data --
 * scores, events, per-question success rates -- survives a redeploy.
 */
export const BAKED_DB = process.env.PASTPERFECT_BAKED_DB ?? path.join(DATA_DIR, "pastperfect.db");

export const SITE_NAME = "Past Perfect";
export const TAGLINE = "Which came first? Trust your eye.";
export const SITE_DESCRIPTION =
  "A daily visual game built from open museum collections. Two objects, " +
  "no labels. Guess which one came first.";

/** Absolute base used in canonical URLs, OpenGraph tags and the sitemap. */
export const site = {
  baseUrl: (process.env.PASTPERFECT_BASE_URL ?? "http://localhost:8000").replace(/\/+$/, ""),
};

export const HOST = process.env.PASTPERFECT_HOST ?? "127.0.0.1";
export const PORT = Number(process.env.PASTPERFECT_PORT ?? 8000);

/**
 * Salt for the opaque image keys. Images are served under a hash rather than
 * the museum object id so that a curious player cannot look up the answer in
 * devtools.
 */
export const IMAGE_KEY_SALT = process.env.PASTPERFECT_IMAGE_SALT ?? "past-perfect-v1";

/** Bumped whenever the stylesheet changes, to bust browser and SW caches. */
export const CSS_VERSION = "2";

// --- Launch museum mix ----------------------------------------------------

export interface Museum {
  slug: string;
  name: string;
  shortName: string;
  country: string;
  city: string;
  site: string;
  apiDocs: string;
  dataPolicy: string;
}

export const MUSEUMS: Record<string, Museum> = {
  met: {
    slug: "met",
    name: "The Metropolitan Museum of Art",
    shortName: "The Met",
    country: "United States",
    city: "New York",
    site: "https://www.metmuseum.org/",
    apiDocs: "https://metmuseum.github.io/",
    dataPolicy:
      "The Met releases images of public-domain works under Creative Commons " +
      "Zero and publishes the same rights flag through its Collection API.",
  },
  aic: {
    slug: "aic",
    name: "Art Institute of Chicago",
    shortName: "Art Institute of Chicago",
    country: "United States",
    city: "Chicago",
    site: "https://www.artic.edu/",
    apiDocs: "https://api.artic.edu/docs/",
    dataPolicy:
      "The Art Institute marks public-domain artworks in its API and serves " +
      "their images through a IIIF endpoint under CC0.",
  },
  wellcome: {
    slug: "wellcome",
    name: "Wellcome Collection",
    shortName: "Wellcome Collection",
    country: "United Kingdom",
    city: "London",
    site: "https://wellcomecollection.org/",
    apiDocs: "https://developers.wellcomecollection.org/api/catalogue",
    dataPolicy:
      "Wellcome states a licence per digital location. Only openly licensed " +
      "IIIF images are ingested; anything in copyright is skipped.",
  },
  rijksmuseum: {
    slug: "rijksmuseum",
    name: "Rijksmuseum",
    shortName: "Rijksmuseum",
    country: "Netherlands",
    city: "Amsterdam",
    site: "https://www.rijksmuseum.nl/",
    apiDocs: "https://data.rijksmuseum.nl/docs/search",
    dataPolicy:
      "The Rijksmuseum publishes rights per object as Linked Art. Only " +
      "objects whose image carries a public-domain statement are ingested.",
  },
};

export const MUSEUM_ORDER = ["met", "aic", "wellcome", "rijksmuseum"] as const;

export function museumName(slug: string): string {
  return MUSEUMS[slug]?.name ?? slug;
}

// --- Date / answer logic --------------------------------------------------

/**
 * Objects dated more loosely than this are never played. A 150-year window
 * still pairs safely against a distant object; anything vaguer is editorially
 * weak.
 */
export const MAX_OBJECT_SPAN_YEARS = 150;

/** Sanity bounds. Outside these is a bad record, not a very old object. */
export const MIN_YEAR = -4000;
export const MAX_YEAR = new Date().getUTCFullYear() + 1;

/**
 * A pair is only playable when the two date ranges do not overlap at all, so
 * the correct answer holds no matter where inside each range the truth falls.
 */
export const MIN_PAIR_GAP_YEARS = 1;

export const DAILY_QUESTIONS = 10;

/** Gentle opening, hard finish. */
export const DAILY_DIFFICULTY_CURVE = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5];

/** Puzzle numbering origin. Day 1 of Past Perfect. */
export const EPOCH_DATE = "2026-09-01";

/** A daily set never reuses an object seen in the previous N days. */
export const DAILY_COOLDOWN_DAYS = 14;

/**
 * Museum pages only feature objects that are not in a daily set within this
 * window either side of today, so browsing the site cannot spoil the puzzle.
 */
export const FEATURE_SPOILER_WINDOW_DAYS = 7;

/** Percentiles only appear once a day's sample means something. */
export const PERCENTILE_MIN_SAMPLE = 20;

// --- Rights gate ----------------------------------------------------------

/**
 * Licences we are willing to play. Attribution is always displayed, so CC-BY is
 * fine; NonCommercial and NoDerivatives are excluded because the product
 * intends to carry advertising later, and anything unknown is excluded outright.
 */
export const ALLOWED_LICENCES: Record<string, { label: string; url: string }> = {
  cc0: { label: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" },
  pdm: { label: "Public Domain Mark 1.0", url: "https://creativecommons.org/publicdomain/mark/1.0/" },
  "cc-by": { label: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
  "cc-by-sa": { label: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/" },
};

// --- Monetisation ---------------------------------------------------------

/**
 * v0 ships with no advertising at all. The slot machinery exists so the allowed
 * placements are encoded in code rather than in a document, but nothing renders
 * until this is switched on -- and it must not be switched on for UK/EEA
 * traffic before a Google-certified IAB TCF consent platform is in place.
 * https://support.google.com/adsense/answer/13554116?hl=en-GB
 */
export const ADS_ENABLED = false;

/** Placements the PRD permits. Anything else is a bug, not a decision. */
export const AD_PLACEMENTS = new Set([
  "home-below-cta",
  "daily-after-result",
  "endless-interstitial",
  "desktop-rail",
]);

export const ENDLESS_AD_AFTER_ROUNDS = 10;

// --- Retention ------------------------------------------------------------

export const REMINDER_OFFER_AFTER_DAILIES = 3;
export const ART_EYE_MIN_ANSWERS = 40;

// --- Ingestion ------------------------------------------------------------

export const USER_AGENT =
  "PastPerfect/0.1 (open museum data game; contact: hello@pastperfect.example)";
export const HTTP_TIMEOUT_MS = 30_000;
export const HTTP_RETRIES = 3;
export const INGEST_WORKERS = 4;
export const IMAGE_LARGE_PX = 1100;
export const IMAGE_THUMB_PX = 480;
export const IMAGE_QUALITY = 82;
