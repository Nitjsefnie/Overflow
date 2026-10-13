import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * The failure answers each documented route can give (issue 1056), derived
 * statically for the HTTP surface snapshot's `failures` section.
 *
 * Every HTTP failure answer in src/ is built by `errorResponse` in
 * src/lib/http/error-response.ts (tests/lib/http/error-response.test.ts keeps
 * it the only envelope implementation). For a route key "METHOD /path" the
 * walk starts at the module Next serves that path from,
 * src/app/<path>/route.ts (a "<id>" segment is the "[id]" directory), and
 * follows its import graph:
 *
 * - followed: static `import` and `export … from` declarations, `import x =
 *   require(…)`, direct `require(…)` (transparent wrappers are normalized),
 *   and `import(…)` with a literal specifier, whose specifier is
 *   `@/…` (src/), `./…` or `../…` and resolves to a .ts/.tsx module under src/
 *   (as written, or with .ts, .tsx, /index.ts or /index.tsx appended);
 * - not followed: `import type` / `export type` declarations (erased at
 *   runtime), package specifiers, modules outside src/, and non-TypeScript
 *   files (JSON);
 * - refused (the derivation throws naming file:line): an `import(…)` whose
 *   specifier is not a literal (also refused for `require(…)`), and an
 *   `@/`/relative specifier that resolves to nothing. Free require references
 *   other than direct calls, module.require/module aliases, and createRequire
 *   constructors or loader namespaces are refused. Locally bound names and
 *   erased type references are distinguished by TypeScript symbol identity.
 *   Type-only declarations/specifiers never enter the runtime reference walk;
 *   globalThis/global/self require properties are refused at their access.
 *
 * In every reached module each call to `errorResponse` is recorded as
 * "<status> <CODE>", plus " +<key>" for each field of a literal `extra`
 * option, sorted. The status and code must each be a literal or an
 * identifier bound to a `const` with a literal initializer in the same
 * module; anything else — a parameter, an `error.code`, an imported const, a
 * spread, a non-literal options or extra object — throws naming file:line,
 * and the remedy is to make the call site literal. The helper referenced
 * other than by a direct named-import call (passed as a value, imported as a
 * namespace/default, re-exported, or aliased locally) throws too. Direct
 * dynamic imports, bare require calls and import-equals of the helper module are refused at the
 * import, regardless of await, destructuring, property access or .then use.
 * Named imports (including renamed imports) are the only supported helper
 * bindings. Any use of the envelope builder `errorEnvelope` outside the
 * helper module also throws: it would answer a failure the walk cannot see.
 *
 * The granularity is the module, not the code path: every helper call in
 * every module a route reaches counts for that route, whichever handler or
 * branch actually makes it. So a route module's methods share one set, and a
 * shared module (the origin guard, the member gate) contributes every answer
 * it can give to every route that imports it. That over-inclusion is
 * conservative: an answer recorded for a route is one its code can reach,
 * and removing it from the recording is a breaking change.
 */

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const helperModule = "src/lib/http/error-response.ts";
const helperName = "errorResponse";
const builderName = "errorEnvelope";

/** The module Next serves a route key's path from, relative to the repository root. */
export function routeModulePath(routeKey: string): string {
  const path = routeKey.split(" ")[1];
  if (path === undefined || !path.startsWith("/")) {
    throw new Error(`Unrecognized route key ${JSON.stringify(routeKey)}; expected "METHOD /path".`);
  }
  return `src/app${path.replace(/<([^>/]+)>/g, "[$1]")}/route.ts`;
}

