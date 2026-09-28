import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

function testFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(file);
    return entry.isFile() && /\.test\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

function viCall(node: ts.Node, method: string): node is ts.CallExpression {
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === "vi"
    && node.expression.name.text === method;
}

function literalId(call: ts.CallExpression): string | undefined {
  const id = call.arguments[0];
  if (id && (ts.isStringLiteral(id) || ts.isNoSubstitutionTemplateLiteral(id))) return id.text;
  if (id && ts.isCallExpression(id) && id.expression.kind === ts.SyntaxKind.ImportKeyword
    && id.arguments.length === 1) {
    const imported = id.arguments[0];
    if (ts.isStringLiteral(imported) || ts.isNoSubstitutionTemplateLiteral(imported)) return imported.text;
  }
  return undefined;
}

const bareBuiltins = new Set(builtinModules.map((id) => id.replace(/^node:/, "")));

function isGraphMockId(id: string): boolean {
  // Shared Node, database, and script modules can contaminate another file's graph.
  // Hoisted mocks of next/*, app modules, and components are outside this guard.
  return id.startsWith("node:") || bareBuiltins.has(id)
    || id.startsWith("@/lib/db/") || id.includes("/src/lib/db/")
    || id.includes("/scripts/");
}

function callbackOwner(node: ts.Node): string | undefined {
  const parent = node.parent;
  if (!ts.isCallExpression(parent) || !parent.arguments.includes(node as ts.Expression)) return undefined;
  const callee = parent.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isCallExpression(callee) && ts.isPropertyAccessExpression(callee.expression)
    && callee.expression.name.text === "each" && ts.isIdentifier(callee.expression.expression)) {
    return callee.expression.expression.text;
  }
  return undefined;
}

function hasUnconditionalFinallyPath(node: ts.TryStatement): boolean {
  let child: ts.Node = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent) || ts.isFunctionDeclaration(parent)) {
      return ["it", "test", "afterEach", "afterAll"].includes(callbackOwner(parent) ?? "");
    }
    if (ts.isBlock(parent)) continue;
    if (ts.isTryStatement(parent) && (parent.tryBlock === child || parent.finallyBlock === child)) continue;
    return false;
  }
  return false;
}

function isDescribeCallback(call: ts.CallExpression, callback: ts.Node): boolean {
  if (!call.arguments.includes(callback as ts.Expression)) return false;
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text === "describe";
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    return callee.expression.text === "describe"
      && ["skip", "only", "sequential", "concurrent"].includes(callee.name.text);
  }
  return ts.isCallExpression(callee) && ts.isPropertyAccessExpression(callee.expression)
    && callee.expression.name.text === "each" && ts.isIdentifier(callee.expression.expression)
    && callee.expression.expression.text === "describe";
}

function hasUnconditionalHookPath(call: ts.CallExpression): boolean {
  let statement = call.parent;
  if (!ts.isExpressionStatement(statement) || statement.expression !== call) return false;
  for (let parent: ts.Node = statement.parent; ; ) {
    if (ts.isSourceFile(parent)) return true;
    if (!ts.isBlock(parent)) return false;
    const callback = parent.parent;
    if ((!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) || callback.body !== parent) return false;
    const describeCall = callback.parent;
    if (!ts.isCallExpression(describeCall) || !isDescribeCallback(describeCall, callback)) return false;
    statement = describeCall.parent;
    if (!ts.isExpressionStatement(statement) || statement.expression !== describeCall) return false;
    parent = statement.parent;
  }
}

