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
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const USAGE = `usage: node scripts/measure-header-geometry.mjs [--css PATH] [--out PATH] [--help]

Sweeps the real header (member, moderator and signed-out variants) across
viewport widths in headless chromium and prints, per width: nav row count,
wordmark / stamp / session-controls centres, header height, and a
pass/DEFECT verdict. Dense-samples every 5px across [600, breakpoint+200]
around the header breakpoint the stylesheet declares — the full responsive
band, so a narrow media band cannot hide between coarse steps — and sweeps
30px above it, 1280px as the desktop reference. Exits 1 when any DEFECT
row exists, so a CI promotion gates on the status code.

  --css PATH   stylesheet to measure (default: src/app/globals.css)
  --out PATH   also write every raw row as JSON
  --help       this text
`;

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

if (process.argv.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}

const repoRoot = resolve(import.meta.dirname, "..");
const cssPath = resolve(flaggedValue("--css") ?? join(repoRoot, "src/app/globals.css"));
const outPath = flaggedValue("--out");

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
  /**
   * The signed-out shell (PublicAppShell): no session controls, and the nav
   * carries the proven-public account-data notice.
   */
  { id: "public", links: [["Account data", "/account-data"]] },
];

function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

/**
 * The real header markup, transcribed: AppShell in src/components/app-shell.tsx
 * with the moderator-only Moderation link parameterized, and PublicAppShell
 * for the public variant — wordmark linking the public entry, the nav carrying
 * the proven-public account-data link, and no session controls.
 */
