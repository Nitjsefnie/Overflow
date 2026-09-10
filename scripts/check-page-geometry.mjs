#!/usr/bin/env node
/**
 * CI-enforced layout-regression check: measure reader-visible page geometry in
 * a real browser against the pages a real build serves (issue 111).
 *
 * Why this exists: jsdom does no layout. The component suite renders markup and
 * stylesheets but never computes geometry, so a stylesheet edit can push the
 * landing page's sign-in button below the fold with the whole suite green —
 * eleven such mutants were measured while fixing the earlier landing-page
 * issue. This check is the class-level cover:
 *
 *   - a page's primary control moved below the fold,
 *   - an element cut off horizontally,
 *   - the page overflowing sideways.
 *
 * What it deliberately does NOT do: no computed-style or stylesheet-term
 * enumeration (asserting `margin-top: 1.5rem` fails in both directions — it
 * blocks a faithful restyle and misses a different rule with the same effect),
 * and no prose or markup pinning (a test matching page copy fails on a reword
 * and passes when the sentence moves). Reader-visible geometric relations only.
 *
 * Run (after pnpm build):
 *
 *   node scripts/check-page-geometry.mjs
 *
 * or against an already-running server:
 *
 *   node scripts/check-page-geometry.mjs --base-url http://127.0.0.1:3000
 *
 * No new npm dependencies: the script drives Chrome over the DevTools protocol
 * with Node's built-in WebSocket, and starts/stops its own `next start` server.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, open, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const USAGE = `usage: node scripts/check-page-geometry.mjs [--base-url URL] [--help]

Measures the page contracts below in headless Chrome against a real production
build (pnpm build first), asserting per page and viewport: the contract
selector matches, the stylesheet is actually applied, the primary action is
visible, fully above the fold and inside the horizontal bounds, and the page
does not overflow sideways. Exits 1 on any failure.

  --base-url URL   measure against an already-running server instead of
                   spawning one from .next on 127.0.0.1:3219
  --help           this text

Chrome is discovered from LAYOUT_CHECK_CHROME, then google-chrome-stable,
google-chrome, chromium, chromium-browser (PATH and /usr/bin).
`;

if (process.argv.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}

/** A flag's value, failing cleanly when the flag is present but valueless. */
function flaggedValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`${flag} needs a value\n\n${USAGE}`);
    process.exit(2);
  }
  return value;
}

