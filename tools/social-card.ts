/**
 * The site's social preview card, rendered once and committed.
 *
 * Distinct from src/og.ts, which draws a *share* card per day: that one must
 * not spoil the puzzle, so it shows unreadable close crops. This one is the
 * card a stranger sees when the bare site link is pasted into WhatsApp or
 * Slack, so it has the opposite job -- show two whole objects, side by side,
 * and let the question do the selling.
 *
 * It is rendered here rather than per request because a link preview is the
 * one image that must never fail: no database, no volume, no font packages, no
 * cold start. The output is a static file under static/img, served like any
 * other asset. Re-run after changing the design or the chosen objects:
 *
 *   node tools/social-card.ts [--out static/img/social.png]
 *
 * Run it on a machine that has data/media and real fonts -- a container without
 * fontconfig renders every string as blank space or tofu.
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";

import * as config from "../src/config.ts";
import * as media from "../src/media.ts";

const WIDTH = 1200;
const HEIGHT = 630;

const IVORY = "#FBF6EC";
const IVORY_WARM = "#F5EDDF";
const INK = "#17140F";
const INK_SOFT = "#6F675A";
const ACCENT = "#A8432A";

const SERIF = "Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Times New Roman', serif";
const SANS = "Helvetica, 'Helvetica Neue', Arial, sans-serif";

/**
 * The two objects on the card.
 *
 * Chosen to be handsome at thumbnail size and genuinely hard to order by eye --
 * a black-figure amphora against a Japanese hanging scroll. A pair anybody
 * could date at a glance would advertise a game easier than the one we built.
 * Neither the card nor the page states a date, so this reveals no answer.
 */
const OBJECTS = [
  { key: "4e03bee6e765550e8540", label: "Belly-Amphora · Art Institute of Chicago" },
  { key: "68e6c880dc6b5fc9ecd4", label: "Owl on a Pine Branch · The Met" },
];

const FRAME = 300;
const FRAME_TOP = 168;
const FRAME_GAP = 132;
const PAD = 12;

/** One object, matted inside a frame the way .gallery-frame mats it on the site. */
async function plate(key: string): Promise<Buffer> {
  const file = media.largePath(key);
  if (!fs.existsSync(file)) {
    throw new Error(`no local image for ${key} -- run the ingest first, or pick another object`);
  }
  const inner = FRAME - PAD * 2;
  const art = await sharp(file)
    .resize(inner, inner, { fit: "inside", kernel: "lanczos3" })
    .toBuffer();
  return sharp({
    create: { width: FRAME, height: FRAME, channels: 3, background: IVORY_WARM },
  })
    .composite([{ input: art, gravity: "centre" }])
    .png()
    .toBuffer();
}

function svg(): string {
  const total = FRAME * 2 + FRAME_GAP;
  const startX = Math.round((WIDTH - total) / 2);
  const frames = [0, 1]
    .map((i) => {
      const x = startX + i * (FRAME + FRAME_GAP);
      return `<rect x="${x}" y="${FRAME_TOP}" width="${FRAME}" height="${FRAME}" rx="3"
        fill="${IVORY_WARM}" stroke="${INK_SOFT}" stroke-width="1"/>`;
    })
    .join("");

  // The pivot between the two objects: the question mark *is* the comparison.
  const midX = WIDTH / 2;
  const midY = FRAME_TOP + FRAME / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${IVORY}"/>

  <text x="${midX}" y="86" text-anchor="middle" font-family="${SERIF}"
        font-size="68" fill="${INK}">Past Perfect</text>
  <text x="${midX}" y="134" text-anchor="middle" font-family="${SERIF}"
        font-size="36" font-style="italic" fill="${ACCENT}">Which came first?</text>

  ${frames}

  <line x1="${midX}" y1="${FRAME_TOP + 18}" x2="${midX}" y2="${midY - 44}"
        stroke="${INK_SOFT}" stroke-width="1" opacity=".45"/>
  <text x="${midX}" y="${midY + 26}" text-anchor="middle" font-family="${SERIF}"
        font-size="76" fill="${INK}">?</text>
  <line x1="${midX}" y1="${midY + 48}" x2="${midX}" y2="${FRAME_TOP + FRAME - 18}"
        stroke="${INK_SOFT}" stroke-width="1" opacity=".45"/>

  <text x="${midX}" y="546" text-anchor="middle" font-family="${SANS}"
        font-size="23" letter-spacing="2" fill="${INK_SOFT}">TWO OBJECTS. NO DATES. PICK THE OLDER ONE.</text>
  <text x="${midX}" y="586" text-anchor="middle" font-family="${SANS}"
        font-size="19" fill="${INK_SOFT}">A daily game built from open museum collections</text>

  <rect x="0" y="${HEIGHT - 12}" width="${WIDTH}" height="12" fill="${ACCENT}"/>
</svg>`;
}

export async function card(): Promise<Buffer> {
  const total = FRAME * 2 + FRAME_GAP;
  const startX = Math.round((WIDTH - total) / 2);
  const composites: sharp.OverlayOptions[] = [];
  for (const [index, object] of OBJECTS.entries()) {
    composites.push({
      input: await plate(object.key),
      left: startX + index * (FRAME + FRAME_GAP),
      top: FRAME_TOP,
    });
  }
  return sharp(Buffer.from(svg())).composite(composites).png({ compressionLevel: 9 }).toBuffer();
}

const { values } = parseArgs({
  options: { out: { type: "string", default: path.join(config.STATIC_DIR, "img", "social.png") } },
});

const out = path.resolve(values.out!);
fs.mkdirSync(path.dirname(out), { recursive: true });
await fs.promises.writeFile(out, await card());
console.log(`wrote ${path.relative(config.ROOT, out)} (${WIDTH}x${HEIGHT})`);
for (const object of OBJECTS) console.log(`  ${object.label}`);
