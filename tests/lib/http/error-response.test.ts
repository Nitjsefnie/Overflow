import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const helperPath = "src/lib/http/error-response.ts";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.tsx?$/.test(file) ? [file] : [];
  });
}

function propertyName(name: ts.PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) {
    return name.expression.text;
  }
  return undefined;
}

function unwrap(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression)
    ? unwrap(expression.expression) : expression;
}

function envelopeCopies(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const copies: string[] = [];
  const record = (node: ts.Node, kind: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    copies.push(`${path.relative(root, file)}:${line + 1}: ${kind}`);
  };
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node)) && propertyName(node.name) === "errorResponse") {
      record(node, "local errorResponse implementation");
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.name.text === "errorResponse" && node.initializer !== undefined) {
      const value = unwrap(node.initializer);
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
        record(node, "local errorResponse implementation");
      }
    }
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === "error") {
      const value = unwrap(node.initializer);
      if (ts.isObjectLiteralExpression(value)) {
        const keys = value.properties.map((property) => propertyName(property.name));
        if (keys.includes("code") && keys.includes("message")) {
          record(node, "hand-built error envelope");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return copies;
}

describe("HTTP error envelope", () => {
  it("preserves status, headers, body bytes and code/message/extra key order", async () => {
    expect(existsSync(path.join(root, helperPath))).toBe(true);
    const { errorResponse, errorEnvelope } = await import("@/lib/http/error-response");
    const plain = errorResponse(403, "FORBIDDEN", "Denied.");
    expect(plain.status).toBe(403);
    expect([...plain.headers]).toEqual([["content-type", "application/json"]]);
    expect(await plain.text()).toBe('{"error":{"code":"FORBIDDEN","message":"Denied."}}');

    const response = errorResponse(409, "SPONSOR_BLOCKED", "Unregister first.", {
      extra: { repositories: ["example/project"], retryable: false },
      headers: { "Retry-After": "60", "X-Request-Id": "sample-request" },
    });
    expect(response.status).toBe(409);
    expect([...response.headers]).toEqual([
      ["content-type", "application/json"], ["retry-after", "60"], ["x-request-id", "sample-request"],
    ]);
    expect(await response.clone().json()).toEqual({
      error: { code: "SPONSOR_BLOCKED", message: "Unregister first.", repositories: ["example/project"], retryable: false },
    });
    expect(await response.text()).toBe('{"error":{"code":"SPONSOR_BLOCKED","message":"Unregister first.","repositories":["example/project"],"retryable":false}}');
    expect(errorEnvelope("FORBIDDEN", "Denied.")).toEqual({ error: { code: "FORBIDDEN", message: "Denied." } });
    expect(Object.keys(errorEnvelope("CONFLICT", "Retry.", { retryable: true }).error)).toEqual(["code", "message", "retryable"]);

    for (const headers of [
      new Headers({ "Content-Type": "text/plain;charset=UTF-8", "Retry-After": "20" }),
      [["Content-Type", "text/plain;charset=UTF-8"], ["Retry-After", "20"]] as [string, string][],
    ]) {
      const limited = errorResponse(429, "RATE_LIMITED", "Retry.", { headers });
      expect([...limited.headers]).toEqual([["content-type", "text/plain;charset=UTF-8"], ["retry-after", "20"]]);
      expect(limited.status).toBe(429);
      expect(await limited.text()).toBe('{"error":{"code":"RATE_LIMITED","message":"Retry."}}');
    }
  });

  it("keeps every HTTP error envelope implementation in the shared module", () => {
    const copies = sourceFiles(path.join(root, "src"))
      .filter((file) => path.relative(root, file) !== helperPath)
      .flatMap(envelopeCopies);
    expect(copies).toEqual([]);
  });
});