const repoRoot = resolve(import.meta.dirname, "..");
const PORT = 3219;
const BASE_URL = (flaggedValue("--base-url") ?? `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");

/**
 * The page contracts, the table this check exists to keep extensible: a new
 * page's geometry cover is one more entry, not one more test file.
 *
 * `styleProof` proves the real stylesheet is applied before anything is
 * measured — a computed property a stylesheet rule sets on the contract
 * element, alongside the value the rule sets and the value the element would
 * read if the stylesheet had NOT applied. The proof's `defaultRead` is the UA
 * default for THIS contract element (a `<button>` renders `inline-block`
 * unstyled); re-pointing the contract at a different element type means
 * re-deriving it. A run that measures without styles is not evidence, so a
 * proof that reads the default refuses to measure.
 *
 * `renderRoot` is the page's own structural anchor (the skip-link target the
 * landing page puts on its <main>), used to tell "the page did not render"
 * (root absent — an error page or a dead server) apart from "the page
 * rendered but the contract selector is gone" (contract drift). The two are
 * diagnosed differently: the error fallback in src/components/error-fallback.tsx
 * renders the same .landing-hero/.action-button classes, so the contract
 * selector alone cannot make the distinction.
 */
const PAGE_CONTRACTS = [
  {
    page: "/",
    renderRoot: "#main-content",
    viewports: [
      [1440, 800],
      // The fold height is measured, not guessed: on the current stylesheet the
      // primary action's bottom edge sits at 668.4px on a 1280-wide viewport, so
      // a 600px fold would leave this row red on the clean page. 700px pins
      // today's layout with ~31px of headroom, and any downward move past that
      // (the issue-111 mutant class) turns the row red.
      [1280, 700],
    ],
    primaryAction: ".landing-hero .action-button",
    styleProof: {
      property: "display",
      stylesheetValue: "inline-flex",
      defaultRead: "inline-block",
    },
  },
];

/**
 * Discover the Chrome binary: env override first, then the common names on
 * PATH and /usr/bin.
 */
function discoverChrome() {
  const searchDirs = [...new Set((process.env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .concat("/usr/bin"))];

  const candidates = [];
  if (process.env.LAYOUT_CHECK_CHROME) candidates.push(process.env.LAYOUT_CHECK_CHROME);
  for (const name of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
    for (const dir of searchDirs) candidates.push(join(dir, name));
  }

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    console.error(
      "no Chrome/Chromium binary found (looked for google-chrome-stable, google-chrome, " +
        "chromium, chromium-browser on PATH and /usr/bin). " +
        "Set LAYOUT_CHECK_CHROME to the binary's path to override.",
    );
    process.exit(2);
  }
  return found;
}

/** Wait for a WebSocket to open. */
function openSocket(url) {
  return new Promise((resolveOpen, rejectOpen) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolveOpen(ws));
    ws.addEventListener("error", () => rejectOpen(new Error("DevTools socket failed to open")));
  });
}

/** Minimal CDP client: one browser-level socket, flat sessions. */
class DevTools {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
      if (message.id !== undefined && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(`${message.error.message}: ${message.error.data ?? ""}`));
        else entry.resolve(message.result);
        return;
      }
      for (const handler of this.eventHandlers) handler(message);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      // The timer is cleared the moment the response arrives (and in its own
      // callback), so a finished run never idles behind pending CDP timers.
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  on(handler) {
    this.eventHandlers.push(handler);
  }
}

function waitForDevToolsUrl(child) {
  return new Promise((res, rej) => {
    let buffer = "";
    const timer = setTimeout(() => rej(new Error("chrome never printed a DevTools endpoint")), 20000);
    const onData = (chunk) => {
      buffer += chunk;
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        child.stderr.off("data", onData);
        res(match[1]);
      }
    };
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      rej(new Error(`chrome exited early with code ${code}`));
    });
  });
}

/** The server log's tail, for error messages. */
async function readFileHead(path) {
  try {
    const text = await readFile(path, "utf8");
    const lines = text.trimEnd().split("\n");
    return lines.slice(-15).join("\n");
  } catch {
    return "(no server log)";
  }
}

/** SIGTERM, then SIGKILL once a grace elapses. */
async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  for (let waited = 0; waited < 5000; waited += 100) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
  }
  child.kill("SIGKILL");
}

/**
 * Spawn `next start` from the production build and wait for readiness, or
 * return null when --base-url was given. Readiness is this child's own
 * answer: the loop checks the child's liveness first and after any successful
 * response, so a stale server squatting on the port can never be mistaken for
 * this run's build. Any throw kills the child before propagating — a failed
 * start must not leak a server.
 */
async function startServer(workDir) {
  const dotNext = join(repoRoot, ".next");
  if (!existsSync(dotNext)) {
    console.error(`${dotNext} not found — run pnpm build first`);
    process.exit(2);
  }

  const logPath = join(workDir, "next-start.log");
  const logFile = await open(logPath, "a");
  try {
    const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", logFile.fd, logFile.fd],
    });

    try {
      const childDied = () => child.exitCode !== null || child.signalCode !== null;
      const death = () => `next start exited with code ${child.exitCode ?? child.signalCode}`;

      const deadline = Date.now() + 60000;
      for (;;) {
        if (childDied()) {
          throw new Error(`${death()} before answering on ${BASE_URL}\n${await readFileHead(logPath)}`);
        }
        let answered = false;
        try {
          const response = await fetch(`${BASE_URL}/`);
          if (response.body) await response.body.cancel(); // any HTTP response counts; release the socket
          answered = true;
        } catch {
          // no HTTP response yet
        }
        if (answered) {
          if (childDied()) {
            throw new Error(
              `something answered on ${BASE_URL}, but ${death()} — refusing to measure a foreign server` +
                `\n${await readFileHead(logPath)}`,
            );
          }
          break;
        }
        if (Date.now() > deadline) {
          throw new Error(`next start never answered on ${BASE_URL} within 60s\n${await readFileHead(logPath)}`);
        }
        await new Promise((resolveTick) => setTimeout(resolveTick, 250));
      }
      return child;
    } catch (error) {
      await stopServer(child);
      throw error;
    }
  } finally {
    await logFile.close();
  }
}

/** Evaluate an expression in the page, returning its value. */
async function evaluate(client, sessionId, expression) {
  const { result } = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(`page evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
  }
  return result.value;
}