function harnessPage(variant, cssUrl) {
  const listItems = variant.links.map(([label, href]) =>
    `          <li><a href="${href}">${escapeHtml(label)}</a></li>`
  ).join("\n");
  const sessionControls = variant.id === "public"
    ? ""
    : `    <div class="session-controls">
      <p class="member-stamp">Signed in as <span>${escapeHtml(MEMBER_NAME)}</span></p>
      <form><button class="quiet-button" type="submit">Sign out</button></form>
    </div>
`;
  const wordmarkHref = variant.id === "public" ? "/" : "/dashboard";
  const wordmarkLabel = variant.id === "public" ? "Overflow home" : "Overflow dashboard";
  const navLabel = variant.id === "public" ? "Site navigation" : "Member navigation";
  const navList = `      <ul class="site-nav">
${listItems}
      </ul>`;
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
    <a class="wordmark" href="${wordmarkHref}" aria-label="${wordmarkLabel}"><span class="mark" aria-hidden="true"></span><span>Overflow</span></a>
    <nav aria-label="${navLabel}">
${navList}
    </nav>
${sessionControls}  </header>
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
  const paddingY = (() => {
    const style = getComputedStyle(header);
    return parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) +
      parseFloat(style.borderBottomWidth);
  })();
  return {
    viewport: window.innerWidth,
    stylesheetLoaded: document.styleSheets.length > 0 && getComputedStyle(header).display === "grid",
    headerHeight: round1(hr.height),
    wordmarkCentre: round1(centre(wr)),
    wordmarkHeight: round1(wr.height),
    navRectHeight: round1(nr.height),
    navRectCount: nav.getClientRects().length,
    stampCentre: sr ? round1(centre(sr)) : null,
    sessionControlsCentre: cr ? round1(centre(cr)) : null,
    firstNavRowCentre: linkRects.length ? round1(centre(linkRects[0])) : null,
    navRowCount: rowTops.length,
    navRowTops: rowTops.map((top) => round1(top - hr.top)),
    navLeft: round1(nr.left),
    navWidth: round1(nr.width),
    headerLeft: round1(hr.left),
    headerPaddingY: round1(paddingY),
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
function judge(row, variant) {
  const navFullWidth = Math.abs(row.navLeft - row.headerLeft) <= 1 &&
    Math.abs(row.navWidth - row.headerWidth) <= 1;
  if (variant === "public") {
    // The signed-out header renders the wordmark and the account-data link,
    // so its nav must hold one row when the header holds one (desktop) and
    // take its own full-width row when the header stacks — the same nav
    // criterion as the member variants, minus the session-controls alignment
    // that has no counterpart here.
    const navOk = row.navRowCount === 1 || navFullWidth;
    return {
      navFullWidth,
      aligned: true,
      navOk,
      elementCentresDistinct: 1,
      defect: row.navRowCount >= 2 && !navFullWidth,
      pass: navOk,
    };
  }
  const centres = [row.wordmarkCentre, row.stampCentre, row.firstNavRowCentre]
    .filter((value) => value !== null);
  const distinct = [];
  for (const value of centres) {
    if (!distinct.some((seen) => Math.abs(seen - value) <= 1)) distinct.push(value);
  }
  const aligned = row.sessionControlsCentre !== null &&
    Math.abs(row.wordmarkCentre - row.sessionControlsCentre) <= 1;
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

/**
 * The header wrap breakpoint the stylesheet under test declares, so the sweep
 * can dense-sample the band where a wrong breakpoint hides: just above the
 * declared value the three-column layout returns, and the widest navigation
 * must fit on one row there. Found by the same shape the guard test pins — a
 * media block carrying a .site-header grid-template-columns decision — so the
 * dense band follows whatever stylesheet this run measures, mutants included.
 */
function declaredHeaderBreakpoint(cssText) {
  const text = cssText.replaceAll(/\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\//g, "");
  let index = text.indexOf("@media");
  while (index !== -1) {
    const open = text.indexOf("{", index);
    let depth = 1;
    let cursor = open + 1;
    while (depth > 0 && cursor < text.length) {
      if (text[cursor] === "{") depth++;
      if (text[cursor] === "}") depth--;
      cursor++;
    }
    if (/\.site-header\s*\{[^}]*grid-template-columns/.test(text.slice(open + 1, cursor - 1))) {
      const width = text.slice(index, open).match(/max-width:\s*(\d+(?:\.\d+)?)px/);
      if (width) return Number(width[1]);
    }
    index = text.indexOf("@media", cursor);
  }
  return null;
}

async function main() {
  const workDir = await mkdtemp(join(tmpdir(), "header-geometry-"));
  const results = [];

  const declared = declaredHeaderBreakpoint(readFileSync(cssPath, "utf8"));
  const sweep = new Set(WIDTHS);
  if (declared === null) {
    for (let width = 600; width <= 1000; width += 5) sweep.add(width);
    console.log("no declared header breakpoint found; dense 600-1000 step 5, coarse elsewhere");
  } else {
    for (let width = 600; width <= declared + 200; width += 5) sweep.add(width);
  }
  const widths = [...sweep].sort((a, b) => a - b);

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

      for (const width of widths) {
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
        results.push({ variant: variant.id, ...row, ...judge(row, variant.id) });
      }
    }
  } finally {
    child.kill("SIGKILL");
  }

  console.log("Header geometry sweep — real markup, real stylesheet, headless chromium");
  if (declared === null) {
    console.log("no declared header breakpoint found; dense 600-1000 step 5, coarse elsewhere");
  } else {
    console.log(
      `dense 5px sweep 600-${declared + 200} around declared header breakpoint ${declared}px; ` +
        `coarse 30px above`,
    );
  }
  console.log(`stamp text: "Signed in as ${MEMBER_NAME}"; ${widths.length} widths per variant\n`);

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
      const dash = (value) => value === null ? "-" : String(value);
      const label = row.pass ? "pass" : row.defect ? "DEFECT" : "mixed";
      console.log(
        `  ${String(row.viewport).padStart(5)}  ${String(row.headerHeight).padStart(8)}  ` +
          `${String(row.navRowCount).padStart(7)}  ${String(row.wordmarkCentre).padStart(9)}  ` +
          `${dash(row.stampCentre).padStart(6)}  ${dash(row.firstNavRowCentre).padStart(8)}  ` +
          `${navFull.padStart(6)}  ${label}`,
      );
    }
    console.log();
  }

  if (outPath) {
    await writeFile(outPath, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`JSON written to ${outPath}`);
  }

  const defects = results.filter((row) => row.defect).length;
  if (defects > 0) {
    console.log(`${defects} DEFECT rows — failing`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
