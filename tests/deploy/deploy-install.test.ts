import { readFile } from "node:fs/promises";
import MarkdownIt from "markdown-it";
import { expect, it } from "vitest";

const canonicalInstall = "npm_config_package_import_method=copy pnpm install --frozen-lockfile";
const otherPnpmShapes = [
  /^pnpm (?:--version|db:migrate|build|test|lint|typecheck)$/,
  /^NEXT_DIST_DIR="\$release" pnpm build$/,
  /^pnpm release:switch \/srv\/overflow "\$(?:release|previous_release)" --expect-current (?:absent|"\$expected_serving")$/,
  /^pnpm release:prune \/srv\/overflow --keep [1-9][0-9]*$/,
];

// This is a closed vocabulary, not a shell interpreter. Every logical shell
// line must match a reviewed shape, including lines with no literal pnpm.
// Keep substitutions, redirections and control flow literal here: allowing an
// arbitrary argument could conceal a new command substitution or shell body.
const otherShellLines = new Set([
  "cp -a /etc/systemd/system/overflow.service /root/overflow.service.pre-hardening",
  "groupadd --system overflow",
  "useradd --system --gid overflow --home-dir /srv/overflow   --shell /usr/sbin/nologin --no-create-home overflow",
  "cd /tmp",
  "curl -fsSLO https://nodejs.org/dist/v24.17.0/node-v24.17.0-linux-x64.tar.xz",
  "curl -fsSLO https://nodejs.org/dist/v24.17.0/SHASUMS256.txt",
  "grep node-v24.17.0-linux-x64.tar.xz SHASUMS256.txt | sha256sum --check",
  "mkdir -p /usr/local/lib/nodejs",
  "tar -xJf node-v24.17.0-linux-x64.tar.xz -C /usr/local/lib/nodejs",
  "mv /usr/local/lib/nodejs/node-v24.17.0-linux-x64 /usr/local/lib/nodejs/node-v24.17.0",
  "ln -sfn /usr/local/lib/nodejs/node-v24.17.0/bin/node /usr/local/bin/node",
  "/usr/local/bin/node --version",
  "ln -sfn /usr/local/lib/nodejs/node-v24.17.0/bin/corepack /usr/local/sbin/corepack",
  "corepack enable --install-directory /usr/local/sbin",
  "corepack prepare pnpm@10.33.0 --activate",
  "install -d -o root -g root -m 0700 /etc/overflow",
  "[ -e /etc/overflow/overflow.env ]   || install -o root -g root -m 0600 /dev/null /etc/overflow/overflow.env",
  "chown root:root /etc/overflow/overflow.env",
  "chmod 0600 /etc/overflow/overflow.env",
  "set -e",
  "git clone https://github.com/Nitjsefnie/Overflow.git /srv/overflow",
  "cd /srv/overflow",
  "set -a; . /etc/overflow/overflow.env; set +a",
  "release=\".next-release-$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=7 HEAD)\"",
  "mkdir \"$release\"",
  "node scripts/release.ts prepare /srv/overflow \"$release\"",
  "chown -R root:overflow /srv/overflow",
  "chmod -R u=rwX,g=rX,o= /srv/overflow",
  "mkdir -p \"$release/cache\"",
  "chown -R overflow:overflow \"$release/cache\"",
  "chmod -R u=rwX,g=rX,o= \"$release/cache\"",
  "test -d /srv/overflow/.next",
  "test ! -L /srv/overflow/.next",
  "node scripts/release.ts check /srv/overflow \"${release:?}\"",
  "rm -rf -- /srv/overflow/.next",
  "systemctl restart overflow.service",
  "systemctl show overflow.service -p MainPID --value > /run/overflow-preswitch-mainpid",
  "install -o root -g root -m 0644   /srv/overflow/deploy/overflow.service /etc/systemd/system/overflow.service",
  "systemd-analyze verify /etc/systemd/system/overflow.service",
  "systemctl daemon-reload",
  "systemctl enable overflow.service",
  "systemctl is-active overflow.service",
  "curl --connect-timeout 5 --max-time 30 --retry 30 --retry-delay 1   --retry-connrefused -fsS -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3000/",
  "printf 'MainPID before the switch: %s\\nMainPID now:               %s\\n'   \"$(cat /run/overflow-preswitch-mainpid)\"   \"$(systemctl show overflow.service -p MainPID --value)\"",
  "systemctl show overflow.service   -p MainPID -p User -p Group -p NoNewPrivileges -p ProtectSystem",
  "ps -o user=,pid=,args= -p \"$(systemctl show overflow.service -p MainPID --value)\"",
  "journalctl -u overflow.service -n 100 --no-pager",
  "missing=0",
  "for path in /root/overflow.service.pre-hardening /root/overflow             /root/.nvm/versions/node/v24.17.0/bin/pnpm; do",
  "if [ -e \"$path\" ]; then",
  "echo \"present: $path\"",
  "else",
  "echo \"MISSING: $path\" >&2",
  "missing=1",
  "fi",
  "done",
  "[ \"$missing\" = 0 ]   || echo \"No rollback is available. Fix the hardened unit forward instead.\" >&2",
  "systemctl stop overflow.service",
  "cp -a /root/overflow.service.pre-hardening /etc/systemd/system/overflow.service",
  "systemctl start overflow.service",
  "printf 'MainPID before the rollback: %s\\nMainPID now:                 %s\\n'   \"$(cat /run/overflow-preswitch-mainpid)\"   \"$(systemctl show overflow.service -p MainPID --value)\"",
  "systemctl status overflow.service --no-pager",
  "previous_release='.next-release-REPLACE-WITH-RECORDED-ID'",
  "test -f \"$previous_release/BUILD_ID\"",
  "test -d \"$previous_release/cache\"",
  "chown -R overflow:overflow \"$previous_release/cache\"",
  "chmod -R u=rwX,g=rX,o= \"$previous_release/cache\"",
  "git pull --ff-only origin main",
  "exec 9>/run/overflow-deploy.lock",
  "flock -w 900 9 || { echo \"Could not acquire the deploy lock on /run/overflow-deploy.lock; refusing to deploy. Consult the deploy procedure's serialization notes before re-running.\" >&2; exit 1; }",
  "expected_serving=$(readlink -f /srv/overflow/.next || printf absent)",
  "previous_release=$(readlink -f /srv/overflow/.next)",
  "serving_cache=\"$previous_release/cache\"",
  "test -d \"$serving_cache\"",
  "find /srv/overflow -path \"$serving_cache\" -prune -o   -exec chown -h root:overflow {} +",
  "find /srv/overflow -path \"$serving_cache\" -prune -o   ! -type l -exec chmod u=rwX,g=rX,o= {} +",
  "printf 'Previous build: %s\\nNew build: %s\\n' \"$previous_release\" \"$release\"",
  "install -d -m 0700 /var/log/overflow",
  "upgrade_log=\"/var/log/overflow/webhook-upgrade-$release.jsonl\"",
  "upgrade_status=0",
  'pnpm --silent webhooks:upgrade > "$upgrade_log" 2>&1 || upgrade_status=$?',
  "cat \"$upgrade_log\"",
  "printf 'Webhook upgrade log: %s\\nWebhook upgrade exit status: %s\\n' \"$upgrade_log\" \"$upgrade_status\"",
  "test \"$upgrade_status\" -eq 0 || exit \"$upgrade_status\"",
  "rm -rf -- node_modules",
  "set -o pipefail",
  "LC_ALL=C find /srv/overflow -regextype posix-extended -mindepth 1 -maxdepth 1   -type d -regex '.*/\\.next-release-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}'   -printf '%f\\n' | LC_ALL=C sort -r",
].map((line) => tokenizeLines(line)[0].join(" ")));

