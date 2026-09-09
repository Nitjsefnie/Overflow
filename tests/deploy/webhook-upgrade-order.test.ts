import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("ordinary deployment webhook upgrade", () => {
  it.each([
    { readinessStatus: 0, upgradeStatus: 0 },
    { readinessStatus: 0, upgradeStatus: 1 },
    { readinessStatus: 0, upgradeStatus: 7 },
    { readinessStatus: 23, upgradeStatus: 0 },
  ])("gates upgrades on readiness $readinessStatus and retains upgrade status $upgradeStatus", async ({ readinessStatus, upgradeStatus }) => {
    const markdown = await readFile("deploy/README.md", "utf8");
    const section = markdown.split("## 10. Deploying a new revision")[1]!;
    const block = /```bash\n([\s\S]*?)\n```/.exec(section)![1]!;
    const fixture = await mkdtemp(join(tmpdir(), "overflow-upgrade-order-"));
    try {
      await mkdir(join(fixture, ".next-current/cache"), { recursive: true });
      await writeFile(join(fixture, "overflow.env"), "");
      const script = block.replaceAll("/srv/overflow", fixture)
        .replaceAll("/etc/overflow/overflow.env", join(fixture, "overflow.env"))
        .replaceAll("/var/log/overflow", join(fixture, "logs"))
        .replaceAll("/run/overflow-deploy.lock", join(fixture, "deploy.lock"));
      const result = spawnSync("bash", ["-c", `
        git() { if [ "$1" = rev-parse ]; then printf 'abc1234\\n'; fi; }
        pnpm() {
          if [ "$1" = --silent ]; then shift; fi
          case "$1" in
            release:switch) printf 'SWITCH\\n';;
            build) printf 'BUILD\\n';;
            webhooks:upgrade)
              printf 'INVOKED\\n' >> upgrade-invocations
              [ "$ready" = yes ] || return 88
              printf '{"upgradeFixture":true}\\n'
              return ${upgradeStatus};;
          esac
        }
        node() { :; }
        chown() { :; }
        chmod() { :; }
        find() { :; }
        readlink() { printf '%s/.next-current\\n' "$PWD"; }
        systemctl() { if [ "$1" = restart ]; then printf 'RESTART\\n'; fi; }
        curl() {
          if [ ${readinessStatus} -ne 0 ]; then return ${readinessStatus}; fi
          ready=yes; printf 'READY\\n'
        }
        ${script}
      `], { cwd: fixture, encoding: "utf8", timeout: 10_000 });
      expect(result.error).toBeUndefined();
      if (readinessStatus !== 0) {
        await expect(readFile(join(fixture, "upgrade-invocations"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        expect(result.status, result.stderr).toBe(readinessStatus);
        expect(result.stdout).not.toContain("Webhook upgrade log:");
        return;
      }
      expect(result.status, result.stderr).toBe(upgradeStatus);
      const output = result.stdout;
      expect(output.indexOf("BUILD")).toBeLessThan(output.indexOf("SWITCH"));
      expect(output.indexOf("SWITCH")).toBeLessThan(output.indexOf("RESTART"));
      expect(output.indexOf("RESTART")).toBeLessThan(output.indexOf("READY"));
      expect(output.indexOf("READY")).toBeLessThan(output.indexOf('{"upgradeFixture":true}'));
      expect(output).toContain(`Webhook upgrade exit status: ${upgradeStatus}`);
      const log = /Webhook upgrade log: (.+)/.exec(output)?.[1];
      expect(log).toBeDefined();
      expect(await readFile(log!, "utf8")).toContain('{"upgradeFixture":true}');
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
