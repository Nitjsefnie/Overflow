import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("passes copy import to every documented frozen-lockfile install", async () => {
  const markdown = await readFile("deploy/README.md", "utf8");
  const installs = [...markdown.matchAll(/^.*\bpnpm install --frozen-lockfile.*$/gm)]
    .map(([line]) => line);
  expect(installs.length).toBeGreaterThan(0);
  const fixture = await mkdtemp(join(tmpdir(), "overflow-deploy-install-"));
  try {
    await writeFile(join(fixture, "pnpm"), `#!${process.execPath}
process.stdout.write(JSON.stringify({
  args: process.argv.slice(2),
  importMethod: process.env.npm_config_package_import_method,
}));
`, { mode: 0o755 });
    for (const line of installs) {
      const result = spawnSync("bash", ["-ec", line], {
        cwd: fixture,
        env: {
          ...process.env,
          PATH: `${fixture}:${process.env.PATH}`,
          npm_config_package_import_method: "",
        },
        encoding: "utf8",
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout), line).toEqual({
        args: ["install", "--frozen-lockfile"],
        importMethod: "copy",
      });
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
