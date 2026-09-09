/**
 * Measure the /issues filter controls in a real browser.
 *
 * jsdom does no layout, so a rendering test cannot see the defect this measures
 * (issue 32): the claim-state select beside two styled text inputs. This script
 * builds a fixture from the real `src/app/globals.css` plus the form markup from
 * `src/app/issues/page.tsx`, loads it in headless chromium at the viewport the
 * issue was measured at (1718px), and reports, per control: box height, computed
 * border width, background colour, font size, and the border colour while
 * focused. It exits nonzero when the three controls disagree on any of those —
 * the issue's expected behaviour, "the select matches the text inputs".
 *
 * Usage: node scripts/measure-field-controls.ts [<path-to-globals.css>]
 *
 * The script is not wired into CI (chromium is not a CI dependency); run it
 * against a candidate stylesheet before merging UI changes to these controls.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cssPath = process.argv[2] ?? path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/app/globals.css",
);
const stylesheet = await readFile(cssPath, "utf8");
const viewportWidth = 1718;

// The form markup mirrors src/app/issues/page.tsx: one `.surface` form holding
// two `label.field` text inputs and one `label.field` select, in the same order.
const formMarkup = `
<form class="surface" method="get" action="/issues" aria-label="Filter eligible issues">
  <label class="field">
    <span>Repository</span>
    <input name="repository" placeholder="owner/name" />
  </label>
  <label class="field">
    <span>Offered rating label</span>
    <input name="openingLabel" />
  </label>
  <label class="field">
    <span>Claim state</span>
    <select name="claimState">
      <option value="OPEN">Unclaimed</option>
      <option value="CLAIMED">Claimed</option>
      <option value="ALL">All</option>
    </select>
  </label>
  <button class="action-button" type="submit">Apply filters</button>
</form>`;

const fixture = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>${stylesheet}</style>
</head>
<body>
<main class="page-content">
${formMarkup}
</main>
<pre id="results" style="display:none"></pre>
<script>
  window.focus();
  const controls = [
    ["input.repository", document.querySelector('.field input[name="repository"]')],
    ["input.openingLabel", document.querySelector('.field input[name="openingLabel"]')],
    ["select.claimState", document.querySelector('.field select[name="claimState"]')],
  ];
  const measured = [];
  for (const [name, element] of controls) {
    const box = element.getBoundingClientRect();
    const computed = getComputedStyle(element);
    // Focus ownership (document.activeElement) can hold while the :focus
    // STYLE has not applied — headless window focus flaps — and then
    // border-color reads the unfocused value on every control, which compares
    // as agreement. Read the unfocused border first, then focus and wait
    // through timers (virtual time drives timers; rAF is not waited for by
    // --dump-dom) before reading the focused value, and record whether the
    // reading actually changed so the runner can refuse a dead run.
    measured.push({
      control: name,
      height: box.height,
      borderWidth: computed.borderTopWidth,
      background: computed.backgroundColor,
      fontSize: computed.fontSize,
      focusBorderColor: "",
      focused: false,
      focusApplied: false,
      unfocusedBorder: computed.borderTopColor,
    });
  }
  const focusNext = () => {
    if (measured.every((entry) => entry.focused)) {
      for (const entry of measured) delete entry.unfocusedBorder;
      document.getElementById("results").textContent = JSON.stringify(measured);
      return;
    }
    const index = measured.findIndex((entry) => !entry.focused);
    const name = measured[index].control;
    const element = controls.find(([candidate]) => candidate === name)[1];
    element.focus();
    measured[index].focused = document.activeElement === element;
    setTimeout(() => {
      const focusBorder = getComputedStyle(element).borderTopColor;
      measured[index].focusBorderColor = focusBorder;
      measured[index].focusApplied = focusBorder !== measured[index].unfocusedBorder;
      element.blur();
      setTimeout(focusNext, 30);
    }, 30);
  };
  focusNext();
</script>
</body>
</html>`;

type MeasuredControl = {
  control: string;
  height: number;
  borderWidth: string;
  background: string;
  fontSize: string;
  focusBorderColor: string;
  focused: boolean;
  focusApplied: boolean;
};

const directory = await mkdtemp(path.join(tmpdir(), "field-controls-"));
const fixturePath = path.join(directory, "fixture.html");
await writeFile(fixturePath, fixture);

/** One headless chromium run over the fixture; the parsed per-control measurements. */
function measureOnce(): Promise<MeasuredControl[]> {
  return new Promise<MeasuredControl[]>((resolve, reject) => {
    const chromium = spawn(
      "chromium",
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        // A per-run profile: the shared default profile carries state whose
        // effect on window focus is one more variable a flaky reading hides.
        `--user-data-dir=${path.join(directory, "chromium-profile")}`,
        `--window-size=${viewportWidth},1200`,
        "--virtual-time-budget=2000",
        "--dump-dom",
        `file://${fixturePath}`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let dom = "";
    chromium.stdout.on("data", (chunk) => {
      dom += chunk;
    });
    chromium.on("error", reject);
    chromium.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`chromium exited ${code}`));
        return;
      }
      const match = dom.match(/<pre id="results"[^>]*>([\s\S]*?)<\/pre>/);
      if (!match) {
        reject(new Error("the measurement block never reached the dumped DOM"));
        return;
      }
      const decoded = match[1]
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
      resolve(JSON.parse(decoded));
    });
  });
}

/**
 * Headless window focus flaps between runs; a run whose :focus style never
 * applied is refused (focused/focusApplied false), not scored. Retry a refusal
 * a few times before giving up — each accepted run has asserted the applied
 * focus reading on every control, so a retry can never launder a false green.
 */
const maxAttempts = 4;
try {
  let measured: MeasuredControl[] | undefined;
  for (let attempt = 1; attempt <= maxAttempts && measured === undefined; attempt++) {
    const run = await measureOnce();
    if (run.some((entry) => !entry.focused || !entry.focusApplied)) {
      continue;
    }
    measured = run;
  }

  if (measured === undefined) {
    console.error(
      "Focus ownership or :focus style application failed on every attempt; the focus-border reading would be the unfocused value. Either the headless window never focused, or no :focus rule changes any control's border colour.",
    );
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(measured, null, 2));

    const failures: string[] = [];
    const inputs = measured.filter((entry) => entry.control.startsWith("input."));
    const select = measured.find((entry) => entry.control === "select.claimState");
    if (!select || inputs.length < 2) {
      console.error("The fixture did not yield the three controls to compare.");
      process.exitCode = 1;
    } else {
      for (const property of ["height", "borderWidth", "background", "fontSize", "focusBorderColor"] as const) {
        const reference = inputs[0][property];
        for (const entry of [inputs[1], select]) {
          if (entry[property] !== reference) {
            failures.push(`${entry.control} ${property} is ${entry[property]}, expected ${reference}`);
          }
        }
      }
      if (failures.length > 0) {
        console.error(`MISMATCHES:\n${failures.map((line) => `  - ${line}`).join("\n")}`);
        process.exitCode = 1;
      } else {
        console.error("All three controls agree on height, border, background, font size and focus border.");
      }
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
