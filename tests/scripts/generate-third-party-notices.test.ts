import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildNotices,
  readLicenceFile,
  type NoticeEntry,
} from "../../scripts/generate-third-party-notices.ts";

const script = fileURLToPath(new URL("../../scripts/generate-third-party-notices.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "third-party-notices-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function entry(name: string, version: string, license: string, file?: string, text?: string): NoticeEntry {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  if (file && text) writeFileSync(join(directory, file), text);
  return { name, version, license, homepage: `https://example.test/${name}`, directory };
}

describe("buildNotices", () => {
  it("includes every package, version, homepage, licence id and complete licence text", () => {
    const mit = "MIT first line\nMIT second line\n";
    const apache = "Apache first line\nApache second line\n";
    const entries = [
      entry("alpha", "1.2.3", "MIT", "license.MD", mit),
      entry("beta", "4.5.6", "Apache-2.0", "LICENCE.markdown", apache),
    ];

    const result = buildNotices(entries, readLicenceFile);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("pnpm licenses list --prod --json");
    expect(result.text).toContain("alpha@1.2.3");
    expect(result.text).toContain("beta@4.5.6");
    expect(result.text).toContain("MIT");
    expect(result.text).toContain("Apache-2.0");
    expect(result.text).toContain("https://example.test/alpha");
    expect(result.text).toContain("https://example.test/beta");
    expect(result.text).toContain(mit);
    expect(result.text).toContain(apache);
  });

  it("shares one licence block for byte-identical texts without losing either package", () => {
    const shared = "same full licence\nsecond line\n";
    const entries = [
      entry("alpha", "1.0.0", "MIT", "LICENSE", shared),
      entry("beta", "2.0.0", "MIT", "NOTICE", shared),
    ];

    const result = buildNotices(entries, readLicenceFile);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("alpha@1.0.0");
    expect(result.text).toContain("beta@2.0.0");
    expect(result.text.split(shared)).toHaveLength(2);
  });

  it("reads a prefixed licence file such as LICENSE-MIT.txt", () => {
    const result = buildNotices(
      [entry("prefixed", "3.0.0", "MIT", "LICENSE-MIT.txt", "prefixed full text\n")],
      readLicenceFile,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("prefixed full text\n");
    expect(result.text).not.toContain("none shipped");
  });

  it("uses the canonical text and labels a declared licence with no shipped file", () => {
    const result = buildNotices([entry("fallback", "3.0.0", "MIT")], readLicenceFile);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("fallback@3.0.0");
    expect(result.text).toContain("Licence file: none shipped — canonical text of declared licence (MIT)");
    expect(result.text).toContain("Permission is hereby granted, free of charge");
  });

  it.each([
    ["unmapped licence with no file", "Custom-1.0", undefined, undefined],
    ["unknown licence", "Unknown", "LICENSE", "a file does not resolve an unknown id\n"],
  ])("rejects a planted dependency with %s", (_case, license, file, text) => {
    const entries = [
      entry("valid", "1.0.0", "MIT", "LICENSE", "valid licence\n"),
      entry("planted", "9.9.9", license, file, text),
    ];

    expect(buildNotices(entries, readLicenceFile)).toEqual({
      ok: false,
      missing: ["planted@9.9.9"],
    });
  });
});

describe("generator CLI", () => {
  it("exits nonzero, names every unresolved package and writes no file", () => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const packages = [
      entry("planted-one", "1.0.0", "Custom-1.0"),
      entry("planted-two", "2.0.0", "Unknown"),
    ];
    const output = {
      "Custom-1.0": [{ name: packages[0]!.name, versions: [packages[0]!.version], paths: [packages[0]!.directory], license: "Custom-1.0" }],
      Unknown: [{ name: packages[1]!.name, versions: [packages[1]!.version], paths: [packages[1]!.directory], license: "Unknown" }],
    };
    const shim = join(bin, "pnpm");
    writeFileSync(shim, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(output))});\n`);
    chmodSync(shim, 0o755);

    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("planted-one@1.0.0");
    expect(result.stderr).toContain("planted-two@2.0.0");
    expect(existsSync(join(root, "public/third-party-notices.txt"))).toBe(false);
  });

  it("generates notices from the real production dependency tree", () => {
    const result = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    const notices = readFileSync(join(repoRoot, "public/third-party-notices.txt"), "utf8");
    expect(notices).toContain("react@");
    expect(notices).toContain("postgres@");
  });
});
