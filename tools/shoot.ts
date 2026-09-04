/**
 * Screenshot and drive the running site through the Chrome DevTools Protocol.
 *
 * A development tool, not part of the app. It exists because headless Chrome's
 * --screenshot flag cannot click anything, and driving a page through an iframe
 * fights its virtual-time clock. CDP over Node's built-in WebSocket needs no
 * dependencies and can actually play the game.
 *
 *   node tools/shoot.ts <url> <out.png> [--width 1280] [--height 900]
 *                       [--click #selector]... [--wait 800]
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  #socket: WebSocket;
  #next = 1;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const waiter = this.#pending.get(message.id);
      if (!waiter) return;
      this.#pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("cdp connect failed")), { once: true });
    });
    return new Cdp(socket);
  }

  /**
   * In flat mode the session id is a sibling of params, not a member of it --
   * putting it inside params makes the browser look for the method on itself
   * and report that Page.enable does not exist.
   */
  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{ result: { value: T } }>("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    });
    return result.result.value;
  }

  close(): void {
    this.#socket.close();
  }
}

async function browserUrl(port: number, attempts = 60): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      const info = (await response.json()) as { webSocketDebuggerUrl: string };
      if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("Chrome did not expose a debugging endpoint");
}

export async function shoot(options: {
  url: string; out: string; width: number; height: number;
  clicks: string[]; wait: number; fullPage: boolean;
}): Promise<void> {
  const port = 9222 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pp-chrome-"));
  const chrome: ChildProcess = spawn(
    CHROME,
    [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
      "--no-default-browser-check", "--disable-background-networking",
      `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      `--window-size=${options.width},${options.height}`, "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    const cdp = await Cdp.connect(await browserUrl(port));
    // Size is set through Emulation below; Target.createTarget only accepts a
    // size for a genuinely new window.
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId, flatten: true,
    });
    const call = (method: string, params: Record<string, unknown> = {}) =>
      cdp.send(method, params, sessionId);

    await call("Page.enable");
    await call("Runtime.enable");
    await call("Emulation.setDeviceMetricsOverride", {
      width: options.width, height: options.height, deviceScaleFactor: 1, mobile: options.width < 500,
    });
    await call("Page.navigate", { url: options.url });
    await sleep(options.wait);

    for (const selector of options.clicks) {
      await call("Runtime.evaluate", {
        expression: `document.querySelector(${JSON.stringify(selector)})?.click()`,
        awaitPromise: false, returnByValue: true,
      });
      await sleep(options.wait);
    }

    const shot = await call("Page.captureScreenshot", {
      format: "png",
      ...(options.fullPage ? { captureBeyondViewport: true } : {}),
    }) as { data: string };
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, Buffer.from(shot.data, "base64"));
    console.log(`${options.out}  ${fs.statSync(options.out).size} bytes`);
    cdp.close();
  } finally {
    chrome.kill("SIGKILL");
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

if (import.meta.filename === process.argv[1]) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      width: { type: "string", default: "1280" },
      height: { type: "string", default: "900" },
      click: { type: "string", multiple: true, default: [] },
      wait: { type: "string", default: "1200" },
      full: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  await shoot({
    url: positionals[0]!,
    out: positionals[1]!,
    width: Number(values.width),
    height: Number(values.height),
    clicks: values.click ?? [],
    wait: Number(values.wait),
    fullPage: Boolean(values.full),
  });
}
