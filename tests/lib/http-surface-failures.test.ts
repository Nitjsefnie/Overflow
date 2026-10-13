import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveRouteFailures, routeModulePath } from "../../scripts/http-surface-derive-failures.ts";
import { repoRoot } from "../../scripts/http-surface-derive.ts";

const helper = `export function errorEnvelope(code: string, message: string, extra?: Record<string, unknown>) {
  return { error: { code, message, ...extra } };
}
export function errorResponse(status: number, code: string, message: string, options?: { extra?: Record<string, unknown>; headers?: HeadersInit }): Response {
  return Response.json(errorEnvelope(code, message, options?.extra), { status, headers: options?.headers });
}
`;

const importHelper = 'import { errorResponse } from "@/lib/http/error-response";\n';

/** A scratch repository root holding the helper and the given src files. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "http-surface-failures-"));
  for (const [path, source] of Object.entries({ "src/lib/http/error-response.ts": helper, ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

const routeFile = "src/app/api/things/route.ts";

describe("HTTP failure-answer derivation", () => {
  it.each([
    ["GET /api/version", "src/app/api/version/route.ts"],
    ["GET /api/settlements/<id>", "src/app/api/settlements/[id]/route.ts"],
    ["POST /api/moderation/recalibration/adjustment", "src/app/api/moderation/recalibration/adjustment/route.ts"],
  ])("serves %s from %s", (key, path) => {
    expect(routeModulePath(key)).toBe(path);
  });

  it("collects literal answers through relative, aliased and dynamic imports, sorted and de-duplicated", () => {
    const root = tree({
      [routeFile]: `${importHelper}import { guard } from "./guard";
import { lazy } from "@/lib/lazy";
export async function GET() {
  const deny = () => errorResponse(403, "FORBIDDEN", "No.");
  const { later } = await import("@/lib/later");
  return guard() ?? lazy() ?? later() ?? deny() ?? errorResponse(401, "UNAUTHENTICATED", "Sign in.");
}
`,
      "src/app/api/things/guard.ts": `${importHelper}export function guard() {
  return errorResponse(403, "FORBIDDEN", "Still no.");
}
`,
      "src/lib/lazy.ts": `import { errorResponse as refuse } from "@/lib/http/error-response.ts";
export function lazy() { return refuse(409, \`CONFLICT\`, "Busy.", { extra: { retryable: true, repositories: [] } }); }
`,
      "src/lib/later/index.ts": `${importHelper}export function later() {
  return errorResponse(429, "RATE_LIMITED", "Slow.", { headers: { "retry-after": "1" } });
}
`,
    });
    expect(deriveRouteFailures(["GET /api/things", "POST /api/things"], root)).toEqual({
      "GET /api/things": [
        "401 UNAUTHENTICATED",
        "403 FORBIDDEN",
        "409 CONFLICT +repositories +retryable",
        "429 RATE_LIMITED",
      ],
      "POST /api/things": [
        "401 UNAUTHENTICATED",
        "403 FORBIDDEN",
        "409 CONFLICT +repositories +retryable",
        "429 RATE_LIMITED",
      ],
    });
  });

  it("resolves a same-module const with a literal initializer", () => {
    const root = tree({
      [routeFile]: `${importHelper}const STATUS = 503;
const CODE = "UNAVAILABLE" as const;
export function GET() { return errorResponse(STATUS, CODE, "Later."); }
`,
    });
    expect(deriveRouteFailures(["GET /api/things"], root)).toEqual({ "GET /api/things": ["503 UNAVAILABLE"] });
  });

  it("follows neither type-only imports nor imports outside src", () => {
    const root = tree({
      [routeFile]: `import type { Shape } from "@/lib/typed";
import { thing } from "some-package";
export function GET(): Shape { return thing(); }
`,
      "src/lib/typed.ts": `${importHelper}export type Shape = Response;
export function refuse() { return errorResponse(400, "INVALID_INPUT", "Bad."); }
`,
    });
    expect(deriveRouteFailures(["GET /api/things"], root)).toEqual({ "GET /api/things": [] });
  });

  it("follows a re-export within src", () => {
    const root = tree({
      [routeFile]: 'export { refuse as GET } from "../../../lib/refuse";\n',
      "src/lib/refuse.ts": `${importHelper}export function refuse() { return errorResponse(400, "INVALID_INPUT", "Bad."); }
`,
    });
    expect(deriveRouteFailures(["GET /api/things"], root)).toEqual({ "GET /api/things": ["400 INVALID_INPUT"] });
  });

  it.each([
    ["a non-literal status", `export function GET(status: number) { return errorResponse(status, "X", "m"); }`, 2],
    ["a non-literal code", `export function GET(error: { code: string }) {\n  return errorResponse(400, error.code, "m");\n}`, 3],
    ["a let binding", `let CODE = "X";\nexport function GET() { return errorResponse(400, CODE, "m"); }`, 3],
    ["a const with a computed initializer", `const CODE = ["X"][0]!;\nexport function GET() { return errorResponse(400, CODE, "m"); }`, 3],
    ["a parameter shadowing a literal const", `const code = "X";\nexport function GET(code: string) { return errorResponse(400, code, "m"); }`, 3],
    ["a template with a substitution", 'const part = "X";\nexport function GET() { return errorResponse(400, `${part}Y`, "m"); }', 3],
    ["spread arguments", `const args = [400, "X", "m"] as const;\nexport function GET() { return errorResponse(...args); }`, 3],
    ["options that are not an object literal", `const options = { extra: { a: 1 } };\nexport function GET() { return errorResponse(400, "X", "m", options); }`, 3],
    ["a spread into the options", `const more = { extra: { a: 1 } };\nexport function GET() { return errorResponse(400, "X", "m", { ...more }); }`, 3],
    ["extra that is not an object literal", `const extra = { a: 1 };\nexport function GET() { return errorResponse(400, "X", "m", { extra }); }`, 3],
    ["a spread into the extra fields", `const more = { a: 1 };\nexport function GET() { return errorResponse(400, "X", "m", { extra: { ...more } }); }`, 3],
    ["a computed extra field name", `const key = "a";\nexport function GET() { return errorResponse(400, "X", "m", { extra: { [key]: 1 } }); }`, 3],
    ["the helper passed as a value", `export const GET = [errorResponse][0];`, 2],
  ])("fails loudly naming file and line for %s", (_label, body, line) => {
    const root = tree({ [routeFile]: `${importHelper}${body}\n` });
    expect(() => deriveRouteFailures(["GET /api/things"], root)).toThrow(`${routeFile}:${line}`);
  });

  it("fails loudly on a const imported from another module", () => {
    const root = tree({
      [routeFile]: `${importHelper}import { CODE } from "@/lib/codes";
export function GET() { return errorResponse(400, CODE, "m"); }
`,
      "src/lib/codes.ts": 'export const CODE = "X";\n',
    });
    expect(() => deriveRouteFailures(["GET /api/things"], root)).toThrow(`${routeFile}:3`);
  });

  it("fails loudly on a namespace import of the helper module", () => {
    const root = tree({
      [routeFile]: 'import * as http from "@/lib/http/error-response";\nexport function GET() { return http.errorResponse(400, "X", "m"); }\n',
    });
    expect(() => deriveRouteFailures(["GET /api/things"], root)).toThrow(`${routeFile}:1`);
  });

  it.each([
    ["awaited dynamic property call", '(await import("@/lib/http/error-response")).errorResponse(418, "HIDDEN", "m")'],
    ["dynamic property call without await", 'import("@/lib/http/error-response").errorResponse(418, "HIDDEN", "m")'],
    ["dynamic call with nonliteral arguments", '(await import("@/lib/http/error-response")).errorResponse(Number(418), ["HIDDEN"][0]!, "m")'],
    ["dynamic namespace binding", '(() => { const http = import("@/lib/http/error-response"); return http; })()'],
    ["awaited dynamic namespace binding", '(async () => { const http = await import("@/lib/http/error-response"); return http.errorResponse(418, "HIDDEN", "m"); })()'],
    ["dynamic destructuring", '(async () => { const { errorResponse: f } = await import("@/lib/http/error-response"); return f(418, "HIDDEN", "m"); })()'],
    ["dynamic then callback", 'import("@/lib/http/error-response").then(http => http.errorResponse(418, "HIDDEN", "m"))'],
    ["dynamic then destructuring", 'import("@/lib/http/error-response").then(({ errorResponse: f }) => f(418, "HIDDEN", "m"))'],
    ["dynamic template specifier", '(await import(`../../../lib/http/error-response.ts`)).errorResponse(418, "HIDDEN", "m")'],
    ["dynamic builder", '(await import("@/lib/http/error-response")).errorEnvelope("HIDDEN", "m")'],
  ])("refuses %s even when the former failure remains recorded", (_label, expression) => {
    const root = tree({
      [routeFile]: `${importHelper}export async function GET() {
  errorResponse(400, "INVALID_REQUEST", "m");
  errorResponse(400, "INVALID_REQUEST", "m");
  return ${expression};
}
`,
    });
    expect(() => deriveRouteFailures(["GET /api/things"], root)).toThrow(`${routeFile}:5:`);
  });

  it.each([
    ["CommonJS property call", 'require("../../../lib/http/error-response.ts").errorResponse(418, "HIDDEN", "m")'],
    ["CommonJS destructuring", '(() => { const { errorResponse: f } = require("@/lib/http/error-response"); return f(418, "HIDDEN", "m"); })()'],
    ["CommonJS builder", 'require(`@/lib/http/error-response`).errorEnvelope("HIDDEN", "m")'],
  ])("refuses %s naming the helper require location", (_label, expression) => {
    const root = tree({ [routeFile]: `${importHelper}export function GET() {
  return ${expression};
}
` });
    expect(() => deriveRouteFailures(["GET /api/things"], root)).toThrow(`${routeFile}:3:`);
  });

  it("follows a CommonJS edge to a module with named helper calls", () => {
    const root = tree({
      [routeFile]: 'export function GET() { return require("@/lib/refuse").refuse(); }',
      "src/lib/refuse.ts": `${importHelper}export function refuse() { return errorResponse(418, "HIDDEN", "m"); }`,
    });
    expect(deriveRouteFailures(["GET /api/things"], root)).toEqual({ "GET /api/things": ["418 HIDDEN"] });
  });

  it("refuses a CommonJS edge to a helper re-export", () => {
    const root = tree({
      [routeFile]: 'export function GET() { return require("@/lib/barrel").errorResponse(418, "HIDDEN", "m"); }',
      "src/lib/barrel.ts": 'export { errorResponse } from "@/lib/http/error-response";',
    });
    expect(() => deriveRouteFailures(["GET /api/things"], root)).toThrow("src/lib/barrel.ts:1:");
  });

  it.each([
    ['const module = "@/lib/refuse";\nrequire(module);', 2],
    ['require("./gone");', 1],
  ])("refuses unresolved CommonJS references %s", (source, line) => {
    const root = tree({ [routeFile]: source });
    expect(() => deriveRouteFailures(["GET /api/things"], root)).toThrow(`${routeFile}:${line}:`);
  });

  it.each([
    ["import-equals namespace", 'import http = require("@/lib/http/error-response");', 'http.errorResponse(418, "HIDDEN", "m")'],
    ["import-equals destructuring", 'import http = require("../../../lib/http/error-response.ts");', '(() => { const { errorResponse: f } = http; return f(418, "HIDDEN", "m"); })()'],
    ["default import and re-binding", 'import http from "@/lib/http/error-response";', '(() => { const f = http.errorResponse; return f(418, "HIDDEN", "m"); })()'],
    ["named default import", 'import { default as http } from "@/lib/http/error-response";', 'http.errorResponse(418, "HIDDEN", "m")'],
    ["string-named namespace import", 'import { "*" as http } from "@/lib/http/error-response";', 'http.errorResponse(418, "HIDDEN", "m")'],
    ["namespace re-binding", 'import * as http from "@/lib/http/error-response";', '(() => { const { errorResponse: f } = http; return f(418, "HIDDEN", "m"); })()'],
  ])("refuses %s at the helper import", (_label, declaration, expression) => {
    const root = tree({
      [routeFile]: `${importHelper}${declaration}
export function GET() { errorResponse(400, "INVALID_REQUEST", "m"); return ${expression}; }
`,
    });
    expect(() => deriveRouteFailures(["GET /api/things"], root)).toThrow(`${routeFile}:2:`);
  });

  it.each([
    ["local alias", 'const f = errorResponse; return f(418, "HIDDEN", "m");'],
    ["internal import-equals alias", 'import f = errorResponse; return f(418, "HIDDEN", "m");'],
    ["stored property", 'const http = { fail: errorResponse }; return http.fail(418, "HIDDEN", "m");'],
    ["stored shorthand", 'const http = { errorResponse }; return http.errorResponse(418, "HIDDEN", "m");'],
    ["passed callback", 'return [1].map(errorResponse);'],
    ["bound helper", 'return errorResponse.bind(null, 418, "HIDDEN", "m")();'],
  ])("refuses an unattributed helper reference: %s", (_label, body) => {
    const root = tree({ [routeFile]: `${importHelper}export function GET() { ${body} }\n` });
    expect(() => deriveRouteFailures(["GET /api/things"], root)).toThrow(`${routeFile}:2:`);
  });

  it("fails loudly on a re-export of the helper", () => {
    const root = tree({
      [routeFile]: 'export { errorResponse as GET } from "@/lib/http/error-response";\n',
    });
    expect(() => deriveRouteFailures(["GET /api/things"], root)).toThrow(`${routeFile}:1`);
  });

  it("fails loudly on the envelope builder used outside the helper", () => {
    const root = tree({
      [routeFile]: 'import { errorEnvelope } from "@/lib/http/error-response";\n' +
        "export function GET() { return Response.json(errorEnvelope(\"X\", \"m\"), { status: 400 }); }\n",
    });
    expect(() => deriveRouteFailures(["GET /api/things"], root)).toThrow(`${routeFile}:2`);
  });

  it("fails loudly on a dynamic import it cannot follow", () => {
    const root = tree({
      [routeFile]: 'const where = "@/lib/x";\nexport async function GET() { return (await import(where)).GET(); }\n',
    });
    expect(() => deriveRouteFailures(["GET /api/things"], root)).toThrow(`${routeFile}:2`);
  });

  it("fails loudly on a relative import that resolves to no module", () => {
    const root = tree({ [routeFile]: 'import { gone } from "./gone";\nexport const GET = gone;\n' });
    expect(() => deriveRouteFailures(["GET /api/things"], root)).toThrow(`${routeFile}:1`);
  });

  it("fails loudly on a route with no module", () => {
    const root = tree({});
    expect(() => deriveRouteFailures(["GET /api/missing"], root)).toThrow("src/app/api/missing/route.ts");
  });

  it("derives each documented route from the module the success derivation imports it from", () => {
    const snapshot = JSON.parse(
      readFileSync(join(repoRoot, "scripts/http-surface-snapshot.json"), "utf8"),
    ) as { routes: Record<string, unknown> };
    const imported = new Set(
      ["scripts/http-surface-derive.ts", "scripts/http-surface-derive-moderation.ts"].flatMap((file) =>
        [...readFileSync(join(repoRoot, file), "utf8").matchAll(/from "\.\.\/(src\/app\/[^"]+\/route\.ts)"/g)]
          .map((match) => match[1]!),
      ),
    );
    const derived = new Set(Object.keys(snapshot.routes).map(routeModulePath));
    expect([...derived].sort()).toEqual([...imported].sort());
  });
});
