import { writeSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * The string whose presence in a run's test files means the run needs the
 * shared postgres server. A consumer can import it through another helper,
 * so the scan follows local runtime dependencies as well as test files.
 */
export const SHARED_POSTGRES_MARKER = "startPostgresContainer";

function warnToStderr(message: string): void {
  writeSync(2, `${message}\n`);
}

const supportDirectory = dirname(fileURLToPath(import.meta.url));
const sourceDirectory = resolve(supportDirectory, "../../src");
const postgresProvider = join(supportDirectory, "postgres-container.ts");
const moduleExtensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"];

function runtimeDependencies(path: string, contents: string): { imports: string[]; requestsPostgres: boolean } {
  const imports: string[] = [];
  let requestsPostgres = false;
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) || ((ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) && node.isTypeOnly)) return;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const onlyTypes = clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly));
      if (onlyTypes) return;
      imports.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const onlyTypes = node.isTypeOnly || (clause && ts.isNamedExports(clause)
        && clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly));
      if (onlyTypes) return;
      imports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      imports.push(node.arguments[0].text);
    }
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && node.text === SHARED_POSTGRES_MARKER) requestsPostgres = true;
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(path, contents, ts.ScriptTarget.Latest));
  return { imports, requestsPostgres };
}

function dependencyPaths(path: string, specifier: string): string[] {
  const local = specifier.startsWith(".") ? join(dirname(path), specifier)
    : specifier.startsWith("@/") ? join(sourceDirectory, specifier.slice(2)) : undefined;
  if (local === undefined || local.split(sep).includes("node_modules")) return [];
  const extension = extname(local);
  if ([".json", ".css", ".scss", ".svg", ".sql", ".html"].includes(extension)) return [];
  // Bundler resolution accepts a JS specifier for a TypeScript source file.
  if (moduleExtensions.includes(extension)) {
    const replacements = extension === ".js" ? [".ts", ".tsx"]
      : extension === ".mjs" ? [".mts"] : extension === ".cjs" ? [".cts"] : [];
    return [...replacements.map((replacement) => local.slice(0, -extension.length) + replacement), local];
  }
  return [...moduleExtensions.map((extension) => local + extension),
    ...moduleExtensions.map((extension) => join(local, "index" + extension))];
}

/**
 * Whether any of the run's test files needs the shared postgres server
 * (issues 1070, 1146): checks the test files and their local runtime import
 * graph for the marker. Type-only imports do not request a database. The
 * provider module itself is a leaf: its definition of the startup API is not
 * a request to call it (it also exports database-free utilities). Read errors
 * on an individual file are no-match for that file plus a stderr warning —
 * a vanished file between spec resolution and the scan must not crash the
 * run, and must not silently decide a DB run needs no server. The empty list
 * is false (no files, no suite, no need): vitest resolves the specifications
 * before global setup and throws FilesNotFoundError on zero, so the reachable
 * cases are all non-empty, and a missed need fails a DB suite loudly while an
 * unneeded start is the defect this scan exists to prevent.
 *
 * Test files keep the original substring semantics (even a comment matches).
 * Dependencies require a runtime identifier or string reference: inherited comments
 * in config or documentation must not turn database-free suites into DB runs.
 */
export function runNeedsSharedPostgres(
  filePaths: readonly string[],
  readFile: (path: string) => string,
  warn: (message: string) => void = warnToStderr,
): boolean {
  const visited = new Set<string>();
  const testFiles = new Set(filePaths.map((path) => resolve(path)));
  const pending = filePaths.map((path) => [normalize(path)]).reverse();
  while (pending.length > 0) {
    const candidates = pending.pop()!;
    let resolved = false;
    let failure: unknown;
    for (const path of candidates) {
      const identity = resolve(path);
      if (visited.has(identity) || identity === postgresProvider) {
        resolved = true;
        break;
      }
      let contents: string;
      try {
        contents = readFile(path);
      } catch (error) {
        failure = error;
        continue;
      }
      resolved = true;
      visited.add(identity);
      if (testFiles.has(identity) && contents.includes(SHARED_POSTGRES_MARKER)) return true;
      const dependencies = runtimeDependencies(path, contents);
      if (dependencies.requestsPostgres) return true;
      for (const specifier of dependencies.imports.reverse()) {
        const paths = dependencyPaths(path, specifier);
        if (paths.length > 0) pending.push(paths);
      }
      break;
    }
    if (!resolved) warn(`shared-postgres need scan: could not read ${candidates[0]} (${String(failure)}); treating it as not needing the shared postgres`);
  }
  return false;
}