function violations(file: string, source: string): string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const mocked = new Set<string>();
  const exitUnmocked = new Set<string>();
  const unknownMocks: string[] = [];
  const unknownHoistedMocks: string[] = [];
  const graphMocks: string[] = [];
  const resets: number[] = [];
  const imports: number[] = [];
  let hasMockCall = false;
  let exitReset = false;

  function recordExit(body: ts.ConciseBody): void {
    const expressions = ts.isBlock(body)
      ? body.statements.filter(ts.isExpressionStatement).map((statement) => statement.expression)
      : [body];
    for (const expression of expressions) {
      const call = ts.isAwaitExpression(expression) ? expression.expression : expression;
      if (viCall(call, "resetModules")) exitReset = true;
      if (viCall(call, "doUnmock")) {
        const id = literalId(call);
        if (id !== undefined) exitUnmocked.add(id);
      }
    }
  }

  function visit(node: ts.Node): void {
    if (viCall(node, "doMock")) {
      const id = literalId(node);
      if (id === undefined) unknownMocks.push("vi.doMock(<non-literal id>)");
      else mocked.add(id);
    } else if (viCall(node, "mock")) {
      hasMockCall = true;
      const id = literalId(node);
      if (id === undefined) unknownHoistedMocks.push("vi.mock(<non-literal id>)");
      else if (isGraphMockId(id)) graphMocks.push(`vi.mock(${JSON.stringify(id)})`);
    } else if (viCall(node, "resetModules")) {
      resets.push(node.getStart(ast));
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      imports.push(node.getStart(ast));
    }

    if (ts.isCallExpression(node) && hasUnconditionalHookPath(node) && ts.isIdentifier(node.expression)
      && (node.expression.text === "afterEach" || node.expression.text === "afterAll")) {
      const callback = node.arguments[0];
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        recordExit(callback.body);
      }
    }
    if (ts.isTryStatement(node) && node.finallyBlock && hasUnconditionalFinallyPath(node)) {
      recordExit(node.finallyBlock);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);

  const errors: string[] = [];
  for (const call of unknownMocks) {
    errors.push(`${file}: ${call} needs a literal id so the guard can verify its matching vi.doUnmock(<same id>)`);
  }
  for (const call of unknownHoistedMocks) {
    errors.push(`${file}: ${call} needs a literal id so the guard can classify shared module mocks`);
  }
  for (const id of mocked) {
    if (!exitUnmocked.has(id)) errors.push(`${file}: vi.doMock(${JSON.stringify(id)}) needs vi.doUnmock(${JSON.stringify(id)}) as a direct statement in afterEach/afterAll or finally`);
  }
  if ((mocked.size > 0 || unknownMocks.length > 0) && !exitReset) graphMocks.push("vi.doMock(...)");
  // A reset then dynamic import without any mock reloads real modules, outside this mock-bound-graph rule.
  if (hasMockCall && resets.some((reset) => imports.some((importAt) => importAt > reset)) && !exitReset) {
    graphMocks.push("vi.resetModules() followed by dynamic import(...)");
  }
  if (graphMocks.length > 0 && !exitReset) {
    errors.push(`${file}: ${graphMocks.join(", ")} needs vi.resetModules() as a direct statement in afterEach/afterAll or finally; beforeEach and conditional calls are not exit cleanup`);
  }
  return errors;
}

it("keeps module mocks and module graphs self-contained in every test file", () => {
  const errors = testFiles("tests").sort().flatMap((file) => violations(file, readFileSync(file, "utf8")));
  expect(errors, "mock hygiene violations; repair each named test file").toEqual([]);
});

const caseFile = "tests/mock-hygiene-case.test.ts";
const resetError = (call: string) => `${caseFile}: ${call} needs vi.resetModules() as a direct statement in afterEach/afterAll or finally; beforeEach and conditional calls are not exit cleanup`;
const unmockError = (id: string) => `${caseFile}: vi.doMock(${JSON.stringify(id)}) needs vi.doUnmock(${JSON.stringify(id)}) as a direct statement in afterEach/afterAll or finally`;
const hookReset = "afterAll(() => { vi.resetModules(); });";
const graphMock = 'vi.mock("node:fs/promises", () => ({}));';
const postgresMock = 'vi.doMock("postgres", () => ({}));';

