#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const PRERENDER_ALLOWLIST: Readonly<Record<string, string>> = {
  // This client component lives outside the root layout and is rendered
  // client-side when that layout fails; it is not a nonce-bearing document route.
  "/_global-error": "Client-side root layout error fallback, outside the root layout",
};

type Decision = { unexpectedRoutes: string[]; staleAllowlist: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Inspect the version-4 fields used by Next 16, failing closed on unknown shapes. */
export function checkPrerenderedRoutes(
  manifest: unknown,
  allowlist: Readonly<Record<string, string>>,
): Decision {
  if (!isRecord(manifest) || manifest.version !== 4 ||
      !isRecord(manifest.routes) || !isRecord(manifest.dynamicRoutes)) {
    throw new Error("Invalid prerender manifest: expected version 4 with routes and dynamicRoutes objects");
  }
  const staticRoutes = new Set<string>();
  for (const [route, entry] of Object.entries(manifest.routes)) {
    if (!isRecord(entry)) throw new Error(`Invalid prerender manifest route: ${route}`);
    staticRoutes.add(route);
  }
  for (const [route, entry] of Object.entries(manifest.dynamicRoutes)) {
    if (!isRecord(entry) || !(entry.fallback === false || entry.fallback === null ||
        typeof entry.fallback === "string")) {
      throw new Error(`Invalid prerender manifest fallback: ${route}`);
    }
    // Next's lib/fallback: string serves prerendered HTML; null generates and
    // caches static HTML on demand (blocking). false serves no fallback HTML.
    // Catch both static modes, including partial prerendered shells.
    if (entry.fallback !== false) staticRoutes.add(route);
  }
  return {
    unexpectedRoutes: [...staticRoutes].filter((route) => !Object.hasOwn(allowlist, route)).sort(),
    staleAllowlist: Object.keys(allowlist).filter((route) => !staticRoutes.has(route)).sort(),
  };
}

if (import.meta.main) {
  const path = resolve(".next/prerender-manifest.json");
  try {
    // Reading through .next also follows a deployment's release-directory symlink.
    const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
    const { unexpectedRoutes, staleAllowlist } = checkPrerenderedRoutes(manifest, PRERENDER_ALLOWLIST);
    for (const route of unexpectedRoutes) console.error(`Unapproved statically prerendered route: ${route}`);
    for (const route of staleAllowlist) console.error(`Stale prerender allowlist entry: ${route}`);
    if (unexpectedRoutes.length || staleAllowlist.length) {
      process.exitCode = 1;
    } else {
      console.log("Prerendered routes check passed (only explicit exceptions are static).");
    }
  } catch (error) {
    console.error(`Cannot check ${path}: ${error instanceof Error ? error.message : String(error)}. Run pnpm build first.`);
    process.exitCode = 2;
  }
}
