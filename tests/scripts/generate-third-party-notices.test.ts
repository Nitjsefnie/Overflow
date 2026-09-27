import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildNotices,
  readLicenceFile,
  type NoticeEntry,
} from "../../scripts/generate-third-party-notices.ts";
import { THIRD_PARTY_LICENCE_TEXTS } from "../../scripts/third-party-licence-texts.ts";
import * as noticesGenerator from "../../scripts/generate-third-party-notices.ts";

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
      entry("beta", "2.0.0", "MIT", "LICENSE", shared),
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

  it("chooses bare, dotted, COPYING, NOTICE and COPYRIGHT files in order, then the shortest dotted name", () => {
    const directory = entry("ranked", "1.0.0", "MIT").directory;
    const names = ["LICENSE", "LICENSE.md", "LICENSE.longer.txt", "COPYING", "NOTICE", "COPYRIGHT"];
    const fullText = (name: string) => `Full text from ${name}\nSecond line from ${name}\n`;
    for (const name of names) writeFileSync(join(directory, name), fullText(name));

    for (const name of names) {
      expect(readLicenceFile(directory)).toBe(fullText(name));
      rmSync(join(directory, name));
    }
  });

  it("tries a lower-ranked readable file when the top-ranked file is unreadable", () => {
    const directory = entry("unreadable", "1.0.0", "MIT").directory;
    const unreadable = join(directory, "LICENSE");
    const readableText = "Full text from the readable candidate\nSecond line\n";
    writeFileSync(unreadable, "Unreadable top candidate\n");
    chmodSync(unreadable, 0o000);
    writeFileSync(join(directory, "LICENSE.md"), readableText);

    if (process.getuid?.() !== 0) {
      expect(readLicenceFile(directory)).toBe(readableText);
      return;
    }

    // Root can read mode-000 files. Run the real resolver as an unprivileged
    // child so the fixture has the same permission behavior as CI.
    chmodSync(root, 0o755);
    chmodSync(directory, 0o755);
    // /proc/self/exe reaches the running Node binary without traversing
    // /root, where this workspace's Node installation lives.
    const child = spawnSync("/proc/self/exe", [
      "--input-type=module",
      "--eval",
      `import { readLicenceFile } from ${JSON.stringify(pathToFileURL(script).href)}; ` +
        "process.stdout.write(readLicenceFile(process.argv[1]) ?? '');",
      directory,
    ], { uid: 65534, gid: 65534, encoding: "utf8" });
    expect(child.status, String(child.error ?? child.stderr)).toBe(0);
    expect(child.stdout).toBe(readableText);
  });

  it("uses the canonical text and labels a declared licence with no shipped file", () => {
    const result = buildNotices([entry("fallback", "3.0.0", "MIT")], readLicenceFile);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("fallback@3.0.0");
    expect(result.text).toContain("Licence file: none shipped — canonical text of declared licence (MIT)");
    expect(result.text).toContain("Permission is hereby granted, free of charge");
  });

  it("includes a separate NOTICE after the shipped licence text", () => {
    const packageEntry = entry("with-notice", "1.0.0", "Apache-2.0", "LICENSE", "shipped licence body\n");
    writeFileSync(join(packageEntry.directory, "NOTICE"), "separate attribution notice\n");

    const result = buildNotices([packageEntry], readLicenceFile);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("Full licence text:\nshipped licence body\n\nNotices:\nseparate attribution notice\n");
  });

  it("uses the canonical licence when the only shipped file is a notice", () => {
    const packageEntry = entry("notice-only", "1.0.0", "MIT", "Notice.txt", "separate attribution notice\n");

    const result = buildNotices([packageEntry], readLicenceFile);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("Licence file: none shipped — canonical text of declared licence (MIT)");
    expect(result.text).toContain(`Full licence text:\n${THIRD_PARTY_LICENCE_TEXTS.MIT}`);
    expect(result.text).toContain("Notices:\nseparate attribution notice\n");
  });

  it("keeps identical licences with different NOTICE texts in separate sections", () => {
    const first = entry("first", "1.0.0", "Apache-2.0", "LICENSE", "shared licence\n");
    const second = entry("second", "2.0.0", "Apache-2.0", "LICENSE", "shared licence\n");
    writeFileSync(join(first.directory, "NOTICE"), "first attribution\n");
    writeFileSync(join(second.directory, "NOTICE"), "second attribution\n");

    const result = buildNotices([first, second], readLicenceFile);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.match(/^Packages:$/gm)).toHaveLength(2);
    expect(result.text).toContain("Notices:\nfirst attribution\n");
    expect(result.text).toContain("Notices:\nsecond attribution\n");
  });

  it("preserves the exact output for packages without a notice", () => {
    const result = buildNotices(
      [entry("plain", "1.0.0", "MIT", "LICENSE", "plain licence\n")],
      readLicenceFile,
    );

    expect(result).toEqual({
      ok: true,
      text: "Third-party notices\n" +
        "Generated at build time from the production dependency tree using pnpm licenses list --prod --json.\n" +
        "Do not edit this file; rebuild it from the dependency tree.\n\n" +
        "Packages:\n- plain@1.0.0\n  Licence: MIT\n  Homepage: https://example.test/plain\n\n" +
        "Full licence text:\nplain licence\n\n",
    });
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

describe("canonical licence texts", () => {
  it.each([
    ["MIT", "b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5"],
    ["ISC", "521c6f0ed8e64736684f89843d16a4df6b4b7449acbcfc6ca6630a3037ca8c53"],
    ["Apache-2.0", "074e6e32c86a4c0ef8b3ed25b721ca23aca83df277cd88106ef7177c354615ff"],
    ["BSD-3-Clause", "5a93d5831e1297ab10fe643e1a631e83be392896da14ee2951285a79012df69d"],
    ["0BSD", "e3f18c71e10d673590eb9856c1d79dd3b4b0d65404efb5e8584dbede7edd608b"],
    ["Unlicense", "0bdebfeda07d45dada625ae1317c6f833186e798b171d0db640bcf32e92a8240"],
    ["LGPL-3.0-or-later", "996af0513df21f7496288951c41428a03c174e9e4a9d63665c57d670f845ccb1"],
    ["CC-BY-4.0", "d557539df68e771cc1eedcc91d13f70fca930e508d11eedcafa4b15db49e3744"],
  ])("pins the complete %s text to its verified SHA-256", (id, digest) => {
    expect(createHash("sha256").update(THIRD_PARTY_LICENCE_TEXTS[id]!).digest("hex")).toBe(digest);
  });
});

describe("generator CLI", () => {
  it("resolves the output path from NEXT_DIST_DIR or .next", () => {
    const resolveOutputPath = Reflect.get(noticesGenerator, "resolveNoticesOutputPath") as
      | ((env: Record<string, string | undefined>) => string)
      | undefined;
    expect(resolveOutputPath).toBeTypeOf("function");
    if (!resolveOutputPath) return;
    expect(resolveOutputPath({ NEXT_DIST_DIR: "release-123" })).toBe(join("release-123", "third-party-notices.txt"));
    expect(resolveOutputPath({ NEXT_DIST_DIR: "  release-123  " })).toBe(join("release-123", "third-party-notices.txt"));
    expect(resolveOutputPath({})).toBe(join(".next", "third-party-notices.txt"));
  });

  it("runs the generator after Next builds", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(manifest.scripts.build).toBe("next build && node scripts/generate-third-party-notices.ts");
  });

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
    expect(existsSync(join(root, ".next/third-party-notices.txt"))).toBe(false);
    expect(existsSync(join(root, "public/third-party-notices.txt"))).toBe(false);
  });

  it("generates notices from the real production dependency tree", () => {
    const result = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    const noticesPath = join(repoRoot, ".next/third-party-notices.txt");
    expect(existsSync(noticesPath)).toBe(true);
    expect(existsSync(join(repoRoot, "public/third-party-notices.txt"))).toBe(false);
    const notices = readFileSync(noticesPath, "utf8");
    expect(notices).toContain("react@");
    expect(notices).toContain("postgres@");
    expect(Buffer.byteLength(notices)).toBe(157768);
    expect(notices.match(/^Packages:$/gm)).toHaveLength(45);
    expect(notices.match(/^- .+@[^\n]+$/gm)).toHaveLength(70);
    expect(createHash("sha256").update(notices).digest("hex")).toBe(
      "dc4a9a73aca3bd34f8644216f7f6922f2b1018cd647b09b8d457239033421815",
    );
  });
});
