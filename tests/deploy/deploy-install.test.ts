import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const canonicalInstall = "npm_config_package_import_method=copy pnpm install --frozen-lockfile";
const otherPnpmShapes = [
  /^pnpm (?:--version|db:migrate|build|test|lint|typecheck)$/,
  /^NEXT_DIST_DIR="\$release" pnpm build$/,
  /^pnpm release:switch \/srv\/overflow "\$(?:release|previous_release)"$/,
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
].map((line) => tokenize(line).join(" ")));

function mentionsPnpm(text: string) {
  return text.replace(/\\\r?\n/g, "").replace(/["'\\]/g, "").includes("pnpm");
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  const lexer = /[ \t]+|(?:[^\s;&|()"'\\]+|"[^"\r\n]*"|'[^'\r\n]*'|\\[^\r\n])+|&&|\|\||[;&|()]/y;
  let offset = 0;
  while (offset < source.length) {
    if (source[offset] === "#") break;
    lexer.lastIndex = offset;
    const match = lexer.exec(source);
    if (!match) throw new Error(`Unsupported shell token: ${source.slice(offset)}`);
    offset = lexer.lastIndex;
    if (!/^[ \t]+$/.test(match[0])) tokens.push(match[0]);
  }
  return tokens;
}

function validateBlock(info: string, body: string): number {
  if (!/^(?:bash|sh|shell)(?:\s|$)/.test(info)) {
    if (mentionsPnpm(info + "\n" + body)) {
      throw new Error(`Unrecognized pnpm fence: ${info || "(no language)"}`);
    }
    return 0;
  }
  let installs = 0;
  for (const source of body.replace(/\\\r?\n/g, "").split(/\r?\n/)) {
    const tokens = tokenize(source);
    if (!tokens.length) continue;
    const line = tokens.join(" ");
    if (line.includes("<<")) throw new Error(`Heredoc introducer: ${source}`);
    if (line.includes("`")) throw new Error(`Backtick substitution: ${source}`);
    let commandPosition = true;
    for (const token of tokens) {
      if (/^(?:[;&|()]|&&|\|\|)$/.test(token)) commandPosition = true;
      else if (commandPosition && token === "!") {
        throw new Error(`Unsupported pnpm shape (command negation): ${source}`);
      } else if (commandPosition && /^["'$\\]/.test(token)) {
        throw new Error(`Non-literal command word: ${token} in ${source}`);
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

function validateDocument(markdown: string): number {
  let fence: { marker: string; info: string; depth: number; lines: string[] } | undefined;
  let installs = 0;
  for (const source of markdown.split(/\r?\n/)) {
    let line = source;
    let depth = 0;
    // Remove only the container depth established by the opening fence. A >
    // inside its body remains a shell redirect, never another stripped prefix.
    while (!fence || depth < fence.depth) {
      const quote = /^ {0,3}> ?/.exec(line);
      if (!quote) break;
      line = line.slice(quote[0].length);
      depth++;
    }
    if (fence && depth !== fence.depth) {
      throw new Error(`Unsupported fence container: ${source}`);
    }
    const boundary = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) {
      if (boundary) {
        if (mentionsPnpm(boundary[2])) throw new Error(`Unsupported fence info: ${source}`);
        fence = { marker: boundary[1], info: boundary[2].trim(), depth, lines: [] };
      } else if (/`{3,}|~{3,}/.test(line)) {
        throw new Error(`Unsupported fence container: ${source}`);
      } else if (mentionsPnpm(line)) {
        throw new Error(`Pnpm outside recognized fence: ${source}`);
      }
    } else if (boundary && boundary[1][0] === fence.marker[0]
      && boundary[1].length >= fence.marker.length && !boundary[2].trim()) {
      installs += validateBlock(fence.info, fence.lines.join("\n"));
      fence = undefined;
    } else fence.lines.push(line);
  }
  if (fence) throw new Error(`Unclosed pnpm fence: ${fence.info}`);
  return installs;
}

it("requires the closed shell grammar and copy imports throughout the deployment guide", async () => {
  expect(validateDocument(await readFile("deploy/README.md", "utf8"))).toBeGreaterThan(0);
});

it.each(["bash", "sh", 'bash title="Install"', "shell"])("accepts canonical installs in %s fences", (info) => {
  expect(validateDocument(`\`\`\`${info}\n${canonicalInstall} # install packages\n\`\`\``)).toBe(1);
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

it("rejects unreviewed redirections without executing them", () => {
  expect(() => validateDocument(`~~~bash title="Install"\nprintf touched > /must-not-be-written\n${canonicalInstall}\n~~~`)).toThrow("Unsupported shell shape");
});

it("rejects an unclosed pnpm fence", () => {
  expect(() => validateDocument(`\`\`\`bash\n${canonicalInstall}`)).toThrow("Unclosed pnpm fence");
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

it("rejects pnpm outside fences", () => {
  expect(() => validateDocument("pnpm install --frozen-lockfile")).toThrow("Pnpm outside recognized fence");
});

it("rejects unsupported fence containers", () => {
  expect(() => validateDocument("- ```bash\n  pnpm install --frozen-lockfile\n  ```")).toThrow("Unsupported fence container");
});

it("does not strip shell redirections as blockquote containers", () => {
  expect(() => validateDocument(`> \`\`\`bash\n> > ${canonicalInstall}\n> \`\`\``)).toThrow("Unsupported pnpm shape");
});

it("rejects a changed blockquote container", () => {
  expect(() => validateDocument(`> \`\`\`bash\n${canonicalInstall}\n> \`\`\``)).toThrow("Unsupported fence container");
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
