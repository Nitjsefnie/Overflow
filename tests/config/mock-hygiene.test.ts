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
  return id && (ts.isStringLiteral(id) || ts.isNoSubstitutionTemplateLiteral(id)) ? id.text : undefined;
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

function violations(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const mocked = new Set<string>();
  const exitUnmocked = new Set<string>();
  const unknownMocks: string[] = [];
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
      if (id && isGraphMockId(id)) graphMocks.push(`vi.mock(${JSON.stringify(id)})`);
    } else if (viCall(node, "resetModules")) {
      resets.push(node.getStart(ast));
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      imports.push(node.getStart(ast));
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
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
  const errors = testFiles("tests").sort().flatMap(violations);
  expect(errors, "mock hygiene violations; repair each named test file").toEqual([]);
});
