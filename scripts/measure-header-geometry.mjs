#!/usr/bin/env node
/**
 * Measure the real header's geometry across viewport widths, in headless
 * Chromium, against the real stylesheet and the real header markup.
 *
 * Why this exists: issue 40 — at tablet widths the member navigation wraps
 * inside the middle grid column of the three-column header and the wordmark,
 * navigation and member stamp end up on three different vertical centres, so
 * the header roughly doubles in height. The header wrap breakpoint in
 * src/app/globals.css is chosen from this measurement, not guessed, and any
 * change to it is re-measured here:
 *
 *   node scripts/measure-header-geometry.mjs
 *
 * No new npm dependencies: the script drives /usr/bin/chromium over the DevTools
 * protocol using Node's built-in WebSocket, generates a harness page carrying
 * the real header markup (transcribed from src/components/app-shell.tsx, both
 * the member and the moderator navigation variants) and loads the real
 * stylesheet from src/app/globals.css via <link>.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const cssArg = process.argv.indexOf("--css");
const cssPath = cssArg === -1
  ? join(repoRoot, "src/app/globals.css")
  : resolve(process.argv[cssArg + 1]);
const outArg = process.argv.indexOf("--out");
const outPath = outArg === -1 ? null : resolve(process.argv[outArg + 1]);

if (!existsSync(cssPath)) {
  console.error(`stylesheet not found: ${cssPath}`);
  process.exit(2);
}

const CHROMIUM = "/usr/bin/chromium";
/**
 * The 1280px desktop reference plus the wrap band. The band's upper end is
 * data-driven: the moderator navigation has grown past what the issue filed,
 * and the width where it stops wrapping may sit well above 1150px.
 */
const WIDTHS = [1280, ...Array.from({ length: 21 }, (_, i) => 700 + i * 30)];
/** The stamp text the harness renders: a realistic login, not a best case. */
const MEMBER_NAME = "Nitjsefnie";

/** The member navigation, transcribed from src/components/app-shell.tsx. */
const MEMBER_LINKS = [
  ["Ledger", "/dashboard"],
  ["Issues", "/issues"],
  ["Settlements", "/settlements"],
  ["Members", "/members"],
  ["Register a repository", "/repositories/new"],
  ["Calibration", "/calibration"],
  ["Rules", "/rules"],
];

/** The moderator variant appends Moderation: the widest nav Overflow ships. */
const MODERATOR_LINKS = [...MEMBER_LINKS, ["Moderation", "/moderation"]];

const VARIANTS = [
  { id: "member", links: MEMBER_LINKS },
  { id: "moderator", links: MODERATOR_LINKS },
];

function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

/**
 * The real header markup (AppShell in src/components/app-shell.tsx), with the
 * moderator-only Moderation link parameterized. The wordmark keeps its
 * aria-label and the mark its aria-hidden so the DOM shape matches the app.
 */
