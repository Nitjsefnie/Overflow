import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const canonicalInstall = "npm_config_package_import_method=copy pnpm install --frozen-lockfile";
const assignment = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:[A-Za-z0-9_./:-]+|"[A-Za-z0-9_ ./:-]*"|'[A-Za-z0-9_ ./:-]*')`;
const installGrammar = new RegExp(`^(?:${assignment} )*${canonicalInstall}$`);
const otherPnpmShapes = [
  /^pnpm (?:--version|db:migrate|build|test|lint|typecheck)$/,
  /^NEXT_DIST_DIR="\$release" pnpm build$/,
  /^pnpm release:switch \/srv\/overflow "\$(?:release|previous_release)"$/,
  /^pnpm release:prune \/srv\/overflow --keep [1-9][0-9]*$/,
  /^pnpm --silent webhooks:upgrade > "\$upgrade_log" 2>&1 \|\| upgrade_status=\$\?$/,
  /^corepack prepare pnpm@10\.33\.0 --activate$/,
  /^for path in \/root\/overflow\.service\.pre-hardening \/root\/overflow \/root\/\.nvm\/versions\/node\/v24\.17\.0\/bin\/pnpm; do$/,
];

// Quote/escape spellings must not hide a pnpm occurrence from the closed grammar.
function mentionsPnpm(text: string) {
  return text.replace(/\\\r?\n/g, "").replace(/["'\\]/g, "").includes("pnpm");
}

function validateBlock(info: string, body: string): number {
  if (!mentionsPnpm(body)) return 0;
  if (!/^(?:bash|sh|shell)(?:\s|$)/.test(info)) {
    throw new Error(`Unrecognized pnpm fence: ${info || "(no language)"}`);
  }
  let installs = 0;
  for (const source of body.replace(/\\\r?\n/g, "").split(/\r?\n/)) {
    if (!mentionsPnpm(source)) continue;
    const fail = () => { throw new Error(`Unsupported pnpm shape in ${info}: ${source}`); };
    // This is a deliberately bounded lexer, not a shell interpreter. Preserve
    // quoting in words; recognize command separators and unquoted comments.
    const tokens: string[] = [];
    const lexer = /\s+|(?:[^\s;&|()"'\\]+|"[^"\r\n]*"|'[^'\r\n]*'|\\[^\r\n])+|[;&|()]/y;
    let offset = 0;
    while (offset < source.length) {
      if (source[offset] === "#") break;
      lexer.lastIndex = offset;
      const match = lexer.exec(source);
      if (!match) fail();
      const token = match![0];
      offset = lexer.lastIndex;
      if (!/^\s+$/.test(token)) tokens.push(token);
    }
    // An unquoted ! in command position is forbidden even after :; or a pipe.
    let commandPosition = true;
    for (const token of tokens) {
      if (/^[;&|()]$/.test(token)) commandPosition = true;
      else if (commandPosition && token === "!") fail();
      else if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) commandPosition = false;
    }
    const line = source.slice(0, offset).trim().replace(/[ \t]+/g, " ");
    if (!mentionsPnpm(line)) continue; // Only a trailing comment mentioned pnpm.
    if (installGrammar.test(line)) installs++;
    else if (!otherPnpmShapes.some((shape) => shape.test(line))) fail();
  }
  return installs;
}

function validateDocument(markdown: string): number {
  let fence: { marker: string; info: string; lines: string[] } | undefined;
  let installs = 0;
  for (const line of markdown.split(/\r?\n/)) {
    const boundary = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) {
      if (boundary) fence = { marker: boundary[1], info: boundary[2].trim(), lines: [] };
    } else if (boundary && boundary[1][0] === fence.marker[0]
      && boundary[1].length >= fence.marker.length && !boundary[2].trim()) {
      installs += validateBlock(fence.info, fence.lines.join("\n"));
      fence = undefined;
    } else fence.lines.push(line);
  }
  if (fence && mentionsPnpm(fence.lines.join("\n"))) {
    throw new Error(`Unclosed pnpm fence: ${fence.info}`);
  }
  return installs;
}

it("requires the copy-import grammar for every fenced pnpm occurrence", async () => {
  expect(validateDocument(await readFile("deploy/README.md", "utf8"))).toBeGreaterThan(0);
});

it.each(["bash", "sh", 'bash title="Install"', "shell"])("accepts canonical installs in %s fences", (info) => {
  expect(validateDocument(`\`\`\`${info}\nCI=true ${canonicalInstall} # install packages\n\`\`\``)).toBe(1);
});

it("joins continuations before validating the canonical install", () => {
  const continued = canonicalInstall.replace("pnpm install", "pnpm \\\ninstall");
  expect(validateDocument(`\`\`\`bash\n${continued}\n\`\`\``)).toBe(1);
});

it.each([
  "pnpm install --frozen-lockfile",
  canonicalInstall.replace("=copy", "=hardlink"),
  "pnpm  install --frozen-lockfile",
  "pnpm \\\n install --frozen-lockfile",
  "pn\\\npm install --frozen-lockfile",
  `! ${canonicalInstall}`,
  `:; ! ${canonicalInstall}`,
  `:; \\\n ! ${canonicalInstall}`,
  'pnpm() { command pnpm --package-import-method=hardlink "$@"; }',
  "pnpm --package-import-method=hardlink install --frozen-lockfile",
  `${canonicalInstall} > /tmp/unsafe-install-log`,
  "npm_config_package_import_method='copy' pnpm install --frozen-lockfile",
])("rejects unsupported pnpm syntax: %s", (line) => {
  expect(() => validateDocument(`\`\`\`bash\n${line}\n\`\`\``)).toThrow("Unsupported pnpm shape");
});

it.each(["text", "python", ""])("rejects pnpm in an unrecognized %s fence", (info) => {
  expect(() => validateDocument(`\`\`\`${info}\n${canonicalInstall}\n\`\`\``)).toThrow("Unrecognized pnpm fence");
});

it("accepts pnpm version checks alongside Unix install without inventing a dependency install", () => {
  expect(validateDocument("```sh\npnpm --version\ninstall -d /tmp/example\n```\n")).toBe(0);
});

it("only parses unrelated commands and their redirections", () => {
  expect(validateDocument(`~~~bash title="Install"\nprintf touched > /must-not-be-written\n${canonicalInstall}\n~~~`)).toBe(1);
});

it("rejects an unclosed pnpm fence", () => {
  expect(() => validateDocument(`\`\`\`bash\n${canonicalInstall}`)).toThrow("Unclosed pnpm fence");
});
