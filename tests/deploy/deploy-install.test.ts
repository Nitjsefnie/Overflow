import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("passes copy import to every install in the documented deployment blocks", async () => {
  const markdown = await readFile("deploy/README.md", "utf8");
  const blocks = [...markdown.matchAll(/```bash\n([\s\S]*?)\n```/g)]
    .map(([, block]) => block)
    .filter((block) => block.includes("--frozen-lockfile")
      || (/\bpnpm\b/.test(block) && /(?:^|\s)install(?:\s|$)/m.test(block.replaceAll("\\\n", ""))));
  expect(blocks.length).toBeGreaterThan(0);
  const fixture = await mkdtemp(join(tmpdir(), "overflow-deploy-install-"));
  try {
    const bin = join(fixture, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "pnpm"), `#!${process.execPath}
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.INSTALL_LOG, JSON.stringify({
  args: process.argv.slice(2),
  importMethod: process.env.npm_config_package_import_method,
}) + "\\n");
`, { mode: 0o755 });
    for (const [index, block] of blocks.entries()) {
      // A negated install can hide failure even with set -e. Reject that shell
      // syntax explicitly instead of accepting a later command's exit status.
      expect(block.replaceAll("\\\n", ""), "pnpm commands must not be negated")
        .not.toMatch(/^\s*!\s.*\bpnpm\b/m);
      const tree = join(fixture, `tree-${index}`);
      await mkdir(join(tree, ".next-current/cache"), { recursive: true });
      await mkdir(join(tree, "logs"));
      await writeFile(join(tree, "overflow.env"), "");
      const log = join(tree, "pnpm.jsonl");
      await writeFile(log, "");
      const script = block.replaceAll("/srv/overflow", tree)
        .replaceAll("/etc/overflow/overflow.env", join(tree, "overflow.env"))
        .replaceAll("/var/log/overflow", join(tree, "logs"));
      // Keep the documented shell context, including any pnpm wrapper. Only
      // the external pnpm is recorded; PATH contains no real package manager.
      const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-ec", `
        git() { if [ "$1" = rev-parse ]; then printf 'abc1234\\n'; fi; }
        date() { printf '20260908T000000Z\\n'; }
        readlink() { printf '%s/.next-current\\n' "$PWD"; }
        node() { :; }
        chown() { :; }
        chmod() { :; }
        find() { :; }
        systemctl() { :; }
        curl() { :; }
        mkdir() { :; }
        install() { :; }
        rm() { :; }
        cat() { :; }
        ${script}
      `], {
        cwd: tree,
        env: {
          NODE_ENV: "test",
          PATH: bin,
          BASH_ENV: "",
          INSTALL_LOG: log,
          npm_config_package_import_method: "",
        },
        encoding: "utf8",
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const invocations: { args: string[]; importMethod: string }[] = (await readFile(log, "utf8"))
        .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const installs = invocations.filter(({ args }) => args.includes("install"));
      expect(installs.length, block).toBeGreaterThan(0);
      for (const invocation of installs) {
        expect(invocation, block).toEqual({
          args: ["install", "--frozen-lockfile"],
          importMethod: "copy",
        });
      }
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
