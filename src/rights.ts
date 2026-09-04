/**
 * The per-object image rights gate.
 *
 * Rights are evaluated object by object, never museum by museum. A record only
 * becomes playable when the source states a licence we recognise *and* that
 * licence is on the allow list. Anything ambiguous -- a missing statement, an
 * unfamiliar identifier, a NonCommercial or NoDerivatives term -- is excluded
 * rather than guessed at, because the product intends to carry advertising
 * later and an unclear licence is not a licence.
 */

import * as config from "./config.ts";

/** The many ways the four sources spell a licence, mapped to our ids. */
const ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["cc0", "cc0"],
  ["cc-zero", "cc0"],
  ["cc0-1.0", "cc0"],
  ["publicdomain/zero/1.0", "cc0"],
  ["creativecommons.org/publicdomain/zero", "cc0"],
  ["pdm", "pdm"],
  ["public domain", "pdm"],
  ["public domain mark", "pdm"],
  ["publicdomain/mark/1.0", "pdm"],
  ["creativecommons.org/publicdomain/mark", "pdm"],
  ["cc-by", "cc-by"],
  ["cc-by-4.0", "cc-by"],
  ["licenses/by/4.0", "cc-by"],
  ["cc-by-sa", "cc-by-sa"],
  ["licenses/by-sa/4.0", "cc-by-sa"],
];

/** Recognised but deliberately refused, so the reason we skipped is specific. */
const REFUSED: Record<string, string> = {
  "cc-by-nc": "NonCommercial",
  "cc-by-nc-sa": "NonCommercial",
  "cc-by-nc-nd": "NonCommercial + NoDerivatives",
  "cc-by-nd": "NoDerivatives",
  inc: "in copyright",
  "inc-edu": "in copyright, educational use only",
  ogl: "Open Government Licence (not reviewed)",
  opl: "Open Parliament Licence (not reviewed)",
};

/** Canonical licence id for an identifier or URL, or null if unrecognised. */
export function normalise(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = String(raw).trim().toLowerCase().replace(/\/+$/, "");
  const exact = ALIASES.find(([needle]) => needle === text);
  if (exact) return exact[1];
  if (text in REFUSED || text in config.ALLOWED_LICENCES) return text;
  const partial = ALIASES.find(([needle]) => text.includes(needle));
  if (partial) return partial[1];
  const m = text.match(/licenses\/(by(?:-[a-z]{2})*)\//);
  if (m) return `cc-${m[1]!}`;
  return null;
}

export interface LicenceDetail {
  license_id: string;
  license_label: string;
  license_url: string;
  rights_basis: string;
}

export interface RightsVerdict {
  allowed: boolean;
  reason: string;
  detail: LicenceDetail | null;
}

/**
 * Decide whether an object's image may be used. `basis` records *how* the
 * source told us, so a rights question about any object can be answered from
 * the database alone.
 */
export function evaluate(licenceRaw: string | null | undefined, basis: string): RightsVerdict {
  const canonical = normalise(licenceRaw);
  if (canonical === null) {
    return {
      allowed: false,
      reason: `no recognised licence statement (${licenceRaw || "absent"})`,
      detail: null,
    };
  }
  if (canonical in REFUSED) {
    return { allowed: false, reason: `licence excluded: ${REFUSED[canonical]}`, detail: null };
  }
  const entry = config.ALLOWED_LICENCES[canonical];
  if (!entry) {
    return { allowed: false, reason: `licence not on the allow list: ${canonical}`, detail: null };
  }
  return {
    allowed: true,
    reason: "",
    detail: {
      license_id: canonical,
      license_label: entry.label,
      license_url: entry.url,
      rights_basis: basis,
    },
  };
}

export function allowedSummary(): Array<{ id: string; label: string; url: string }> {
  return Object.entries(config.ALLOWED_LICENCES).map(([id, v]) => ({
    id,
    label: v.label,
    url: v.url,
  }));
}

export function refusedSummary(): Array<{ id: string; reason: string }> {
  return Object.entries(REFUSED)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, reason]) => ({ id, reason }));
}