/** Evaluate an async expression, awaiting its promise in the page. */
async function evaluateAsync(client, sessionId, expression) {
  const { result } = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(`page evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
  }
  return result.value;
}

/** Poll a boolean-valued expression until it evaluates true. */
async function pollFor(client, sessionId, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(client, sessionId, expression)) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for the page to settle");
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
  }
}

/**
 * Wait out the two layout inputs that land AFTER the load event: web fonts
 * (a cold fontconfig resolves and swaps them late, and a fallback-font layout
 * measures differently) and the frame that paints the post-font relayout.
 * Measuring before both is how a clean page reads a mutant's geometry.
 */
async function settleLayout(client, sessionId) {
  await evaluateAsync(client, sessionId, "document.fonts.ready.then(() => true)");
  await evaluateAsync(client, sessionId, "new Promise((resolve) => requestAnimationFrame(() => resolve(true)))");
}

/** Format a number as a compact measurement. */
const px = (value) => `${Math.round(value * 10) / 10}px`;

/**
 * The in-page measurement for one contract: the primary action's rect, the
 * style-proof property, and the viewport bounds, all read in the page.
 * Selectors are interpolated with JSON.stringify, never string-concatenated.
 * A missing render root and a missing contract element are returned as
 * distinct shapes so the caller can tell "page did not render" from
 * "contract drift".
 */
function measureExpression(selector, rootSelector, styleProof) {
  return `(() => {
  const root = document.querySelector(${JSON.stringify(rootSelector)});
  if (!root) return { rootFound: false };
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return { rootFound: true, found: false };
  const proofProperty = ${JSON.stringify(styleProof.property)};
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return {
    rootFound: true,
    found: true,
    proofValue: style[proofProperty],
    width: rect.width,
    height: rect.height,
    top: rect.top,
    left: rect.left,
    right: rect.right,
    bottom: rect.bottom,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
  };
})()`;
}

/**
 * The assertions of one page/viewport row, evaluated against one measurement.
 * Returns the list of failed assertions with measured numbers; an empty list
 * is a PASS row. Assertion (a) — the contract selector matching nothing on a
 * RENDERED page — is handled by the caller: it is a hard fail that stops the
 * whole run, because a faithful markup rewrite must re-point the contract
 * visibly rather than silently drop coverage.
 */
function failedAssertions(measured, styleProof) {
  const failures = [];

  if (measured.proofValue === styleProof.defaultRead) {
    failures.push(
      `stylesheet not applied (${styleProof.property} reads the default ` +
        `"${measured.proofValue}") — refusing to measure`,
    );
    return failures;
  }

  if (!(measured.width > 0 && measured.height > 0)) {
    failures.push(
      `primary action not visible (measured ${px(measured.width)} x ${px(measured.height)})`,
    );
    return failures;
  }

  const bounds = [];
  if (!(measured.top >= 0)) bounds.push(`top ${px(measured.top)} < 0`);
  if (!(measured.left >= 0)) bounds.push(`left ${px(measured.left)} < 0`);
  if (!(measured.right <= measured.innerWidth)) {
    bounds.push(`right ${px(measured.right)} > innerWidth ${px(measured.innerWidth)}`);
  }
  if (!(measured.bottom <= measured.innerHeight)) {
    bounds.push(`bottom ${px(measured.bottom)} > fold ${px(measured.innerHeight)}`);
  }
  if (bounds.length > 0) {
    failures.push(`primary action out of bounds: ${bounds.join(", ")}`);
  }

  if (!(measured.scrollWidth <= measured.innerWidth)) {
    failures.push(
      `horizontal page overflow: scrollWidth ${px(measured.scrollWidth)} > ` +
        `innerWidth ${px(measured.innerWidth)}`,
    );
  }

  return failures;
}

/** Short human label for a viewport pair. */
const viewportLabel = ([width, height]) => `${width}x${height}`;

/** This run's HTTP status for a page, for render-failure diagnosis. */
async function probeStatus(page) {
  try {
    const response = await fetch(`${BASE_URL}${page}`);
    if (response.body) await response.body.cancel();
    return response.status;
  } catch {
    return "no response";
  }
}

async function main() {
  const chrome = discoverChrome();
  const workDir = await mkdtemp(join(tmpdir(), "page-geometry-"));
  const spawned = BASE_URL === `http://127.0.0.1:${PORT}`;
  let server = null;
  let failed = false;
  let hardFailure = null;

  try {
    if (spawned) server = await startServer(workDir);

    const child = spawn(chrome, [
      "--headless=new",
      "--remote-debugging-port=0",
      "--no-sandbox",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${join(workDir, "profile")}`,
      "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.resume();

    try {
      const browserUrl = await waitForDevToolsUrl(child);
      const client = new DevTools(await openSocket(browserUrl));
      const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
      await client.send("Page.enable", {}, sessionId);

      const rows = [];
      pageLoop:
      for (const contract of PAGE_CONTRACTS) {
        const url = `${BASE_URL}${contract.page}`;
        await client.send("Page.navigate", { url }, sessionId);
        // The URL match keeps the poll from being satisfied by the departing
        // about:blank document before the navigation commits.
        await pollFor(client, sessionId,
          `document.readyState === 'complete' && location.href === ${JSON.stringify(url)}`,
          30000);
        await settleLayout(client, sessionId);

        for (const viewport of contract.viewports) {
          await client.send("Emulation.setDeviceMetricsOverride", {
            width: viewport[0],
            height: viewport[1],
            deviceScaleFactor: 1,
            mobile: false,
          }, sessionId);
          // The override forces a relayout; measure only after fonts and the
          // painting frame have settled the new layout.
          await settleLayout(client, sessionId);

          const measured = await evaluate(client, sessionId, measureExpression(contract.primaryAction, contract.renderRoot, contract.styleProof));
          const label = `${contract.page} @ ${viewportLabel(viewport)}`;

          if (!measured.rootFound) {
            // The document lacks the page's structural anchor: this is a
            // render failure (error page, dead server), not contract drift.
            const status = await probeStatus(contract.page);
            failed = true;
            console.log(
              `${label}: FAIL — page did not render (HTTP ${status}); ` +
                `document lacks "${contract.renderRoot}"`,
            );
            rows.push({ label, failures: ["render"] });
            break;
          }

          if (!measured.found) {
            // The page rendered but the contract element is gone: a markup
            // rewrite must re-point the contract VISIBLY, so stop the run —
            // after cleanup, via the flag below, never via process.exit.
            hardFailure =
              `page contract out of date — update the selector in scripts/check-page-geometry.mjs ` +
              `("${contract.primaryAction}" matched nothing on ${contract.page} at ` +
              `${viewportLabel(viewport)}; the page rendered — "${contract.renderRoot}" is present)`;
            break pageLoop;
          }

          const failures = failedAssertions(measured, contract.styleProof);
          if (failures.length === 0) {
            console.log(
              `${label}: PASS (action ${px(measured.width)} x ${px(measured.height)} at ` +
                `(${px(measured.left)}, ${px(measured.top)}), bottom ${px(measured.bottom)} <= fold ` +
                `${px(measured.innerHeight)}, scrollWidth ${px(measured.scrollWidth)})`,
            );
          } else {
            failed = true;
            console.log(`${label}: FAIL — ${failures.join("; ")}`);
          }
          rows.push({ label, failures });
        }
      }

      const passed = rows.filter((row) => row.failures.length === 0).length;
      console.log(`\n${rows.length} page/viewport checks: ${passed} pass, ${rows.length - passed} fail`);
    } finally {
      child.kill("SIGKILL");
    }
  } finally {
    await stopServer(server);
  }

  if (hardFailure) {
    console.error(hardFailure);
    process.exitCode = 1;
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