function location(root: string, source: ts.SourceFile, node: ts.Node): string {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${relative(root, source.fileName).split(sep).join("/")}:${line + 1}`;
}

function parse(file: string): ts.SourceFile {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);
}

/** The followed module a specifier names, or undefined when the walk does not follow it. */
function resolveModule(root: string, from: ts.SourceFile, node: ts.Node, specifier: string): string | undefined {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = join(root, "src", specifier.slice(2));
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = resolve(dirname(from.fileName), specifier);
  } else {
    return undefined;
  }
  if (!base.startsWith(join(root, "src") + sep)) return undefined;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return /\.tsx?$/.test(candidate) ? candidate : undefined;
    }
  }
  throw new Error(`${location(root, from, node)}: import ${JSON.stringify(specifier)} resolves to no module.`);
}

type ModuleReference = { node: ts.Node; specifier: string; declaration?: ts.ImportDeclaration | ts.ExportDeclaration };

/** Bind the single parsed module before graph traversal; no libraries or unresolved imports are loaded. */
function sourceChecker(source: ts.SourceFile): ts.TypeChecker {
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, jsx: ts.JsxEmit.Preserve };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (file) => file === source.fileName ? source : undefined;
  return ts.createProgram([source.fileName], options, host).getTypeChecker();
}

/** The enclosing transparent wrappers, so a loader reference can be attributed to its call. */
function outerExpression(node: ts.Expression): ts.Expression {
  let outer = node;
  while ((ts.isParenthesizedExpression(outer.parent) || ts.isAsExpression(outer.parent) ||
      ts.isSatisfiesExpression(outer.parent) || ts.isTypeAssertionExpression(outer.parent) ||
      ts.isNonNullExpression(outer.parent)) && outer.parent.expression === outer) {
    outer = outer.parent;
  }
  return outer;
}

function referenceSymbol(checker: ts.TypeChecker, node: ts.Identifier): ts.Symbol | undefined {
  return ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent)
    : ts.isExportSpecifier(node.parent) ? checker.getExportSpecifierLocalTargetSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
}

/** Declaration/property names are not references to a free runtime binding. */
function isRuntimeReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  return !((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent)) && parent.name === node));
}

function isFreeLoader(symbol: ts.Symbol | undefined): boolean {
  return symbol === undefined || (symbol.declarations ?? []).some((declaration) =>
    (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) !== 0);
}

/** Inline type specifiers carry no runtime edge; empty import/export lists retain side effects. */
function onlyTypeSpecifiers(bindings: ts.NamedImports | ts.NamedExports): boolean {
  return bindings.elements.length > 0 && bindings.elements.every((binding) => binding.isTypeOnly);
}

function isGlobalHost(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  const host = unwrap(expression);
  if (!ts.isIdentifier(host) || !["globalThis", "global", "self"].includes(host.text)) return false;
  const symbol = referenceSymbol(checker, host);
  // globalThis is a compiler intrinsic with no declaration, rather than a local binding.
  return isFreeLoader(symbol) || (symbol?.declarations?.length ?? 0) === 0;
}

/** Every runtime module reference, including unsupported Node loader operations that must refuse. */
function moduleReferences(
  root: string,
  source: ts.SourceFile,
  checker: ts.TypeChecker = sourceChecker(source),
): ModuleReference[] {
  const references: ModuleReference[] = [];
  const constructors = new Set<ts.Symbol>();
  const loaderNamespaces = new Set<ts.Symbol>();
  const nodeModule = (name: string): boolean => name === "node:module" || name === "module";
  const refuse = (node: ts.Node, operation: string): never => {
    throw new Error(`${location(root, source, node)}: ${operation} cannot be attributed to a static module; ` +
      'use named imports or a direct require("<static specifier>") so HTTP failure answers can be recorded.');
  };
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly ||
        !ts.isStringLiteral(statement.moduleSpecifier) || !nodeModule(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    for (const name of [clause?.name, bindings && ts.isNamespaceImport(bindings) ? bindings.name : undefined]) {
      const symbol = name && checker.getSymbolAtLocation(name);
      if (symbol) loaderNamespaces.add(symbol);
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (binding.isTypeOnly) continue;
        const imported = (binding.propertyName ?? binding.name).text;
        const symbol = checker.getSymbolAtLocation(binding.name);
        if (symbol && imported === "createRequire") constructors.add(symbol);
        if (symbol && ["default", "Module", "*"].includes(imported)) loaderNamespaces.add(symbol);
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) ||
        ((ts.isExportSpecifier(node) || ts.isImportSpecifier(node)) && node.isTypeOnly)) return;
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings) && onlyTypeSpecifiers(bindings))) return;
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        references.push({ node, specifier: node.moduleSpecifier.text, declaration: node });
      }
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause) && onlyTypeSpecifiers(node.exportClause))) return;
      if (node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
        if (nodeModule(node.moduleSpecifier.text) && (!node.exportClause || !ts.isNamedExports(node.exportClause) ||
            node.exportClause.elements.some((item) => !item.isTypeOnly &&
              ["createRequire", "Module", "default"].includes((item.propertyName ?? item.name).text)))) {
          refuse(node, "a re-export of Node's CommonJS loader");
        }
        references.push({ node, specifier: node.moduleSpecifier.text, declaration: node });
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference) &&
          ts.isStringLiteral(node.moduleReference.expression)) {
        if (nodeModule(node.moduleReference.expression.text)) refuse(node, "an import-equals of Node's CommonJS loader");
        references.push({ node, specifier: node.moduleReference.expression.text });
      }
      return;
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const member = ts.isPropertyAccessExpression(node) ? node.name.text
        : literalOf(node.argumentExpression, "string");
      if (member === "require" && isGlobalHost(node.expression, checker)) {
        return refuse(node, "a global require property reference");
      }
    } else if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const isRequire = ts.isIdentifier(callee) && callee.text === "require" && isFreeLoader(referenceSymbol(checker, callee));
      if (callee.kind === ts.SyntaxKind.ImportKeyword || isRequire) {
        const argument = node.arguments[0];
        if (argument === undefined || !(ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
          return refuse(node, `${isRequire ? "require" : "import"}() without a literal specifier`);
        }
        if (nodeModule(argument.text)) return refuse(node, "a dynamic load of Node's CommonJS loader");
        references.push({ node, specifier: argument.text });
      }
    } else if (ts.isIdentifier(node) && isRuntimeReference(node)) {
      const symbol = referenceSymbol(checker, node);
      if ((symbol !== undefined && constructors.has(symbol)) || (isFreeLoader(symbol) && node.text === "createRequire")) {
        return refuse(node, "a createRequire reference");
      }
      if ((symbol !== undefined && loaderNamespaces.has(symbol)) || (isFreeLoader(symbol) && node.text === "module")) {
        return refuse(node, "a Node module loader reference");
      }
      if (isFreeLoader(symbol) && node.text === "require") {
        const expression = outerExpression(node);
        if (!ts.isCallExpression(expression.parent) || expression.parent.expression !== expression) {
          return refuse(node, "a require value or alias");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

function unwrap(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression)
    ? unwrap(expression.expression)
    : expression;
}

function literalOf(expression: ts.Expression, kind: "number" | "string"): number | string | undefined {
  const node = unwrap(expression);
  if (kind === "number" && ts.isNumericLiteral(node)) return Number(node.text);
  if (kind === "string" && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  return undefined;
}

/** A literal argument, or an identifier bound to a same-module const with a literal initializer. */
function staticArgument(
  checker: ts.TypeChecker,
  source: ts.SourceFile,
  expression: ts.Expression,
  kind: "number" | "string",
): number | string | undefined {
  const direct = literalOf(expression, kind);
  if (direct !== undefined) return direct;
  const node = unwrap(expression);
  if (!ts.isIdentifier(node)) return undefined;
  const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
  if (
    declaration === undefined || !ts.isVariableDeclaration(declaration) ||
    declaration.getSourceFile() !== source || declaration.initializer === undefined ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return undefined;
  }
  return literalOf(declaration.initializer, kind);
}

function staticName(name: ts.PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) ||
      ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) return literalOf(name.expression, "string") as string | undefined;
  return undefined;
}

/** The extra envelope field names a call's literal options pass. */
function extraKeys(root: string, source: ts.SourceFile, call: ts.CallExpression): string[] {
  const options = call.arguments[3];
  if (options === undefined) return [];
  const refuse = (node: ts.Node, what: string): never => {
    throw new Error(
      `${location(root, source, node)}: ${helperName}'s ${what}; pass a literal options object ` +
        "so the HTTP surface derivation can record the failure answer's extra fields.",
    );
  };
  const literal = unwrap(options);
  if (!ts.isObjectLiteralExpression(literal)) return refuse(options, "options are not an object literal");
  const keys: string[] = [];
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) return refuse(property, "options spread another object");
    const name = staticName(property.name);
    if (name === undefined) return refuse(property, "options name a computed property");
    if (name !== "extra") continue;
    const extra = ts.isPropertyAssignment(property) ? unwrap(property.initializer) : undefined;
    if (extra === undefined || !ts.isObjectLiteralExpression(extra)) {
      return refuse(property, "extra option is not an object literal");
    }
    for (const field of extra.properties) {
      if (ts.isSpreadAssignment(field)) return refuse(field, "extra option spreads another object");
      const key = staticName(field.name);
      if (key === undefined) return refuse(field, "extra option names a computed field");
      keys.push(key);
    }
  }
  return [...new Set(keys)].sort();
}

