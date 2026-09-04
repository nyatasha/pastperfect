/**
 * The development server.
 *
 * Hono's app is a plain fetch handler, so this adapter is the only Node-shaped
 * part of the web layer. Moving to Deno, Bun or a Workers deployment means
 * replacing this file and nothing else.
 */

import net from "node:net";
import { serve } from "@hono/node-server";

import { app } from "./app.ts";
import * as config from "./config.ts";
import * as daily from "./daily.ts";
import * as db from "./db.ts";
import * as store from "./store.ts";

/**
 * True if anything is already listening, on either stack.
 *
 * Binding is not a reliable test here: another server holding [::]:8000 leaves
 * 127.0.0.1:8000 bindable, and the result is two different sites answering on
 * the same port depending on how the browser resolves "localhost".
 */
function inUse(port: number): Promise<boolean> {
  const probe = (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = net.connect({ host, port });
      const done = (result: boolean): void => {
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(250);
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
    });
  return Promise.all([probe("127.0.0.1"), probe("::1")]).then((r) => r.some(Boolean));
}

export async function freePort(preferred: number, attempts = 20): Promise<number> {
  for (let offset = 0; offset < attempts; offset++) {
    const candidate = preferred + offset;
    if (!(await inUse(candidate))) return candidate;
  }
  throw new Error(`no free port between ${preferred} and ${preferred + attempts}`);
}

export async function start(host = config.HOST, port = config.PORT): Promise<void> {
  const chosen = await freePort(port);
  if (chosen !== port && !process.env.PASTPERFECT_BASE_URL) {
    // Canonical links, OpenGraph tags and the sitemap all hang off baseUrl.
    // If we had to move ports, move those with us so what the browser sees
    // matches where the site actually is.
    config.site.baseUrl = `http://localhost:${chosen}`;
  }

  db.init();
  const counts = db.counts();
  const stats = store.overallStats();

  console.log(`\n  ${config.SITE_NAME} — ${config.TAGLINE}`);
  console.log(`  http://localhost:${chosen}\n`);
  console.log(
    `  ${stats.objects.toLocaleString("en-US")} objects in play · ` +
      `${counts.pairs.toLocaleString("en-US")} questions · ${counts.daily_days} daily sets`,
  );
  console.log(`  today is puzzle #${daily.puzzleNumber(daily.today())} (${daily.today()})`);
  if (counts.pairs === 0) console.log("\n  ! No questions yet. Run: npm run build");
  console.log("\n  Ctrl-C to stop\n");
  if (chosen !== port) console.log(`  (port ${port} was busy, using ${chosen})\n`);

  serve({ fetch: app.fetch, hostname: host, port: chosen });
}

if (import.meta.filename === process.argv[1]) {
  await start();
}
