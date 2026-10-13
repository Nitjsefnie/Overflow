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
    'import Response from "some-package"; export function GET() { return new Response("bad", {status:400}); }',
    'import { redirect as go } from "next/navigation"; export function GET() { return go("/elsewhere"); }',
    'import { permanentRedirect as go } from "next/navigation"; export function GET() { return go("/elsewhere"); }',
    'import * as navigation from "next/navigation"; export function GET() { return navigation.redirect("/elsewhere"); }',
  ])("refuses an unrecorded constructor or navigation redirect: %s", (source) => {
    const root = tree({ [routeFile]: source });
    expect(() => deriveRouteFailures(["GET /api/things"], root)).toThrow(`${routeFile}:1:`);
  });
  it.each(["Response", "NextResponse"])("refuses an imported %s constructor alias outside the helper", (constructor) => {
    const root = tree({ [routeFile]: `import { ${constructor} as Reply } from "some-package";
export function GET() { return new Reply("bad", {status: 400}); }` });
    expect(() => deriveRouteFailures(["GET /api/things"], root)).toThrow(`${routeFile}:2:`);
  });
  it.each([
    'export type ReviewFailure = typeof errorResponse;',
    'const value: typeof errorResponse | undefined = undefined;',
    'type Shape = { handler: typeof errorResponse }; interface Other { handler: typeof errorResponse }',
    'const value = null as unknown as typeof errorResponse;',
    'const value = null satisfies typeof errorResponse | null;',
  ])("ignores erased helper references: %s", (annotation) => {
    const root = tree({ [routeFile]: `${importHelper}${annotation}\nexport const GET = () => errorResponse(401, "UNAUTHENTICATED", "m");` });
    expect(deriveRouteFailures(["GET /api/things"], root)).toEqual({ "GET /api/things": ["401 UNAUTHENTICATED"] });
  });
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

  it.each([
    'export type { createRequire } from "node:module";',
    'export { type createRequire } from "node:module";',
    'export type * from "node:module";',
    'export type * as loaders from "node:module";',
    'import type { createRequire } from "node:module"; export type Loader = typeof createRequire;',
    'import { type createRequire } from "node:module"; export type Loader = typeof createRequire;',
    'import type * as loaders from "node:module"; export type Loader = typeof loaders.createRequire;',
    'import type loaders = require("node:module"); export type Loader = typeof loaders;',
    'type Loader = typeof require; type Host = typeof module; type Maker = typeof createRequire;',
    'export type Loader = typeof import("node:module").createRequire;',
    'type require = string; export type { require };',
    'import { type createRequire, builtinModules } from "node:module"; export { type createRequire, builtinModules };',
  ])("ignores erased loader syntax: %s", (source) => {
    const root = tree({ [routeFile]: source });
    expect(deriveRouteFailures(["GET /api/things"], root)).toEqual({ "GET /api/things": [] });
  });

  it.each([
    'import type { Thing } from "@/lib/types-only";',
    'export type { Thing } from "@/lib/types-only";',
  ])("does not follow an erased src edge: %s", (source) => {
    const root = tree({
      [routeFile]: source,
      "src/lib/types-only.ts": 'import { createRequire } from "node:module"; export type Thing = string; export const load = createRequire(import.meta.url);',
    });
    expect(deriveRouteFailures(["GET /api/things"], root)).toEqual({ "GET /api/things": [] });
  });

  it.each([
    'import { type Thing } from "@/lib/types-only";',
    'export { type Thing } from "@/lib/types-only";',
  ])("follows the runtime module edge despite erased bindings: %s", (source) => {
    const root = tree({
      [routeFile]: source,
      "src/lib/types-only.ts": 'import { createRequire } from "node:module"; export type Thing = string; export const load = createRequire(import.meta.url);',
    });
    expect(() => deriveRouteFailures(["GET /api/things"], root)).toThrow("src/lib/types-only.ts:1:");
  });

  it("retains the runtime half of a mixed import", () => {
    const root = tree({
      [routeFile]: 'import { type Thing, refuse } from "@/lib/mixed"; export const GET = refuse;',
      "src/lib/mixed.ts": `${importHelper}export type Thing = string; export const refuse = () => errorResponse(418, "RUNTIME", "m");`,
    });
    expect(deriveRouteFailures(["GET /api/things"], root)).toEqual({ "GET /api/things": ["418 RUNTIME"] });
  });

  it.each(["globalThis", "global", "self"].flatMap((host) =>
    [ `${host}.require`, `${host}["require"]`, `(${host} as any).require`,
      `(() => { const load = ${host}.require; return load; })()` ],
  ))("refuses a global loader reference %s", (loader) => {
    const root = tree({ [routeFile]: `export function GET() { return ${loader}("@/lib/http/error-response").errorResponse(418, "GLOBAL_CJS", "probe"); }` });
    expect(() => deriveRouteFailures(["GET /api/things"], root)).toThrow(`${routeFile}:1:`);
  });

  it("does not confuse shadowed global hosts or their type queries with runtime loaders", () => {
    const root = tree({ [routeFile]: `type Loader = typeof globalThis.require;
export function GET(globalThis: any, global: any, self: any) {
  return globalThis.require() ?? global["require"]() ?? self.require();
}` });
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

  it.each([
    ["parentheses", '(require)("@/lib/http/error-response").errorResponse(418, "HIDDEN", "m")'],
    ["as", '(require as typeof require)("@/lib/http/error-response").errorResponse(418, "HIDDEN", "m")'],
    ["satisfies", '(require satisfies typeof require)("@/lib/http/error-response").errorResponse(418, "HIDDEN", "m")'],
    ["non-null", 'require!("@/lib/http/error-response").errorResponse(418, "HIDDEN", "m")'],
    ["type assertion", '(<typeof require>require)("@/lib/http/error-response").errorResponse(418, "HIDDEN", "m")'],
    ["IIFE alias", '(() => { const load = require; return load("@/lib/http/error-response").errorResponse(418, "HIDDEN", "m"); })()'],
    ["stored shorthand", '({ require }).require("@/lib/http/error-response").errorResponse(418, "HIDDEN", "m")'],
    ["bound loader", 'require.bind(null)("@/lib/http/error-response").errorResponse(418, "HIDDEN", "m")'],
    ["comma wrapper", '(0, require)("@/lib/http/error-response").errorResponse(418, "HIDDEN", "m")'],
    ["module loader", 'module.require("@/lib/http/error-response").errorResponse(418, "HIDDEN", "m")'],
    ["computed module loader", 'module["require"]("@/lib/http/error-response").errorResponse(418, "HIDDEN", "m")'],
    ["module alias", '(() => { const mod = module; return mod.require("@/lib/http/error-response").errorResponse(418, "HIDDEN", "m"); })()'],
  ])("refuses an unattributed CommonJS load via %s", (_label, expression) => {
    const root = tree({ [routeFile]: `export function GET() { return ${expression}; }` });
    expect(() => deriveRouteFailures(["GET /api/things"], root)).toThrow(`${routeFile}:1:`);
  });

  it.each([
    'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);',
    'import { createRequire as factory } from "module";\nconst load = factory(import.meta.url);',
    'import * as loaders from "node:module";\nconst load = loaders.createRequire(import.meta.url);',
    'import loaders from "node:module";\nconst { createRequire: factory } = loaders; const load = factory(import.meta.url);',
    'const loaders = require("node:module");\nconst load = loaders.createRequire(import.meta.url);',
    'import loaders = require("node:module");\nconst load = loaders.createRequire(import.meta.url);',
    'const loaders = await import("node:module");\nconst load = loaders.createRequire(import.meta.url);',
    'const load = createRequire(import.meta.url);',
  ])("refuses a constructed CommonJS loader: %s", (declaration) => {
    const root = tree({ [routeFile]: `${declaration}\nexport function GET() { return load("@/lib/http/error-response").errorResponse(418, "HIDDEN", "m"); }` });
    expect(() => deriveRouteFailures(["GET /api/things"], root)).toThrow(new RegExp(`${routeFile}:\\d+:`));
  });

  it.each(['(require)', '(require as typeof require)', '(require satisfies typeof require)', 'require!'])(
    "follows the src module loaded by transparent wrapper %s", (callee) => {
      const root = tree({
        [routeFile]: `export function GET() { return ${callee}("@/lib/refuse").refuse(); }`,
        "src/lib/refuse.ts": `${importHelper}export function refuse() { return errorResponse(418, "HIDDEN", "m"); }`,
      });
      expect(deriveRouteFailures(["GET /api/things"], root)).toEqual({ "GET /api/things": ["418 HIDDEN"] });
    },
  );

  it("ignores locally bound loader names, property names and erased type references", () => {
    const root = tree({ [routeFile]: `type Shape = { require: string; module: string };
export function GET(require: (name: string) => Response, name: string, module: { require: () => Response }, createRequire: () => Response) {
  const labels = { require: "data", module: "data", createRequire: "data" };
  return require(name) ?? module.require() ?? createRequire() ?? labels;
}` });
    expect(deriveRouteFailures(["GET /api/things"], root)).toEqual({ "GET /api/things": [] });
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

  it("does not mistake unknown object property names for free loader bindings", () => {
    const root = tree({ [routeFile]: `export function GET(data: any) { return { require: data.require, module: data.module, createRequire: data.createRequire }; }` });
    expect(deriveRouteFailures(["GET /api/things"], root)).toEqual({ "GET /api/things": [] });
  });

  it.each([
    'declare const require: any;\nexport function GET() { const load = require; return load("@/lib/http/error-response"); }',
    'declare const module: any;\nexport function GET() { return module.require("@/lib/http/error-response"); }',
    'declare function createRequire(path: string): any;\nconst load = createRequire("route.ts");',
  ])("refuses ambient loader declarations that create no local runtime binding: %s", (source) => {
    const root = tree({ [routeFile]: source });
    expect(() => deriveRouteFailures(["GET /api/things"], root)).toThrow(`${routeFile}:2:`);
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

  it.each([
    'export { type errorResponse }',
    'export { type errorEnvelope }',
    'export type { errorResponse }',
    'export {}',
  ])("keeps recorded calls with no runtime helper re-export: %s", (declaration) => {
    const root = tree({
      [routeFile]: `${importHelper}${declaration} from "@/lib/http/error-response";
export function GET() { return errorResponse(400, "INVALID_INPUT", "Bad."); }
`,
    });
    expect(deriveRouteFailures(["GET /api/things"], root)).toEqual({ "GET /api/things": ["400 INVALID_INPUT"] });
  });

  it.each([
    'export { errorEnvelope }',
    'export { type errorResponse, errorEnvelope }',
    'export { type errorEnvelope, errorResponse as refuse }',
    'export *',
    'export * as failures',
  ])("refuses runtime helper re-exports: %s", (declaration) => {
    const root = tree({
      [routeFile]: `${declaration} from "@/lib/http/error-response";`,
    });
    expect(() => deriveRouteFailures(["GET /api/things"], root)).toThrow(`${routeFile}:1: re-exports`);
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
