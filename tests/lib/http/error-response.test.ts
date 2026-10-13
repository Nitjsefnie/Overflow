import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createRouteRateGate } from "@/lib/security/route-rate-limit";
import { createRateLimiter } from "@/lib/webhooks/rate-limit";

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
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && (ts.isStringLiteral(name.expression) || ts.isNoSubstitutionTemplateLiteral(name.expression))) {
    return name.expression.text;
  }
  return undefined;
}

function unwrap(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression)
    ? unwrap(expression.expression) : expression;
}

function envelopeCopies(source: ts.SourceFile, checker: ts.TypeChecker): string[] {
  const file = source.fileName;
  const copies: string[] = [];
  const record = (node: ts.Node, kind: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    copies.push(`${path.relative(root, file)}:${line + 1}: ${kind}`);
  };
  type Shape = Map<string, Shape | undefined>;
  type Bindings = Map<ts.Symbol, Shape | undefined>;
  type Write = { keys: string[]; value: ts.Expression; spread: boolean };
  const writes = new Map<ts.Symbol, Write[]>();
  const member = (expression: ts.Expression): { object: ts.Expression; key: string } | undefined => {
    expression = unwrap(expression);
    if (ts.isPropertyAccessExpression(expression)) {
      return { object: expression.expression, key: expression.name.text };
    }
    if (ts.isElementAccessExpression(expression) &&
        (ts.isStringLiteral(expression.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression))) {
      return { object: expression.expression, key: expression.argumentExpression.text };
    }
    return undefined;
  };
  const assign = (target: ts.Expression, value: ts.Expression, spread = false) => {
    const keys: string[] = [];
    let access;
    while ((access = member(target)) !== undefined) {
      keys.unshift(access.key);
      target = access.object;
    }
    target = unwrap(target);
    if (!ts.isIdentifier(target)) return;
    const symbol = checker.getSymbolAtLocation(target);
    if (symbol === undefined) return;
    const entries = writes.get(symbol) ?? [];
    entries.push({ keys, value, spread });
    writes.set(symbol, entries);
  };
  const isAssign = (node: ts.CallExpression) => {
    const access = member(node.expression);
    const receiver = access === undefined ? undefined : unwrap(access.object);
    return access?.key === "assign" && receiver !== undefined && ts.isIdentifier(receiver) && receiver.text === "Object";
  };
  const collectWrites = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      assign(node.left, node.right);
    }
    if (ts.isCallExpression(node) && isAssign(node) && node.arguments.length > 0) {
      for (const argument of node.arguments.slice(1)) assign(node.arguments[0], argument, true);
    }
    ts.forEachChild(node, collectWrites);
  };
  collectWrites(source);
  // Shapes are construction evidence, not final runtime values. Later writes
  // and spreads may add facts, but must never erase an earlier envelope.
  const merge = (target: Shape, value: Shape | undefined): Shape => {
    for (const [key, field] of value ?? []) {
      const previous = target.get(key);
      target.set(key, field === undefined ? previous : merge(new Map(previous), field));
    }
    return target;
  };
  const symbolOf = (node: ts.Identifier) => ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
  const localDeclaration = (node: ts.Identifier) => {
    const declaration = symbolOf(node)?.valueDeclaration;
    return declaration?.getSourceFile() === source ? declaration : undefined;
  };
  const functionValue = (expression: ts.Expression, seen = new Set<ts.Node>()):
    ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined => {
    expression = unwrap(expression);
    if (seen.has(expression)) return undefined;
    seen = new Set(seen).add(expression);
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
    if (!ts.isIdentifier(expression)) return undefined;
    const declaration = localDeclaration(expression);
    if (declaration !== undefined && ts.isFunctionDeclaration(declaration)) return declaration;
    return declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
      ? functionValue(declaration.initializer, seen) : undefined;
  };
  // Resolve syntax and local symbols, not inferred types: imported/RPC error types
  // alone are not evidence of a locally constructed HTTP error envelope.
  const resolve = (expression: ts.Expression, seen = new Set<ts.Node>(), bindings: Bindings = new Map()): Shape | undefined => {
    expression = unwrap(expression);
    if (seen.has(expression)) return undefined;
    seen = new Set(seen).add(expression);
    if (ts.isObjectLiteralExpression(expression)) {
      const shape: Shape = new Map();
      for (const property of expression.properties) {
        if (ts.isSpreadAssignment(property)) {
          merge(shape, resolve(property.expression, seen, bindings));
        } else {
          const key = propertyName(property.name);
          if (key === undefined) continue;
          const value = ts.isPropertyAssignment(property) ? property.initializer
            : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
          merge(shape, new Map([[key, value === undefined ? undefined : resolve(value, seen, bindings)]]));
        }
      }
      return shape;
    }
    if (ts.isIdentifier(expression)) {
      const symbol = symbolOf(expression);
      if (symbol === undefined) return undefined;
      if (bindings.has(symbol)) return bindings.get(symbol);
      const declaration = localDeclaration(expression);
      if (declaration === undefined || !ts.isVariableDeclaration(declaration)) return undefined;
      let shape = declaration.initializer === undefined ? undefined : resolve(declaration.initializer, seen, bindings);
      for (const write of writes.get(symbol) ?? []) {
        shape ??= new Map();
        let target = shape;
        for (const key of write.keys.slice(0, write.spread ? undefined : -1)) {
          let child = target.get(key);
          if (child === undefined) target.set(key, child = new Map());
          target = child;
        }
        const value = resolve(write.value, seen, bindings);
        if (write.spread || write.keys.length === 0) merge(target, value);
        else merge(target, new Map([[write.keys.at(-1)!, value]]));
      }
      return shape;
    }
    const access = member(expression);
    if (access !== undefined) return resolve(access.object, seen, bindings)?.get(access.key);
    if (ts.isConditionalExpression(expression)) {
      return merge(merge(new Map(), resolve(expression.whenTrue, seen, bindings)), resolve(expression.whenFalse, seen, bindings));
    }
    if (!ts.isCallExpression(expression)) return undefined;
    if (isAssign(expression)) {
      return expression.arguments.reduce<Shape>((shape, value) => merge(shape, resolve(value, seen, bindings)), new Map());
    }
    const fn = functionValue(expression.expression);
    if (fn?.body === undefined) return undefined;
    const localBindings = new Map(bindings);
    fn.parameters.forEach((parameter, index) => {
      if (!ts.isIdentifier(parameter.name)) return;
      const symbol = checker.getSymbolAtLocation(parameter.name);
      const argument = expression.arguments[index] ?? parameter.initializer;
      if (symbol !== undefined) localBindings.set(symbol, argument === undefined ? undefined : resolve(argument, seen, bindings));
    });
    if (!ts.isBlock(fn.body)) return resolve(fn.body, seen, localBindings);
    const shape: Shape = new Map();
    const returns = (node: ts.Node) => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression !== undefined) {
        merge(shape, resolve(node.expression, seen, localBindings));
      } else ts.forEachChild(node, returns);
    };
    returns(fn.body);
    return shape;
  };
  const isDetail = (shape: Shape | undefined) => shape?.has("code") && shape.has("message");
  const check = (node: ts.Node, shape: Shape | undefined) => {
    if (isDetail(shape?.get("error"))) record(node, "hand-built error envelope");
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
    if (ts.isObjectLiteralExpression(node)) check(node, resolve(node));
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === "error" &&
        isDetail(resolve(node.initializer))) {
      record(node, "hand-built error envelope");
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) check(node, resolve(node.name));
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        member(node.left)?.key === "error" && isDetail(resolve(node.right))) {
      record(node, "hand-built error envelope");
    }
    if (ts.isCallExpression(node)) {
      if (isAssign(node)) check(node, resolve(node));
      const access = member(node.expression);
      const receiver = access === undefined ? undefined : unwrap(access.object);
      if (access !== undefined && receiver !== undefined && ts.isIdentifier(receiver) &&
          ((receiver.text === "Response" && access.key === "json") ||
           (receiver.text === "JSON" && access.key === "stringify")) && node.arguments[0] !== undefined) {
        check(node, resolve(node.arguments[0]));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(copies)];
}

