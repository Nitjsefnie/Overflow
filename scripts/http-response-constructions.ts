import { relative, sep } from "node:path";
import ts from "typescript";
import type { DerivedAnswer } from "./http-surface-derive.ts";

/** Runtime observation: the real handler returned this answer under failure dependencies. */
export type NonEnvelopeObservation = { route: string; entry: string; handler: string; answer: DerivedAnswer };

function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) ? unwrap(node.expression) : node;
}

function name(node: ts.PropertyName | ts.Expression): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined;
}

/** Resolve local aliases without treating unrelated object methods as response factories. */
function responseClass(node: ts.Expression, checker: ts.TypeChecker, seen = new Set<ts.Symbol>()): boolean {
  node = unwrap(node);
  if (ts.isPropertyAccessExpression(node)) return ["Response", "NextResponse"].includes(node.name.text);
  if (!ts.isIdentifier(node)) return false;
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return ["Response", "NextResponse"].includes(node.text);
  if (seen.has(symbol)) return false;
  seen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isImportSpecifier(declaration)) return ["Response", "NextResponse"].includes((declaration.propertyName ?? declaration.name).text);
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) return responseClass(declaration.initializer, checker, seen);
  }
  return false;
}

function numbers(node: ts.Expression, checker: ts.TypeChecker, seen = new Set<ts.Symbol>()): number[] | undefined {
  node = unwrap(node);
  if (ts.isNumericLiteral(node)) return [Number(node.text)];
  if (ts.isConditionalExpression(node)) {
    const yes = numbers(node.whenTrue, checker, new Set(seen));
    const no = numbers(node.whenFalse, checker, new Set(seen));
    return yes && no ? [...new Set([...yes, ...no])] : undefined;
  }
  if (ts.isIdentifier(node)) {
    const symbol = checker.getSymbolAtLocation(node);
    const declaration = symbol?.valueDeclaration;
    if (symbol && !seen.has(symbol) && declaration && ts.isVariableDeclaration(declaration) &&
        declaration.initializer && (declaration.parent.flags & ts.NodeFlags.Const)) {
      seen.add(symbol);
      return numbers(declaration.initializer, checker, seen);
    }
  }
  return undefined;
}

function statuses(options: ts.Expression | undefined, checker: ts.TypeChecker): number[] | undefined {
  if (!options) return [200];
  options = unwrap(options);
  if (!ts.isObjectLiteralExpression(options)) return undefined;
  let result: number[] | undefined = [200];
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property) || !property.name || name(property.name) === undefined) return undefined;
    if (name(property.name) === "status") {
      const value = ts.isPropertyAssignment(property) ? property.initializer
        : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
      result = value ? numbers(value, checker) : undefined;
    }
  }
  return result;
}

function enclosingNames(node: ts.Node): string[] {
  const names: string[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)) && parent.name) names.push(parent.name.text);
  }
  return names;
}

type Site = { node: ts.Node; statuses: number[] | undefined; handlers: string[] };

/** Every response factory is inventoried, even latent calls and unresolved/conditional statuses. */
function sites(source: ts.SourceFile, checker: ts.TypeChecker): Site[] {
  const found: Site[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return;
    if (ts.isNewExpression(node) && responseClass(node.expression, checker)) {
      found.push({ node, statuses: statuses(node.arguments?.[1], checker), handlers: enclosingNames(node) });
    } else if (ts.isCallExpression(node)) {
      const expression = unwrap(node.expression);
      if ((ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
          responseClass(expression.expression, checker)) {
        const member = ts.isElementAccessExpression(expression) && expression.argumentExpression
          ? unwrap(expression.argumentExpression) : undefined;
        const method = ts.isPropertyAccessExpression(expression) ? expression.name.text
          : member && (ts.isStringLiteral(member) || ts.isNoSubstitutionTemplateLiteral(member)) ? member.text : undefined;
        found.push({ node, handlers: enclosingNames(node), statuses: method === "redirect"
          ? node.arguments[1] ? numbers(node.arguments[1], checker) : [302]
          : method === "error" ? [0]
          : ["json", "next", "rewrite"].includes(method ?? "")
            ? statuses(node.arguments[method === "next" ? 0 : 1], checker) : undefined });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Fail closed unless a non-envelope construction is covered by a real failure fixture.
 * A fixture names its returned handler (not a line number). Exactly one construction
 * may belong to that handler; more sites or unresolved statuses require new coverage
 * machinery rather than a module-wide exemption. All non-2xx alternatives must be observed.
 */
export function assertNonEnvelopeCoverage(
  root: string,
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  program: ts.Program,
  observations: readonly NonEnvelopeObservation[],
): void {
  const checker = program.getTypeChecker();
  for (const [route, files] of graph) {
    for (const file of files) {
      const path = relative(root, file).split(sep).join("/");
      if (path === "src/lib/http/error-response.ts") continue;
      const source = program.getSourceFile(file)!;
      const constructors = sites(source, checker);
      for (const site of constructors) {
        // This is a fetch-client response, never a server answer: the route graph
        // consumes/maps upstream errors. The exception is bound to that transport function.
        if (path === "src/lib/security/public-destination.ts" && site.handlers.includes("guardedFetch")) continue;
        if (site.statuses?.every((status) => status >= 200 && status < 300)) continue;
        const covered = observations.filter((observation) => observation.route === route &&
          path === `src/app${route.split(" ")[1]!.replace(/<([^>/]+)>/g, "[$1]")}/route.ts` &&
          site.handlers.includes(observation.handler) &&
          constructors.filter((candidate) => candidate.handlers.includes(observation.handler)).length === 1);
        const observed = new Set(covered.map((observation) => observation.answer.status));
        if (!site.statuses || !covered.length || site.statuses.some((status) =>
          (status < 200 || status >= 300) && !observed.has(status))) {
          const line = source.getLineAndCharacterOfPosition(site.node.getStart(source)).line + 1;
          throw new Error(`${path}:${line}: non-envelope response is not covered by a failure fixture; ` +
            "use errorResponse or add an invoked non-envelope failure fixture with resolved status alternatives.");
        }
      }
    }
  }
}