const cases: { name: string; source: string; errors: string[] }[] = [
  { name: "string hoisted id with exit reset", source: `${graphMock} ${hookReset}`, errors: [] },
  { name: "template hoisted id with exit reset", source: `vi.mock(\`node:fs/promises\`, () => ({})); ${hookReset}`, errors: [] },
  { name: "import-expression hoisted id with exit reset", source: `vi.mock(import("node:fs/promises"), () => ({})); ${hookReset}`, errors: [] },
  { name: "template import-expression hoisted id without reset", source: 'vi.mock(import(`node:fs/promises`), () => ({}));', errors: [resetError('vi.mock("node:fs/promises")')] },
  { name: "import-expression hoisted id without reset", source: 'vi.mock(import("node:fs/promises"), () => ({}));', errors: [resetError('vi.mock("node:fs/promises")')] },
  { name: "non-literal hoisted id", source: 'const id = "node:fs/promises"; vi.mock(id, () => ({}));', errors: [`${caseFile}: vi.mock(<non-literal id>) needs a literal id so the guard can classify shared module mocks`] },
  { name: "string doMock and doUnmock ids", source: `${postgresMock} afterEach(() => { vi.doUnmock("postgres"); vi.resetModules(); });`, errors: [] },
  { name: "template doMock and doUnmock ids", source: 'vi.doMock(`postgres`, () => ({})); afterEach(() => { vi.doUnmock(`postgres`); vi.resetModules(); });', errors: [] },
  { name: "import-expression doMock and doUnmock ids", source: 'vi.doMock(import("postgres"), () => ({})); afterEach(() => { vi.doUnmock(import("postgres")); vi.resetModules(); });', errors: [] },
  { name: "template import-expression doMock and doUnmock ids", source: 'vi.doMock(import(`postgres`), () => ({})); afterEach(() => { vi.doUnmock(import(`postgres`)); vi.resetModules(); });', errors: [] },
  { name: "import-expression doUnmock matches string doMock", source: `${postgresMock} afterEach(() => { vi.doUnmock(import("postgres")); vi.resetModules(); });`, errors: [] },
  { name: "non-literal doMock id", source: 'const id = "postgres"; vi.doMock(id, () => ({})); afterEach(() => vi.resetModules());', errors: [`${caseFile}: vi.doMock(<non-literal id>) needs a literal id so the guard can verify its matching vi.doUnmock(<same id>)`] },
  { name: "top-level afterAll registration", source: `${graphMock} ${hookReset}`, errors: [] },
  { name: "describe afterEach registration", source: `${graphMock} describe("scope", () => { afterEach(() => vi.resetModules()); });`, errors: [] },
  { name: "describe.each registration", source: `${graphMock} describe.each([])("scope", () => { ${hookReset} });`, errors: [] },
  { name: "nested describe registration", source: `${graphMock} describe("outer", () => { describe("inner", () => { ${hookReset} }); });`, errors: [] },
  ...["skip", "only", "sequential", "concurrent"].map((modifier) => ({
    name: `describe.${modifier} registration`,
    source: `${graphMock} describe.${modifier}("scope", () => { ${hookReset} });`,
    errors: [],
  })),
  { name: "conditional hook registration", source: `${graphMock} if (false) { ${hookReset} }`, errors: [resetError('vi.mock("node:fs/promises")')] },
  { name: "helper hook registration", source: `${graphMock} function register() { ${hookReset} } register();`, errors: [resetError('vi.mock("node:fs/promises")')] },
  { name: "loop hook registration", source: `${graphMock} for (const x of [1]) { ${hookReset} }`, errors: [resetError('vi.mock("node:fs/promises")')] },
  { name: "try-wrapped hook registration", source: `${graphMock} try { ${hookReset} } finally {}`, errors: [resetError('vi.mock("node:fs/promises")')] },
  { name: "direct finally cleanup", source: `${postgresMock} it("case", () => { try {} finally { vi.doUnmock("postgres"); vi.resetModules(); } });`, errors: [] },
  { name: "conditional finally cleanup", source: `${postgresMock} it("case", () => { if (false) { try {} finally { vi.doUnmock("postgres"); vi.resetModules(); } } });`, errors: [unmockError("postgres"), resetError("vi.doMock(...)")] },
  { name: "beforeEach cleanup", source: `${postgresMock} beforeEach(() => { vi.doUnmock("postgres"); vi.resetModules(); });`, errors: [unmockError("postgres"), resetError("vi.doMock(...)")] },
  { name: "awaited exit cleanup", source: `${postgresMock} afterAll(async () => { await vi.doUnmock("postgres"); await vi.resetModules(); });`, errors: [] },
  { name: "pure reload without mock", source: 'vi.resetModules(); await import("./real-module");', errors: [] },
  { name: "bare builtin mock without reset", source: 'vi.mock("fs/promises", () => ({}));', errors: [resetError('vi.mock("fs/promises")')] },
  { name: "database mock without reset", source: 'vi.mock("@/lib/db/client", () => ({}));', errors: [resetError('vi.mock("@/lib/db/client")')] },
  { name: "relative database mock without reset", source: 'vi.mock("../../src/lib/db/client", () => ({}));', errors: [resetError('vi.mock("../../src/lib/db/client")')] },
  { name: "script mock without reset", source: 'vi.mock("../../scripts/migrate", () => ({}));', errors: [resetError('vi.mock("../../scripts/migrate")')] },
  { name: "other app mock outside graph scope", source: 'vi.mock("next/navigation", () => ({}));', errors: [] },
];

for (const { name, source, errors } of cases) {
  it(`mock hygiene: ${name}`, () => {
    expect(violations(caseFile, source)).toEqual(errors);
  });
}