function scan(files: string[], fixture?: string): string[] {
  const host = ts.createCompilerHost({});
  if (fixture !== undefined) {
    host.getSourceFile = (file) => file === files[0]
      ? ts.createSourceFile(file, fixture, ts.ScriptTarget.Latest, true) : undefined;
  }
  const program = ts.createProgram(files, { noLib: true, noResolve: true }, host);
  const checker = program.getTypeChecker();
  return files.flatMap((file) => envelopeCopies(program.getSourceFile(file)!, checker));
}

const bypasses = [
  ["local inner binding", 'const detail = { code: "REJECTED", message: "Denied." }; Response.json({ error: detail });'],
  ["nested literal spread", 'Response.json({ error: { ...{ code: "REJECTED", message: "Denied." } } });'],
  ["spread binding", 'const detail = { code: "REJECTED", message: "Denied." }; Response.json({ error: { ...detail } });'],
  ["outer body binding and stringify", 'const detail = { code: "REJECTED", message: "Denied." }; const body = { error: detail }; new Response(JSON.stringify(body));'],
  ["outer body spread", 'const detail = { code: "REJECTED", message: "Denied." }; const body = { error: detail }; Response.json({ ...body });'],
  ["shorthand error property", 'const error = { code: "REJECTED", message: "Denied." }; Response.json({ error });'],
  ["alias chain", 'const detail = { code: "REJECTED", message: "Denied." }; const alias = detail; Response.json({ error: alias });'],
  ["property assignment after construction", 'const body = {}; body.error = { code: "REJECTED", message: "Denied." }; Response.json(body);'],
  ["inner properties assigned after construction", 'const detail = {}; detail.code = "REJECTED"; detail.message = "Denied."; Response.json({ error: detail });'],
  ["Object.assign inner object", 'Response.json({ error: Object.assign({}, { code: "REJECTED" }, { message: "Denied." }) });'],
  ["Object.assign into a body binding", 'const error = { code: "REJECTED", message: "Denied." }; const body = {}; Object.assign(body, { error }); new Response(JSON.stringify(body));'],
  ["helper returning inner object", 'function detail() { return { code: "REJECTED", message: "Denied." }; } Response.json({ error: detail() });'],
  ["arrow helper and function alias", 'const make = () => ({ code: "REJECTED", message: "Denied." }); const alias = make; Response.json({ error: alias() });'],
  ["helper parameter forwarding", 'function wrap(detail) { return { error: detail }; } Response.json(wrap({ code: "REJECTED", message: "Denied." }));'],
  ["reordered differently named helper", 'function copiedFailure(status, code, message) { const detail = { message, code }; return Response.json({ error: detail }, { status }); }'],
  ["static computed and template keys", 'const detail = { ["code"]: "REJECTED", [`message`]: "Denied." }; Response.json({ [`error`]: detail });'],
  ["inner properties written through a cast target", 'const detail = {}; (detail as Record<string, string>).code = "REJECTED"; (detail as Record<string, string>).message = "Denied."; Response.json({ error: detail });'],
  ["inner properties written through a non-null target", 'const detail = {}; detail!.code = "REJECTED"; detail!.message = "Denied."; Response.json({ error: detail });'],
  ["Object.assign into a cast target", 'const detail = {}; Object.assign(detail as object, { code: "REJECTED", message: "Denied." }); Response.json({ error: detail });'],
  ["Object.assign through a cast receiver", 'const detail = {}; (Object as ObjectConstructor).assign(detail, { code: "REJECTED", message: "Denied." }); Response.json({ error: detail });'],
  ["Response.json through a cast receiver", 'function wrap(detail) { return { error: detail }; } (Response as typeof Response).json(wrap({ code: "REJECTED", message: "Denied." }));'],
] as const;

