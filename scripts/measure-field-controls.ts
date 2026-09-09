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
  const controls = [
    ["input.repository", document.querySelector('.field input[name="repository"]')],
    ["input.openingLabel", document.querySelector('.field input[name="openingLabel"]')],
    ["select.claimState", document.querySelector('.field select[name="claimState"]')],
  ];
  const measured = [];
  for (const [name, element] of controls) {
    const box = element.getBoundingClientRect();
    const computed = getComputedStyle(element);
    element.focus();
    // A headless run can silently fail to move focus; an unfocused reading of
    // border-color is the --line value, which would read as agreement. Record
    // whether focus actually landed so the runner can refuse the measurement.
    const focused = document.activeElement === element;
    const focusBorder = getComputedStyle(element).borderTopColor;
    element.blur();
    measured.push({
      control: name,
      height: box.height,
      borderWidth: computed.borderTopWidth,
      background: computed.backgroundColor,
      fontSize: computed.fontSize,
      focusBorderColor: focusBorder,
      focused,
    });
  }
  document.getElementById("results").textContent = JSON.stringify(measured);
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
};

const directory = await mkdtemp(path.join(tmpdir(), "field-controls-"));
const fixturePath = path.join(directory, "fixture.html");
await writeFile(fixturePath, fixture);

try {
  const measured = await new Promise<MeasuredControl[]>((resolve, reject) => {
    const chromium = spawn(
      "chromium",
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
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

  console.log(JSON.stringify(measured, null, 2));

  const failures: string[] = [];
  if (measured.some((entry) => !entry.focused)) {
    console.error(
      "Focus could not be established on every control; the focus-border reading would be the unfocused value. Re-run.",
    );
    process.exit(2);
  }
  const inputs = measured.filter((entry) => entry.control.startsWith("input."));
  const select = measured.find((entry) => entry.control === "select.claimState");
  if (!select || inputs.length < 2) {
    console.error("The fixture did not yield the three controls to compare.");
    process.exit(1);
  }
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
    process.exit(1);
  }
  console.error("All three controls agree on height, border, background, font size and focus border.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