function mentionsPnpm(text: string) {
  return text.replace(/\\\r?\n/g, "").replace(/["'\\]/g, "").includes("pnpm");
}

function tokenizeLines(source: string): string[][] {
  const lines: string[][] = [[]];
  const lexer = /[ \t]+|(?:[^\s;&|()"'\\]+|"(?:[^"\\\r\n]|\\(?:\r?\n|[^\r\n]))*"|'[^'\r\n]*'|\\(?:\r?\n|[^\r\n]))+|&&|\|\||[;&|()]/y;
  let offset = 0;
  while (offset < source.length) {
    // Comments are recognized at word boundaries, before processing any
    // backslash in them. Their newline always ends the logical command.
    if (source[offset] === "#") {
      const newline = source.indexOf("\n", offset);
      offset = newline < 0 ? source.length : newline;
      continue;
    }
    const newline = /^\r?\n/.exec(source.slice(offset));
    if (newline) {
      lines.push([]);
      offset += newline[0].length;
      continue;
    }
    // A continuation before a word must not turn the next line's comment
    // into a word. Continuations within a word are consumed by the lexer.
    const continuation = /^\\\r?\n/.exec(source.slice(offset));
    if (continuation) {
      offset += continuation[0].length;
      continue;
    }
    lexer.lastIndex = offset;
    const match = lexer.exec(source);
    if (!match) throw new Error(`Unsupported shell token: ${source.slice(offset)}`);
    offset = lexer.lastIndex;
    if (!/^[ \t]+$/.test(match[0])) lines[lines.length - 1].push(match[0].replace(/\\\r?\n/g, ""));
  }
  return lines;
}

function validateBlock(info: string, body: string): number {
  if (!/^(?:bash|sh|shell)(?:\s|$)/.test(info)) {
    throw new Error(`Unsupported code fence: ${info || "(no language)"}`);
  }
  let installs = 0;
  for (const tokens of tokenizeLines(body)) {
    if (!tokens.length) continue;
    const line = tokens.join(" ");
    const source = line;
    if (line.includes("<<")) throw new Error(`Unsupported shell syntax: Heredoc introducer: ${source}`);
    if (line.includes("`")) throw new Error(`Unsupported shell syntax: Backtick substitution: ${source}`);
    let commandPosition = true;
    for (const token of tokens) {
      if (/^(?:[;&|()]|&&|\|\|)$/.test(token)) commandPosition = true;
      else if (commandPosition && token === "!") {
        throw new Error(`Unsupported pnpm shape (command negation): ${source}`);
      } else if (commandPosition && /^["'$\\]/.test(token)) {
        throw new Error(`Unsupported shell syntax: Non-literal command word: ${token} in ${source}`);
      } else if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) commandPosition = false;
    }
    if (line === canonicalInstall) installs++;
    else if (!otherShellLines.has(line) && !otherPnpmShapes.some((shape) => shape.test(line))
      && !/^install -d \/[A-Za-z0-9_./-]+$/.test(line)) {
      throw new Error(`Unsupported ${mentionsPnpm(line) ? "pnpm" : "shell"} shape in ${info}: ${source}`);
    }
  }
  return installs;
}

// A real CommonMark tokenizer discovers code regions, so indented code, fenced
// code and code nested in lists or blockquotes are recognized exactly as a
// CommonMark renderer sees them, and installs can no longer hide behind
// structures the hand-rolled line parser did not model (issue 252). Everything
// else — paragraphs, headings, lists, blockquotes, inline code, raw HTML — is
// prose and never reaches the shell grammar.
const md = new MarkdownIt("commonmark");

function codeRegions(markdown: string): { info: string; lines: string[] }[] {
  const regions: { info: string; lines: string[] }[] = [];
  for (const token of md.parse(markdown, {})) {
    if (token.type === "fence" || token.type === "code_block") {
      // validateBlock's shell test only reads the info prefix, so a shell
      // name followed by arbitrary info would smuggle the install command
      // past the grammar. The old parser rejected that at the boundary and
      // the structural front end keeps the rejection.
      if (token.type === "fence" && mentionsPnpm(token.info)) {
        throw new Error(`Unsupported fence info: ${token.info.trim()}`);
      }
      const [start, end] = token.map ?? [0, 0];
      const content = token.content.replace(/\n$/, "");
      const contentLines = content === "" ? 0 : content.split("\n").length;
      // markdown-it ends an unclosed fence silently at the end of its
      // container or document. A closed fence's source range is exactly the
      // opening line, every content line and the closing line, so the range
      // spans contentLines + 2 lines; an unclosed fence has no closing line
      // and spans contentLines + 1. The counts never coincide, and empty
      // content is zero lines, not one empty line.
      if (token.type === "fence" && contentLines !== end - start - 2) {
        throw new Error(`Unsupported unclosed code fence: ${token.info.trim()}`);
      }
      regions.push({
        info: token.type === "fence" ? token.info.trim() : "shell (indented code)",
        lines: content === "" ? [] : content.split("\n"),
      });
    } else if (token.type === "html_block") {
      // An HTML comment that never closes within its HTML block runs until
      // the end of the container and can swallow a following code fence
      // without the tokenizer noticing (issue 252, payload three).
      if (token.content.includes("<!--") && !token.content.includes("-->")) {
        throw new Error("Unsupported unclosed HTML comment");
      }
      // CommonMark: an HTML block swallows everything up to its terminator,
      // so a code fence inside one never becomes a fence token and the closed
      // grammar never sees it (issue 400). A fence-looking line in any HTML
      // block — comments included — is structure, not prose, and is rejected
      // by name instead of being silently skipped.
      if (/`{3,}|~{3,}/.test(token.content)) {
        throw new Error(`Unsupported code fence inside an HTML block: ${token.content.split("\n")[0].trim()}`);
      }
      // A closed HTML comment may mention pnpm as prose, so only non-comment
      // blocks are held to the mention rule; the first line tells them apart.
      const firstLine = token.content.split("\n")[0].trimStart();
      if (!firstLine.startsWith("<!--") && mentionsPnpm(token.content)) {
        throw new Error(`Unsupported pnpm mention inside an HTML block: ${token.content.split("\n")[0].trim()}`);
      }
    }
  }
  return regions;
}

function validateDocument(markdown: string): number {
  return codeRegions(markdown).reduce((installs, region) => installs + validateBlock(region.info, region.lines.join("\n")), 0);
}

function validateDeploymentGuide(markdown: string): void {
  // Initial install, routine deploy, and the one-time dependency migration.
  const expectedInstalls = 3;
  const installs = validateDocument(markdown);
  if (installs !== expectedInstalls) {
    throw new Error(`Unsupported deployment install count: expected ${expectedInstalls} canonical copy-prefixed installs in code regions, found ${installs}`);
  }
}

it("requires the closed shell grammar and copy imports throughout the deployment guide", async () => {
  validateDeploymentGuide(await readFile("deploy/README.md", "utf8"));
});

it("requires the deploy serialization lines in their blocks, in order", async () => {
  const markdown = await readFile("deploy/README.md", "utf8");
  const blocks = codeRegions(markdown)
    .filter((region) => /^(?:bash|sh|shell)(?:\s|$)/.test(region.info))
    .map((region) => tokenizeLines(region.lines.join("\n"))
      .filter((tokens) => tokens.length)
      .map((tokens) => tokens.join(" ")));
  const exec = tokenizeLines("exec 9>/run/overflow-deploy.lock")[0].join(" ");
  const flock = tokenizeLines(
    'flock -w 900 9 || { echo "Could not acquire the deploy lock on /run/overflow-deploy.lock; refusing to deploy. '
    + "Consult the deploy procedure's serialization notes before re-running.\" >&2; exit 1; }",
  )[0].join(" ");
  const anchor = tokenizeLines("expected_serving=$(readlink -f /srv/overflow/.next || printf absent)")[0].join(" ");
  const deploy = blocks.find((lines) => lines.includes("git pull --ff-only origin main"));
  const rollback = blocks.find((lines) => lines.includes("previous_release='.next-release-REPLACE-WITH-RECORDED-ID'"));
  const prune = blocks.find((lines) => lines.some((line) => line.startsWith("pnpm release:prune")));
  expect(deploy, "section 10 deploy block").toBeDefined();
  expect(rollback, "section 9 rollback block").toBeDefined();
  expect(prune, "prune fence").toBeDefined();
  for (const [name, block, switchLine] of [
    ["deploy", deploy!, 'pnpm release:switch /srv/overflow "$release" --expect-current "$expected_serving"'],
    ["rollback", rollback!, 'pnpm release:switch /srv/overflow "$previous_release" --expect-current "$expected_serving"'],
  ] as const) {
    const [execAt, flockAt, anchorAt, switchAt] = [exec, flock, anchor, switchLine].map((line) => block.indexOf(line));
    expect(execAt, `${name} block must hold fd 9 open on the deploy lock`).toBeGreaterThanOrEqual(0);
    expect(flockAt, `${name} block must acquire the lock after opening fd 9`).toBeGreaterThan(execAt);
    expect(anchorAt, `${name} block must record expected_serving under the lock`).toBeGreaterThan(flockAt);
    expect(switchAt, `${name} block must switch only after the anchor exists`).toBeGreaterThan(anchorAt);
  }
  expect(prune!, "prune fence must re-lock fd 9 before pruning").toContain(flock);
  expect(prune!, "prune fence must not re-open fd 9, which releases the held lock").not.toContain(exec);
  const lines = blocks.flat();
  expect(lines.filter((line) => line === exec), "exactly the deploy and rollback blocks open fd 9").toHaveLength(2);
  expect(lines.filter((line) => line === flock), "deploy, rollback and prune fences lock fd 9").toHaveLength(3);
  expect(lines.filter((line) => line === anchor), "exactly the deploy and rollback blocks anchor expected_serving").toHaveLength(2);
});

it.each(["initial install", "routine deploy", "one-time migration"].flatMap((name, index) =>
  [false, true].map((removePrefix) => ({ name, index, removePrefix }))))(
  "rejects an unfenced $name (remove copy prefix: $removePrefix)", ({ index, removePrefix }) => {
    const blocks = [0, 1, 2].map((blockIndex) => {
      if (blockIndex !== index) return `\`\`\`bash\n${canonicalInstall}\n\`\`\``;
      return removePrefix ? "pnpm install --frozen-lockfile" : canonicalInstall;
    });
    expect(() => validateDeploymentGuide(blocks.join("\n\n")))
      .toThrow("Unsupported deployment install count: expected 3 canonical copy-prefixed installs in code regions, found 2");
  },
);

it.each([0, 4])("rejects a deployment guide with %i canonical installs", (count) => {
  const markdown = Array.from({ length: count }, () => `\`\`\`bash\n${canonicalInstall}\n\`\`\``).join("\n\n");
  expect(() => validateDeploymentGuide(markdown))
    .toThrow(`Unsupported deployment install count: expected 3 canonical copy-prefixed installs in code regions, found ${count}`);
});

it.each([
  ["<!-- comment -->\n    pnpm install --frozen-lockfile", "Unsupported pnpm shape"],
  ["[ref]: /url\n    pnpm install --frozen-lockfile", "Unsupported pnpm shape"],
  ["<!-- comment -->\n    $'p\\x6epm' install --frozen-lockfile", "Non-literal command word"],
])("validates indented code after a Markdown paragraph boundary: %s", (markdown, error) => {
  expect(() => validateDocument(markdown)).toThrow(error);
});

it.each(["<!-- comment -->", "[ref]: /url"])("accepts canonical indented code after %s", (boundary) => {
  expect(validateDocument(`${boundary}\n    ${canonicalInstall}`)).toBe(1);
});

it("ends a multiline HTML comment before recognizing indented code", () => {
  const comment = "<!--\nThe pnpm command below is only comment text.\n    pnpm install --frozen-lockfile\n-->";
  expect(validateDocument(`${comment}\n    ${canonicalInstall}`)).toBe(1);
  expect(() => validateDocument(`${comment}\n    pnpm install --frozen-lockfile`)).toThrow("Unsupported pnpm shape");
});

it("keeps inline comments and reference-like paragraph text in prose", () => {
  expect(validateDocument("The pnpm commands <!-- inline comment -->\n    copy package files into private inodes.")).toBe(0);
  expect(validateDocument("The pnpm commands\n[ref]: /url\n    copy package files into private inodes.")).toBe(0);
});

it.each([
  ["<!-- unclosed comment", "Unsupported unclosed HTML comment"],
  // CommonMark: the blockquote's unclosed HTML block swallows the fence line,
  // so the comment rule names it instead of a container error.
  ["> <!--\n```bash\npnpm install --frozen-lockfile\n```", "Unsupported unclosed HTML comment"],
  // CommonMark: markdown-it consumes `[ref]:\n/url` as a definition, so the
  // indented install is a genuine code region and the unprefixed shape is
  // rejected by the shell grammar.
  ["[ref]:\n/url\n    pnpm install --frozen-lockfile", "Unsupported pnpm shape"],
])("names unsupported Markdown boundary syntax: %s", (markdown, error) => {
  expect(() => validateDocument(markdown)).toThrow(error);
});

// Issue 252's payloads: an install hidden behind a Markdown structure the
// guard used to misparse. Each is appended, as its own block, to a document
// that would otherwise hold exactly the three canonical installs — and to the
// real README's text, which the guard reads without modifying it.
it.each([
  ["a processing-instruction boundary", "<?probe?>\n    pnpm install --frozen-lockfile\n", "Unsupported pnpm shape"],
  ["a multiline reference-definition title", '[ref]: /url\n  "title"\n    pnpm install --frozen-lockfile\n', "Unsupported pnpm shape"],
  ["an unclosed HTML comment opened in a list container", "- <!--\n```bash\npnpm install --frozen-lockfile\n```\n", "Unsupported unclosed HTML comment"],
])("rejects an install hidden behind $0", async (_name, payload, error) => {
  const synthetic = [0, 1, 2].map(() => `\`\`\`bash\n${canonicalInstall}\n\`\`\``).join("\n\n") + "\n";
  expect(() => validateDocument(synthetic + payload)).toThrow(error);
  const readme = await readFile("deploy/README.md", "utf8");
  expect(() => validateDocument(`${readme}\n${payload}`)).toThrow(error);
});

// Issue 400's payloads: CommonMark swallows everything up to an HTML block's
// terminator, so a code fence inside one never becomes a fence token and the
// closed grammar never sees it. Each payload is appended, as its own block, to
// a document that would otherwise hold exactly the three canonical installs —
// and to the real README's text, which the guard reads without modifying it.
it.each([
  ["a <div> HTML block swallowing a non-canonical fenced install", "<div>\n```text\npnpm install\n```\n</div>", "Unsupported code fence inside an HTML block"],
  ["a <script> HTML block swallowing a canonical fenced install", "<script>\n```bash\n" + canonicalInstall + "\n```\n</script>", "Unsupported code fence inside an HTML block"],
  ["an unclosed <script> swallowing a canonical fenced install", "<script>\n```bash\n" + canonicalInstall + "\n```\n", "Unsupported code fence inside an HTML block"],
  ["a <script> HTML block swallowing a ~~~-fenced install", "<script>\n~~~bash\n" + canonicalInstall + "\n~~~\n</script>", "Unsupported code fence inside an HTML block"],
  ["pnpm prose inside a <div> HTML block", "<div>\ndiscusses pnpm and its store\n</div>", "Unsupported pnpm mention inside an HTML block"],
])("rejects an install hidden behind $0", async (_name, payload, error) => {
  const synthetic = [0, 1, 2].map(() => `\`\`\`bash\n${canonicalInstall}\n\`\`\``).join("\n\n") + "\n";
  expect(() => validateDocument(synthetic + payload)).toThrow(error);
  const readme = await readFile("deploy/README.md", "utf8");
  expect(() => validateDocument(`${readme}\n${payload}`)).toThrow(error);
});

// The HTML-block checks must not disturb the closed-comment rule: a CLOSED
// comment may mention pnpm as prose, and the indented code after it is still
// judged by the grammar. Mirror of the pinned multiline-comment test.
it("keeps a closed HTML comment's pnpm prose and the code after it in prose", () => {
  const comment = "<!--\nThe pnpm command below is only comment text.\n    pnpm install --frozen-lockfile\n-->";
  expect(validateDocument(`${comment}\n    ${canonicalInstall}`)).toBe(1);
});

it.each(["bash", "sh", 'bash title="Install"', "shell"])("accepts canonical installs in %s fences", (info) => {
  expect(validateDocument(`\`\`\`${info}\n${canonicalInstall} # install packages\n\`\`\``)).toBe(1);
});

it("joins continuations before validating the canonical install", () => {
  const continued = canonicalInstall.replace("pnpm install", "pnpm \\\ninstall");
  expect(validateDocument(`\`\`\`bash\n${continued}\n\`\`\``)).toBe(1);
});

it("does not continue a command through a backslash inside a comment", () => {
  expect(() => validateDocument("```bash\npnpm --version # comment \\\npnpm install --frozen-lockfile\n```"))
    .toThrow("Unsupported pnpm shape");
});

it("rejects a constructed command in an indented code block", () => {
  expect(() => validateDocument("    $'p\\x6epm' install --frozen-lockfile"))
    .toThrow("Non-literal command word");
});

it("leaves ordinary prose mentioning pnpm alone", () => {
  expect(validateDocument("The documented pnpm commands copy package files into private inodes."))
    .toBe(0);
});

it.each([
  "pnpm --version # comment \\\n" + canonicalInstall,
  "# comment \\\n" + canonicalInstall,
  "pnpm --version \\\n# comment \\\n" + canonicalInstall,
])("preserves the next command after a comment: %s", (body) => {
  expect(validateDocument(`\`\`\`bash\n${body}\n\`\`\``)).toBe(1);
});

it.each(["    ", "\t", " \t", ">     ", "> >     "])("validates indented code with prefix %j", (prefix) => {
  expect(validateDocument(`${prefix}${canonicalInstall}`)).toBe(1);
  expect(() => validateDocument(`${prefix}pnpm install --frozen-lockfile`)).toThrow("Unsupported pnpm shape");
});

it("ends an indented code block before the next prose paragraph", () => {
  expect(validateDocument(`    ${canonicalInstall}\n\nThe pnpm install above uses copy.\n\n\`\`\`sh\n${canonicalInstall}\n\`\`\``)).toBe(2);
});

it.each([
  "Use `pnpm install --frozen-lockfile` with the documented prefix.",
  "pnpm install --frozen-lockfile",
  "The pnpm commands use ```bash fences and ~~~ fences.",
  "The documented pnpm commands\n    copy package files into private inodes.",
  "> The documented pnpm commands copy package files into private inodes.",
  "- The documented pnpm commands copy package files into private inodes.",
])("does not validate prose as code: %s", (prose) => {
  expect(validateDocument(prose)).toBe(0);
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
  expect(() => validateDocument(`\`\`\`${info}\n${canonicalInstall}\n\`\`\``)).toThrow("Unsupported code fence");
});

it("accepts pnpm version checks alongside Unix install without inventing a dependency install", () => {
  expect(validateDocument("```sh\npnpm --version\ninstall -d /tmp/example\n```\n")).toBe(0);
});

it("rejects unreviewed redirections without executing them", () => {
  expect(() => validateDocument(`~~~bash title="Install"\nprintf touched > /must-not-be-written\n${canonicalInstall}\n~~~`)).toThrow("Unsupported shell shape");
});

it("rejects an unclosed pnpm fence", () => {
  expect(() => validateDocument(`\`\`\`bash\n${canonicalInstall}`)).toThrow("Unsupported unclosed code fence");
});

it.each([
  [String.raw`$'p\x6epm' install --frozen-lockfile`, "Non-literal command word"],
  ['manager=pn; manager=${manager}pm; "$manager" install', "Non-literal command word"],
  ['"${manager}" install', "Non-literal command word"],
  ['`echo manager` install', "Backtick substitution"],
  [`: <<'INSTALL'\n${canonicalInstall}\nINSTALL`, "Heredoc introducer"],
  ["unrecognized-command anything", "Unsupported shell shape"],
])("rejects shell constructs even without literal pnpm: %s", (body, error) => {
  expect(() => validateDocument(`\`\`\`bash\n${body}\n\`\`\``)).toThrow(error);
});

it("discovers unsafe installs in blockquoted fences", () => {
  expect(() => validateDocument("> ```bash\n> pnpm install --frozen-lockfile\n> ```")).toThrow("Unsupported pnpm shape");
});

it("accepts canonical installs in nested blockquoted parameterized fences", () => {
  expect(validateDocument(`> > ~~~sh title="Install"\n> > ${canonicalInstall}\n> > ~~~`)).toBe(1);
});

it("rejects unsafe installs in code outside fences", () => {
  expect(() => validateDocument("    pnpm install --frozen-lockfile")).toThrow("Unsupported pnpm shape");
});

it("recognizes a new container after an indented code block ends", () => {
  expect(() => validateDocument("    pnpm --version\n>     $'p\\x6epm' install --frozen-lockfile"))
    .toThrow("Non-literal command word");
});

it.each(["***", "* * *", "___"])("recognizes indented code after a thematic break: %s", (boundary) => {
  expect(() => validateDocument(`Prose\n${boundary}\n    $'p\\x6epm' install --frozen-lockfile`))
    .toThrow("Non-literal command word");
});

it("uses list content indentation when distinguishing prose from code", () => {
  expect(validateDocument("- The documented pnpm commands\n\n    copy package files into private inodes."))
    .toBe(0);
  // CommonMark: the 6-space indented line is a real code region inside the
  // list item, so the closed grammar rejects the constructed command itself.
  expect(() => validateDocument("- The documented commands\n\n      $'p\\x6epm' install --frozen-lockfile"))
    .toThrow("Non-literal command word");
});

it("recognizes indented code on a list item's first line", () => {
  // CommonMark: a real indented code region, judged by the closed grammar.
  expect(() => validateDocument("-     $'p\\x6epm' install --frozen-lockfile"))
    .toThrow("Non-literal command word");
});

it("counts tabs at Markdown column stops inside containers", () => {
  expect(validateDocument(`>\t\t${canonicalInstall}`)).toBe(1);
  expect(validateDocument("> \tThe documented pnpm commands copy package files into private inodes.")).toBe(0);
});

it.each(["- ", "1. ", "> - ", "- > ", "> 1. > - "])("rejects a container-nested fence whose closer sits at column 0: %j", (prefix) => {
  // CommonMark: the col-0 closer never closes a container-nested fence, so
  // the fence is unclosed and the guard names that instead of a container.
  expect(() => validateDocument(`${prefix}\`\`\`sh\n$'p\\x6epm' install --frozen-lockfile\n\`\`\``))
    .toThrow("Unsupported unclosed code fence");
});

it.each(["text", "python", ""])("rejects constructed commands in unsupported %s fences", (info) => {
  expect(() => validateDocument(`\`\`\`${info}\n$'p\\x6epm' install --frozen-lockfile\n\`\`\``))
    .toThrow("Unsupported code fence");
});

it("rejects an unprefixed install in a list-nested fence", () => {
  // CommonMark: a properly closed list-nested fence is a real code region,
  // so the unprefixed install is rejected by the closed grammar itself.
  expect(() => validateDocument("- ```bash\n  pnpm install --frozen-lockfile\n  ```")).toThrow("Unsupported pnpm shape");
});

it("does not strip shell redirections as blockquote containers", () => {
  expect(() => validateDocument(`> \`\`\`bash\n> > ${canonicalInstall}\n> \`\`\``)).toThrow("Unsupported pnpm shape");
});

it("rejects a fence whose closing line leaves its blockquote container", () => {
  // CommonMark: fences have no lazy continuation, so the dropped `>` closes
  // the blockquote around an unclosed fence; the guard names the unclosed
  // fence instead of a container mismatch.
  expect(() => validateDocument(`> \`\`\`bash\n${canonicalInstall}\n> \`\`\``)).toThrow("Unsupported unclosed code fence");
});

it("rejects a shell-prefixed fence info carrying the install command", () => {
  // The info prefix satisfies validateBlock's shell test, so the pnpm-bearing
  // junk must be rejected in the structural front end, where the old parser
  // threw before the grammar ran.
  expect(() => validateDocument("```bash pnpm install --frozen-lockfile\n" + canonicalInstall + "\n```"))
    .toThrow("Unsupported fence info");
});

it("rejects a command substitution hidden in a familiar command's arguments", () => {
  expect(() => validateDocument('```bash\nmkdir "$(unrecognized-command)"\n```')).toThrow("Unsupported shell shape");
});

it("rejects a function override even when a later install is canonical", () => {
  expect(() => validateDocument(`\`\`\`bash\npnpm() { command pnpm --package-import-method=hardlink "$@"; }\n${canonicalInstall}\n\`\`\``)).toThrow("Unsupported pnpm shape");
});

it.each(["PATH=/tmp/wrapper-bin ", "CI=true ", "\v"])("rejects an unreviewed install prefix: %s", (prefix) => {
  expect(() => validateDocument(`\`\`\`bash\n${prefix}${canonicalInstall}\n\`\`\``)).toThrow(/Unsupported (?:pnpm shape|shell token)/);
});
