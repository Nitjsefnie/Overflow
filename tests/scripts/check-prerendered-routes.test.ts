import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPrerenderedRoutes } from "../../scripts/check-prerendered-routes";

const manifest = (routes: Record<string, unknown> = {}, dynamicRoutes: Record<string, unknown> = {}) => ({
  version: 4, routes, dynamicRoutes,
});
const exemption = { "/_global-error": "Client-side root layout error fallback" };
const script = resolve("scripts/check-prerendered-routes.ts");

// Fixtures cover the fields consumed by this gate; unrelated Next metadata is omitted.
describe("the prerender decision", () => {
  it("accepts an all-dynamic build with an empty allowlist", () => {
    expect(checkPrerenderedRoutes(manifest(), {})).toEqual({ unexpectedRoutes: [], staleAllowlist: [] });
  });

  it("names every unlisted static route, including ISR and generated concrete paths", () => {
    expect(checkPrerenderedRoutes(manifest({
      "/terms": { initialRevalidateSeconds: false },
      "/news": { initialRevalidateSeconds: 60 },
      "/posts/one": { srcRoute: "/posts/[slug]" },
    }), {})).toEqual({ unexpectedRoutes: ["/news", "/posts/one", "/terms"], staleAllowlist: [] });
  });

  it("accepts an explicitly allowlisted prerender", () => {
    expect(checkPrerenderedRoutes(manifest({ "/_global-error": {} }), exemption)).toEqual({
      unexpectedRoutes: [], staleAllowlist: [],
    });
  });

  it("reports stale exemptions alongside unexpected routes", () => {
    expect(checkPrerenderedRoutes(manifest({ "/terms": {} }), exemption)).toEqual({
      unexpectedRoutes: ["/terms"], staleAllowlist: ["/_global-error"],
    });
  });

  it.each(["/posts/[slug].html", null])("rejects static dynamic fallback %s", (fallback) => {
    expect(checkPrerenderedRoutes(manifest({}, { "/posts/[slug]": { fallback } }), {})).toEqual({
      unexpectedRoutes: ["/posts/[slug]"], staleAllowlist: [],
    });
  });

  it("permits dynamic routes with no fallback HTML", () => {
    expect(checkPrerenderedRoutes(manifest({}, { "/posts/[slug]": { fallback: false } }), {})).toEqual({
      unexpectedRoutes: [], staleAllowlist: [],
    });
  });

  it("applies the allowlist to fallback HTML and deduplicates route keys", () => {
    expect(checkPrerenderedRoutes(manifest({ "/posts/[slug]": {} }, {
      "/posts/[slug]": { fallback: "/posts/[slug].html" },
    }), { "/posts/[slug]": "Approved fallback" })).toEqual({ unexpectedRoutes: [], staleAllowlist: [] });
  });

  it("does not count a no-HTML fallback as a live exemption", () => {
    expect(checkPrerenderedRoutes(manifest({}, { "/posts/[slug]": { fallback: false } }), {
      "/posts/[slug]": "Former static fallback",
    })).toEqual({ unexpectedRoutes: [], staleAllowlist: ["/posts/[slug]"] });
  });

  it.each([null, {}, { version: 3, routes: {}, dynamicRoutes: {} },
    { version: 4, routes: [], dynamicRoutes: {} }, manifest({ "/terms": null }),
    manifest({}, { "/posts/[slug]": {} }), manifest({}, { "/posts/[slug]": { fallback: true } }),
    manifest({}, { "/posts/[slug]": { fallback: 1 } }),
  ])("refuses an unsupported or malformed manifest: %j", (input) => {
    expect(() => checkPrerenderedRoutes(input, {})).toThrow(/manifest|fallback/i);
  });
});

describe("the prerender gate CLI", () => {
  function run(source?: string, symlink = false) {
    const cwd = mkdtempSync(join(tmpdir(), "overflow-1144-prerender-"));
    const build = join(cwd, symlink ? "release" : ".next");
    mkdirSync(build);
    if (source !== undefined) writeFileSync(join(build, "prerender-manifest.json"), source);
    if (symlink) symlinkSync(build, join(cwd, ".next"), "dir");
    return spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });
  }

  it.each([undefined, "{broken", "null", JSON.stringify({ routes: {} })])(
    "exits 2 and tells the operator to build for missing/malformed input %s", (source) => {
      const result = run(source);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("pnpm build");
      expect(result.stderr).toContain("prerender-manifest.json");
    },
  );

  it("exits 1 and lists all unapproved routes", () => {
    const result = run(JSON.stringify(manifest({ "/_global-error": {}, "/terms": {}, "/rules": {} })));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("/terms");
    expect(result.stderr).toContain("/rules");
  });

  it("exits 1 for a stale committed exemption", () => {
    const result = run(JSON.stringify(manifest()));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/stale/i);
    expect(result.stderr).toContain("/_global-error");
  });

  it.each([false, true])("passes the production allowlist with a symlinked build directory: %s", (symlink) => {
    const result = run(JSON.stringify(manifest({ "/_global-error": {} })), symlink);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/passed/i);
    expect(result.stderr).toBe("");
  });
});