function failureAnswer(
  root: string,
  checker: ts.TypeChecker,
  source: ts.SourceFile,
  call: ts.CallExpression,
): string {
  const [status, code] = call.arguments;
  if (call.arguments.some(ts.isSpreadElement) || status === undefined || code === undefined) {
    throw new Error(
      `${location(root, source, call)}: ${helperName} is called without a literal status and code; ` +
        "make the call site literal so the HTTP surface derivation can record the failure answer.",
    );
  }
  const statusValue = staticArgument(checker, source, status, "number");
  const codeValue = staticArgument(checker, source, code, "string");
  for (const [value, argument, what] of [[statusValue, status, "status"], [codeValue, code, "code"]] as const) {
    if (value === undefined) {
      throw new Error(
        `${location(root, source, argument)}: ${helperName}'s ${what} is not a literal or a same-module ` +
          "const with a literal initializer; make the call site literal so the HTTP surface derivation " +
          "can record the failure answer.",
      );
    }
  }
  return [`${statusValue} ${codeValue}`, ...extraKeys(root, source, call).map((key) => `+${key}`)].join(" ");
}

/** The failure answers one module's own helper calls give. */
function moduleFailureAnswers(root: string, checker: ts.TypeChecker, source: ts.SourceFile): string[] {
  const helperFile = join(root, helperModule);
  const bindings = new Map<ts.Symbol, string>();
  for (const reference of moduleReferences(root, source, checker)) {
    const declaration = reference.declaration;
    if (resolveModule(root, source, reference.node, reference.specifier) !== helperFile) {
      continue;
    }
    if (declaration === undefined) {
      throw new Error(
        `${location(root, source, reference.node)}: dynamically imports, requires or import-equals ${helperModule}; ` +
          `import { ${helperName} } and call it directly so the HTTP surface derivation can record the failure answers.`,
      );
    }
    if (ts.isExportDeclaration(declaration)) {
      throw new Error(
        `${location(root, source, declaration)}: re-exports from ${helperModule}; call ${helperName} directly ` +
          "so the HTTP surface derivation can record the failure answer.",
      );
    }
    const named = declaration.importClause?.namedBindings;
    if (declaration.importClause?.name !== undefined || (named !== undefined && !ts.isNamedImports(named))) {
      throw new Error(
        `${location(root, source, declaration)}: imports ${helperModule} other than by name; ` +
          `import { ${helperName} } so the HTTP surface derivation can record the failure answers.`,
      );
    }
    for (const specifier of named?.elements ?? []) {
      if (specifier.isTypeOnly) continue;
      const imported = (specifier.propertyName ?? specifier.name).text;
      if (imported !== helperName && imported !== builderName) {
        throw new Error(
          `${location(root, source, specifier)}: unsupported value import ${JSON.stringify(imported)} from ` +
            `${helperModule}; import { ${helperName} } so the HTTP surface derivation can attribute every call.`,
        );
      }
      const symbol = checker.getSymbolAtLocation(specifier.name);
      if (symbol !== undefined) {
        bindings.set(symbol, imported);
      }
    }
  }
  if (bindings.size === 0) return [];

  const localNames = new Set([...bindings.keys()].map((symbol) => symbol.name));
  const answers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && localNames.has(node.text)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : ts.isExportSpecifier(node.parent)
          ? checker.getExportSpecifierLocalTargetSymbol(node.parent)
          : checker.getSymbolAtLocation(node);
      const imported = symbol === undefined ? undefined : bindings.get(symbol);
      if (imported === builderName) {
        throw new Error(
          `${location(root, source, node)}: uses ${builderName} outside ${helperModule}; answer the failure ` +
            `with ${helperName} so the HTTP surface derivation can record it.`,
        );
      }
      if (imported === helperName) {
        if (!ts.isCallExpression(node.parent) || node.parent.expression !== node) {
          throw new Error(
            `${location(root, source, node)}: references ${helperName} other than by calling it; call it ` +
              "directly so the HTTP surface derivation can record the failure answer.",
          );
        }
        answers.push(failureAnswer(root, checker, source, node.parent));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return answers;
}

/**
 * The sorted, de-duplicated failure answers of each route key, from the
 * route's module and every module its imports reach within src/. `root` is
 * the repository root holding src/ (the default is this checkout).
 */
export function deriveRouteFailures(
  routeKeys: readonly string[],
  root: string = defaultRoot,
): Record<string, string[]> {
  const parsed = new Map<string, ts.SourceFile>();
  const edges = new Map<string, string[]>();
  const reachedByRoute = new Map<string, Set<string>>();
  for (const key of routeKeys) {
    const entry = join(root, routeModulePath(key));
    if (!existsSync(entry)) {
      throw new Error(`${key}: no route module at ${routeModulePath(key)}.`);
    }
    const reached = new Set<string>([entry]);
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (!edges.has(file)) {
        const source = parsed.get(file) ?? parse(file);
        parsed.set(file, source);
        edges.set(file, moduleReferences(root, source).flatMap((reference) =>
          resolveModule(root, source, reference.node, reference.specifier) ?? []));
      }
      for (const next of edges.get(file)!) {
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
    reachedByRoute.set(key, reached);
  }

  const files = [...new Set([...reachedByRoute.values()].flatMap((reached) => [...reached]))];
  const program = ts.createProgram(files, { noLib: true, noResolve: true, jsx: ts.JsxEmit.Preserve });
  const checker = program.getTypeChecker();
  const helperFile = join(root, helperModule);
  const answersByFile = new Map(files.map((file) => [
    file,
    file === helperFile ? [] : moduleFailureAnswers(root, checker, program.getSourceFile(file)!),
  ]));

  return Object.fromEntries(routeKeys.map((key) => [
    key,
    [...new Set([...reachedByRoute.get(key)!].flatMap((file) => answersByFile.get(file)!))].sort(),
  ]));
}