const monotoneCases = [
  ["the reviewed non-null override plant", 'const detail = { code: "UNAUTHENTICATED", message: "The supplied API token was not accepted." }; const overrides: Record<string, unknown> = { error: detail! }; Response.json({ error: { code: "UNAUTHENTICATED", message: "The supplied API token was not accepted." }, ...overrides }, { status: 401 });'],
  ["a non-null local detail binding", 'const detail = { code: "REJECTED", message: "Denied." }; Response.json({ error: detail! });'],
  ["a direct literal before an unknown spread", 'declare const unknownValue: unknown; const overrides = { error: unknownValue }; Response.json({ error: { code: "REJECTED", message: "Denied." }, ...overrides });'],
  ["a direct literal before a later unknown property", 'declare const unknownValue: unknown; Response.json({ error: { code: "REJECTED", message: "Denied." }, error: unknownValue });'],
  ["a forwarded detail before an unknown spread", 'declare const unknownValue: unknown; function wrap(detail) { return { error: detail, ...{ error: unknownValue } }; } Response.json(wrap({ code: "REJECTED", message: "Denied." }));'],
  ["a forwarded detail before a later partial property", 'function wrap(detail) { return { error: detail, error: { hint: "replacement" } }; } Response.json(wrap({ code: "REJECTED", message: "Denied." }));'],
  ["a forwarded body before an unknown property write", 'declare const unknownValue: unknown; function wrap(detail) { const body = { error: detail }; body.error = unknownValue; return body; } Response.json(wrap({ code: "REJECTED", message: "Denied." }));'],
  ["a forwarded detail before a partial Object.assign replacement", 'function wrap(detail) { return Object.assign({ error: detail }, { error: { hint: "replacement" } }); } Response.json(wrap({ code: "REJECTED", message: "Denied." }));'],
  ["a forwarded detail before a later conditional shape", 'declare const flag: boolean; function wrap(detail) { return flag ? { error: detail } : { error: { hint: "replacement" } }; } Response.json(wrap({ code: "REJECTED", message: "Denied." }));'],
] as const;

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
    const copies = scan(sourceFiles(path.join(root, "src"))
      .filter((file) => path.relative(root, file) !== helperPath));
    expect(copies).toEqual([]);
  });

  it.each(bypasses)("recognizes %s as another envelope construction", (_label, fixture) => {
    expect(scan([path.join(root, "src/guard-fixture.ts")], fixture)).not.toEqual([]);
  });

  it.each(monotoneCases)("retains envelope evidence for %s", (_label, fixture) => {
    expect(scan([path.join(root, "src/guard-fixture.ts")], fixture)).not.toEqual([]);
  });

  it("preserves the real rate gate's 429 headers and body bytes", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const gate = createRouteRateGate({
        className: "export",
        limiter: createRateLimiter({ nowMs: () => 0 }),
        limits: { capacity: 1, refillPerMinute: 2 },
      });
      expect(gate("sample-member")).toBeNull();
      const response = gate("sample-member")!;
      expect(response.status).toBe(429);
      expect([...response.headers]).toEqual([
        ["content-type", "text/plain;charset=UTF-8"], ["retry-after", "30"],
      ]);
      expect(await response.text()).toBe('{"error":{"code":"RATE_LIMITED","message":"Too many requests of this kind. Retry after the number of seconds the Retry-After header names."}}');
    } finally {
      warning.mockRestore();
    }
  });
});
