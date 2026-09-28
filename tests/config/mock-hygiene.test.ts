import { readFileSync, readdirSync } from "node:fs";
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
  return id && ts.isStringLiteral(id) ? id.text : undefined;
}

function containsReset(node: ts.Node): boolean {
  if (viCall(node, "resetModules")) return true;
  return ts.forEachChild(node, containsReset) ?? false;
}

function violations(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const mocked = new Set<string>();
  const unmocked = new Set<string>();
  const unknownMocks: string[] = [];
  const graphMocks: string[] = [];
  const resets: number[] = [];
  const imports: number[] = [];
  let hasMockCall = false;
  let exitReset = false;

  function visit(node: ts.Node): void {
    if (viCall(node, "doMock")) {
      const id = literalId(node);
      if (id === undefined) unknownMocks.push("vi.doMock(<non-literal id>)");
      else mocked.add(id);
    } else if (viCall(node, "doUnmock")) {
      const id = literalId(node);
      if (id !== undefined) unmocked.add(id);
    } else if (viCall(node, "mock")) {
      hasMockCall = true;
      const id = literalId(node);
      if (id && /(?:^@\/|\/src\/)lib\/db\/client(?:\.ts)?$/.test(id)) graphMocks.push(`vi.mock(${JSON.stringify(id)})`);
    } else if (viCall(node, "resetModules")) {
      resets.push(node.getStart(ast));
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      imports.push(node.getStart(ast));
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && (node.expression.text === "afterEach" || node.expression.text === "afterAll")
      && node.arguments[0] && containsReset(node.arguments[0])) exitReset = true;
    if (ts.isTryStatement(node) && node.finallyBlock && containsReset(node.finallyBlock)) exitReset = true;
    ts.forEachChild(node, visit);
  }
  visit(ast);

  const errors: string[] = [];
  for (const call of unknownMocks) {
    errors.push(`${file}: ${call} needs a literal id so the guard can verify its matching vi.doUnmock(<same id>)`);
  }
  for (const id of mocked) {
    if (!unmocked.has(id)) errors.push(`${file}: vi.doMock(${JSON.stringify(id)}) needs vi.doUnmock(${JSON.stringify(id)}) in this file`);
  }
  if ((mocked.size > 0 || unknownMocks.length > 0) && !exitReset) graphMocks.push("vi.doMock(...)");
  if (hasMockCall && resets.some((reset) => imports.some((importAt) => importAt > reset)) && !exitReset) {
    graphMocks.push("vi.resetModules() followed by dynamic import(...)");
  }
  if (graphMocks.length > 0 && !exitReset) {
    errors.push(`${file}: ${graphMocks.join(", ")} needs vi.resetModules() in afterEach/afterAll or finally; beforeEach is not exit cleanup`);
  }
  return errors;
}

it("keeps module mocks and module graphs self-contained in every test file", () => {
  const errors = testFiles("tests").sort().flatMap(violations);
  expect(errors, "mock hygiene violations; repair each named test file").toEqual([]);
});