function harnessPage(variant, cssUrl) {
  const listItems = variant.links.map(([label, href]) =>
    `          <li><a href="${href}">${escapeHtml(label)}</a></li>`
  ).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${cssUrl}">
</head>
<body>
<div class="app-shell">
  <header class="site-header">
    <a class="wordmark" href="/dashboard" aria-label="Overflow dashboard"><span class="mark" aria-hidden="true"></span><span>Overflow</span></a>
    <nav aria-label="Member navigation">
      <ul class="site-nav">
${listItems}
      </ul>
    </nav>
    <div class="session-controls">
      <p class="member-stamp">Signed in as <span>${escapeHtml(MEMBER_NAME)}</span></p>
      <form><button class="quiet-button" type="submit">Sign out</button></form>
    </div>
  </header>
</div>
</body>
</html>
`;
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
        const { resolve: res, reject: rej } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) rej(new Error(`${message.error.message}: ${message.error.data ?? ""}`));
        else res(message.result);
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
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`CDP timeout: ${method}`));
        }
      }, 20000);
    });
  }

  on(handler) {
    this.eventHandlers.push(handler);
  }
}

function waitForDevToolsUrl(child) {
  return new Promise((res, rej) => {
    let buffer = "";
    const timer = setTimeout(() => rej(new Error("chromium never printed a DevTools endpoint")), 20000);
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
      rej(new Error(`chromium exited early with code ${code}`));
    });
  });
}

/** The in-page measurement, a self-invoking expression. */
const MEASURE = `(() => {
  const header = document.querySelector(".site-header");
  const wordmark = document.querySelector(".wordmark");
  const stamp = document.querySelector(".member-stamp");
  const session = document.querySelector(".session-controls");
  const nav = document.querySelector(".site-nav");
  if (!header || !wordmark || !nav) return { error: "header markup missing" };
  const hr = header.getBoundingClientRect();
  const wr = wordmark.getBoundingClientRect();
  const sr = stamp ? stamp.getBoundingClientRect() : null;
  const cr = session ? session.getBoundingClientRect() : null;
  const nr = nav.getBoundingClientRect();
  const linkRects = [...nav.querySelectorAll("a")].map((a) => a.getBoundingClientRect());
  const rowTops = [];
  for (const rect of linkRects) {
    if (!rowTops.some((top) => Math.abs(top - rect.top) <= 2)) rowTops.push(rect.top);
  }
  rowTops.sort((a, b) => a - b);
  const centre = (rect) => rect.top + rect.height / 2 - hr.top;
  const round1 = (value) => Math.round(value * 10) / 10;
  return {
    viewport: window.innerWidth,
    stylesheetLoaded: document.styleSheets.length > 0 && getComputedStyle(header).display === "grid",
    headerHeight: round1(hr.height),
    wordmarkCentre: round1(centre(wr)),
    stampCentre: sr ? round1(centre(sr)) : null,
    sessionControlsCentre: cr ? round1(centre(cr)) : null,
    firstNavRowCentre: linkRects.length ? round1(centre(linkRects[0])) : null,
    navRowCount: rowTops.length,
    navRowTops: rowTops.map((top) => round1(top - hr.top)),
    navLeft: round1(nr.left),
    navWidth: round1(nr.width),
    headerLeft: round1(hr.left),
    headerWidth: round1(hr.width),
  };
})()`;

/**
 * The defect's signature and the fix's pass criteria, applied to one measured
 * row, judged at CELL level. The stamp is the top item of the session-controls
 * grid (the Sign out button sits below it), so the wordmark aligns with the
 * identity cluster and never with the stamp element alone: measured on the
 * pre-fix stylesheet, the stamp element's centre sits ~28px above the cell
 * centre at every width, the 1280px desktop included, so an element-level
 * "stamp centred on the wordmark" criterion is unsatisfiable at any width and
 * the element-level three-centre count (reported, not gating) describes the
 * visual imbalance rather than the defect. The defect itself is the middle
 * column wrap: a nav of two or more rows sharing the wordmark's row. pass:
 * wordmark and session-controls on a shared centre, and the nav on one row or
 * wrapped only inside its own full-width left-aligned row.
 */
function judge(row) {
  const centres = [row.wordmarkCentre, row.stampCentre, row.firstNavRowCentre]
    .filter((value) => value !== null);
  const distinct = [];
  for (const value of centres) {
    if (!distinct.some((seen) => Math.abs(seen - value) <= 1)) distinct.push(value);
  }
  const aligned = row.sessionControlsCentre !== null &&
    Math.abs(row.wordmarkCentre - row.sessionControlsCentre) <= 1;
  const navFullWidth = Math.abs(row.navLeft - row.headerLeft) <= 1 &&
    Math.abs(row.navWidth - row.headerWidth) <= 1;
  const navOk = row.navRowCount === 1 || navFullWidth;
  return {
    navFullWidth,
    aligned,
    navOk,
    elementCentresDistinct: distinct.length,
    defect: !aligned || (row.navRowCount >= 2 && !navFullWidth),
    pass: aligned && navOk,
  };
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

/** Poll a boolean-valued expression until it evaluates true. */
async function pollFor(client, sessionId, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(client, sessionId, expression)) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for the page to settle");
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
  }
}

async function main() {
  const workDir = await mkdtemp(join(tmpdir(), "header-geometry-"));
  const results = [];

  const child = spawn(CHROMIUM, [
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

    for (const variant of VARIANTS) {
      const pagePath = join(workDir, `header-${variant.id}.html`);
      const cssUrl = new URL(`file://${cssPath}`).href;
      await writeFile(pagePath, harnessPage(variant, cssUrl));
      await client.send("Page.navigate", { url: `file://${pagePath}` }, sessionId);
      await pollFor(client, sessionId,
        "document.readyState === 'complete' && getComputedStyle(document.querySelector('.site-header')).display === 'grid'",
        10000);

      for (const width of WIDTHS) {
        await client.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        }, sessionId);
        await new Promise((resolveTick) => setTimeout(resolveTick, 40));
        const row = await evaluate(client, sessionId, MEASURE);
        if (row.error) throw new Error(`${variant.id}@${width}: ${row.error}`);
        if (!row.stylesheetLoaded) {
          throw new Error(`${variant.id}@${width}: the real stylesheet did not load — refusing to measure`);
        }
        results.push({ variant: variant.id, ...row, ...judge(row) });
      }
    }
  } finally {
    child.kill("SIGKILL");
  }

  console.log("Header geometry sweep — real markup, real stylesheet, headless chromium");
  console.log(`stamp text: "Signed in as ${MEMBER_NAME}"; band 700-1300 step 30 plus the 1280 reference\n`);

  for (const variant of VARIANTS) {
    const reference = results.find((r) => r.variant === variant.id && r.viewport === 1280);
    console.log(`== ${variant.id} variant (${variant.links.length} nav links) ==`);
    console.log(
      `  desktop reference @1280: header ${reference.headerHeight}px, ` +
        `${reference.navRowCount} nav row(s)\n`,
    );
    console.log("  width  headerHt  navRows  wordmarkC  stampC  navRow1C  navFull  verdict");
    for (const row of results.filter((r) => r.variant === variant.id)) {
      const navFull = row.navFullWidth ? "yes" : "no";
      const label = row.pass ? "pass" : row.defect ? "DEFECT" : "mixed";
      console.log(
        `  ${String(row.viewport).padStart(5)}  ${String(row.headerHeight).padStart(8)}  ` +
          `${String(row.navRowCount).padStart(7)}  ${String(row.wordmarkCentre).padStart(9)}  ` +
          `${String(row.stampCentre).padStart(6)}  ${String(row.firstNavRowCentre).padStart(8)}  ` +
          `${navFull.padStart(6)}  ${label}`,
      );
    }
    console.log();
  }

  if (outPath) {
    await writeFile(outPath, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`JSON written to ${outPath}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
