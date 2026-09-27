import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The route-coverage guard for API.md (issue 641): every route.ts handler
 * under src/app/api either appears in API.md as a path string or sits in the explicit
 * allowlist below naming where it is documented instead. The test reads files
 * only — no database, no Next.js runtime.
 *
 * The assertion is structural, never prose: the route's path string must be
 * present in API.md, and an occurrence followed by `/` does not count, so a
 * longer documented path cannot stand in for its own prefix (documenting
 * `/api/moderation/audits` does not document `/api/moderation`).
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const apiRoot = join(repoRoot, "src", "app", "api");
const apiDocPath = join(repoRoot, "API.md");

/**
 * Routes deliberately documented outside API.md. Keys are the route paths
 * exactly as derived from the file tree; each comment names where the route
 * is documented instead (sections verified against OPERATING.md when the
 * allowlist was written).
 */
const ALLOWED_UNDOCUMENTED: Record<string, string> = {
  // Webhook receiver routes: forge deliveries are operator material, documented in OPERATING.md ("Operating an instance: GitHub OAuth and webhooks").
  "/api/github/webhooks": "OPERATING.md",
  "/api/gitlab/webhooks": "OPERATING.md",
  // The Sign in with GitHub OAuth flow route, documented in OPERATING.md ("Operating an instance: GitHub OAuth and webhooks", the OAuth callback setup).
  "/api/auth/[...nextauth]": "OPERATING.md",
  // Account session routes (deletion and export), documented in OPERATING.md ("Account deletion and export").
  "/api/account": "OPERATING.md",
  "/api/account/export": "OPERATING.md",
};

/** Every `route.ts` under src/app/api, as full paths. */
function listRouteFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return listRouteFiles(full);
    }
    return entry.name === "route.ts" ? [full] : [];
  });
}

/** The Next.js App Router route path a route.ts file serves, e.g. `/api/moderation/[id]`. */
function routePathFor(file: string): string {
  const segments = relative(apiRoot, file).split(sep);
  return `/api/${segments.slice(0, -1).join("/")}`;
}

/**
 * The spelling API.md documents dynamic segments with: the App Router's
 * `[id]` directory becomes the doc's `<id>` placeholder, matching the
 * existing `GET /api/settlements/<id>` convention.
 */
function docPathFor(routePath: string): string {
  return routePath.replace(/\[([^\]]+)\]/g, "<$1>");
}

/**
 * Whether `docPath` occurs in `doc` as a complete path: an occurrence whose
 * next character is `/` is a prefix of a longer documented path and does not
 * stand in for the route itself.
 */
function appearsAsPathIn(doc: string, docPath: string): boolean {
  let at = doc.indexOf(docPath);
  while (at !== -1) {
    if (doc[at + docPath.length] !== "/") {
      return true;
    }
    at = doc.indexOf(docPath, at + 1);
  }
  return false;
}

describe("API.md route coverage", () => {
  const doc = readFileSync(apiDocPath, "utf8");

  it("documents every API route path that is not explicitly allowlisted", () => {
    const missing = listRouteFiles(apiRoot)
      .map(routePathFor)
      .filter((routePath) => !(routePath in ALLOWED_UNDOCUMENTED))
      .filter((routePath) => !appearsAsPathIn(doc, docPathFor(routePath)))
      .sort();

    expect(missing).toEqual([]);
  });

  it("allowlists only route paths that still exist on disk", () => {
    const routePaths = listRouteFiles(apiRoot).map(routePathFor);
    const stale = Object.keys(ALLOWED_UNDOCUMENTED).filter(
      (allowed) => !routePaths.includes(allowed),
    );

    expect(stale).toEqual([]);
  });
});
