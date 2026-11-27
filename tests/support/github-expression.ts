// The subset of GitHub Actions expressions the workflows use, evaluated as the runner does, and the step and job
// selection built on it. Anything outside the subset throws rather than reading as false; the evaluator's first rules
// are argued in tests/ci/verify-step-reachability.test.ts, and each later one (name case, rendering, job status) here.

export type WorkflowStep = { name?: string; id?: string; run?: string; uses?: string; with?: Record<string, unknown>; if?: unknown; "continue-on-error"?: unknown; };

export type ExpressionValue = string | number | boolean | null;

export type ActionsContext = Record<string, unknown>;

export type JobStatus = "success" | "failure" | "cancelled";

const CONTEXT_ROOTS = ["env", "github", "inputs", "job", "jobs", "matrix", "needs", "runner", "secrets", "steps", "strategy", "vars"];

const STATUS_FUNCTIONS: Record<string, (status: JobStatus) => boolean> = {
  success: (status) => status === "success", always: () => true, failure: (status) => status === "failure", cancelled: (status) => status === "cancelled",
};

type Token =
  | { kind: "punct"; text: string } | { kind: "string"; text: string; value: string } | { kind: "number"; text: string; value: number } | { kind: "word"; text: string } | { kind: "end"; text: "" };

// `-` is part of a name, as in `steps.detect-docs`: a property name, not a subtraction.
const WORD = /^[A-Za-z_][A-Za-z0-9_-]*/;
const NUMBER = /^-?[0-9]+(?:\.[0-9]+)?/;
const PUNCTUATION = ["(", ")", "!", "."];
const BINARY_PUNCTUATION = ["==", "!=", "&&", "||"];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "'") {
      const start = index;
      index += 1;
      let value = "";
      let terminated = false;
      while (index < source.length) {
        const inner = source[index];
        if (inner === "'") {
          // GitHub escapes a quote inside a string literal by doubling it.
          if (source[index + 1] === "'") {
            value += "'";
            index += 2;
            continue;
          }
          index += 1;
          terminated = true;
          break;
        }
        value += inner;
        index += 1;
      }
      if (!terminated) throw new Error(`unterminated string literal starting at offset ${start}`);
      tokens.push({ kind: "string", text: source.slice(start, index), value });
      continue;
    }
    if (/[0-9]/.test(character) || (character === "-" && /[0-9]/.test(source[index + 1] ?? ""))) {
      const matched = NUMBER.exec(source.slice(index))?.[0];
      if (!matched) throw new Error(`malformed number at offset ${index}`);
      index += matched.length;
      tokens.push({ kind: "number", text: matched, value: Number(matched) });
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const matched = WORD.exec(source.slice(index))?.[0];
      if (!matched) throw new Error(`malformed name at offset ${index}`);
      index += matched.length;
      tokens.push({ kind: "word", text: matched });
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (BINARY_PUNCTUATION.includes(pair)) {
      tokens.push({ kind: "punct", text: pair });
      index += 2;
      continue;
    }
    if (PUNCTUATION.includes(character)) {
      tokens.push({ kind: "punct", text: character });
      index += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(character)} at offset ${index}`);
  }
  tokens.push({ kind: "end", text: "" });
  return tokens;
}

type Node =
  | { kind: "literal"; value: ExpressionValue } | { kind: "status"; name: string } | { kind: "path"; segments: string[] } | { kind: "not"; operand: Node }
  | { kind: "and"; left: Node; right: Node } | { kind: "or"; left: Node; right: Node } | { kind: "compare"; operator: "==" | "!="; left: Node; right: Node };

function parseExpression(source: string): Node {
  const tokens = tokenize(source);
  let cursor = 0;
  const peek = () => tokens[cursor];
  const take = () => tokens[cursor++];

  function primary(): Node {
    const token = peek();
    if (token.kind === "punct" && token.text === "(") {
      take();
      const inner = disjunction();
      if (!(peek().kind === "punct" && peek().text === ")")) throw new Error(`expected ) to close the parenthesised expression`);
      take();
      return inner;
    }
    if (token.kind === "string") {
      take();
      return { kind: "literal", value: token.value };
    }
    if (token.kind === "number") {
      take();
      return { kind: "literal", value: token.value };
    }
    if (token.kind === "word") {
      take();
      if (token.text === "true") return { kind: "literal", value: true };
      if (token.text === "false") return { kind: "literal", value: false };
      if (token.text === "null") return { kind: "literal", value: null };
      if (peek().kind === "punct" && peek().text === "(") {
        take();
        if (!(peek().kind === "punct" && peek().text === ")")) {
          throw new Error(`function ${token.text}() is called with arguments; this evaluator implements only the argument-less status functions`);
        }
        take();
        if (!Object.hasOwn(STATUS_FUNCTIONS, token.text.toLowerCase())) {
          throw new Error(`${token.text}() is not implemented here — the subset is success(), always(), failure() and cancelled()`);
        }
        return { kind: "status", name: token.text.toLowerCase() };
      }
      const segments = [token.text];
      while (peek().kind === "punct" && peek().text === ".") {
        take();
        const segment = peek();
        if (segment.kind !== "word") throw new Error(`expected a property name after '.'`);
        take();
        segments.push(segment.text);
      }
      return { kind: "path", segments };
    }
    throw new Error(`expected a value, found ${JSON.stringify(token.text || "the end of the expression")}`);
  }

  function negation(): Node {
    if (peek().kind === "punct" && peek().text === "!") {
      take();
      return { kind: "not", operand: negation() };
    }
    return primary();
  }

  function equality(): Node {
    let left = negation();
    while (peek().kind === "punct" && (peek().text === "==" || peek().text === "!=")) {
      const operator = take().text === "==" ? "==" : "!=";
      left = { kind: "compare", operator, left, right: negation() };
    }
    return left;
  }

  function conjunction(): Node {
    let left = equality();
    while (peek().kind === "punct" && peek().text === "&&") {
      take();
      left = { kind: "and", left, right: equality() };
    }
    return left;
  }

  function disjunction(): Node {
    let left = conjunction();
    while (peek().kind === "punct" && peek().text === "||") {
      take();
      left = { kind: "or", left, right: conjunction() };
    }
    return left;
  }

  const node = disjunction();
  if (peek().kind !== "end") throw new Error(`unexpected trailing input ${JSON.stringify(peek().text)}`);
  return node;
}

// GitHub's truthiness: '', 0, null and the string 'false' are falsy; every other value is truthy.
function toBoolean(value: ExpressionValue): boolean {
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return value !== "" && value !== "false";
}

function castToNumber(value: ExpressionValue): number {
  if (value === null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  return value.trim() === "" ? 0 : Number(value);
}

function looseEquals(left: ExpressionValue, right: ExpressionValue): boolean {
  if (typeof left === "string" && typeof right === "string") return left.toLowerCase() === right.toLowerCase();
  if (left === null && right === null) return true;
  if (typeof left === "number" && typeof right === "number") return left === right;
  if (typeof left === "boolean" && typeof right === "boolean") return left === right;
  const leftNumber = castToNumber(left);
  const rightNumber = castToNumber(right);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber === rightNumber;
}

function asScalar(value: unknown): ExpressionValue | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}

// The runner reads a function, a context and a property name in any case; off Windows only `env`'s own keys keep theirs.
const keyed = (holder: object, name: string, exact = false): unknown =>
  Object.entries(holder).find(([key]) => (exact ? key === name : key.toLowerCase() === name.toLowerCase()))?.[1];

function resolvePath(segments: string[], context: ActionsContext): ExpressionValue {
  const [root, ...rest] = segments;
  if (!CONTEXT_ROOTS.includes(root.toLowerCase())) {
    throw new Error(`${root} is not a context this evaluator resolves; a path rooted outside a GitHub context is a typo, and reading it as null would disable every step that uses it`);
  }
  let current: unknown = keyed(context, root);
  for (const [depth, segment] of rest.entries()) {
    if (current === null || current === undefined) return null;
    if (typeof current !== "object") throw new Error(`cannot read ${segment} from a non-object value reached by ${segments.join(".")}`);
    current = keyed(current, segment, depth === 0 && root.toLowerCase() === "env");
  }
  if (current === undefined) return null;
  const scalar = asScalar(current);
  if (scalar === undefined) {
    throw new Error(`${segments.join(".")} resolved to a ${Array.isArray(current) ? "list" : "mapping"}, which has no scalar meaning in an expression`);
  }
  return scalar;
}

function evaluate(node: Node, context: ActionsContext, status: JobStatus): ExpressionValue {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "status":
      return STATUS_FUNCTIONS[node.name]!(status);
    case "path":
      return resolvePath(node.segments, context);
    case "not":
      return !toBoolean(evaluate(node.operand, context, status));
    // `&&` and `||` return an operand, not a boolean: `a && 'repo-wide' || github.sha` yields the string.
    case "and": {
      const left = evaluate(node.left, context, status);
      return toBoolean(left) ? evaluate(node.right, context, status) : left;
    }
    case "or": {
      const left = evaluate(node.left, context, status);
      return toBoolean(left) ? left : evaluate(node.right, context, status);
    }
    case "compare": {
      const equal = looseEquals(evaluate(node.left, context, status), evaluate(node.right, context, status));
      return node.operator === "==" ? equal : !equal;
    }
    default:
      throw new Error("unreachable node");
  }
}

// Strips a `${{ … }}` wrapper; a bare expression, as a non-wrapped `if:` writes it, stands as it is.
function unwrap(expression: string): string {
  const trimmed = expression.trim();
  return trimmed.startsWith("${{") && trimmed.endsWith("}}") ? trimmed.slice(3, -2).trim() : trimmed;
}

export function evaluateExpression(expression: string, context: ActionsContext = {}, status: JobStatus = "success"): ExpressionValue {
  try {
    return evaluate(parseExpression(unwrap(expression)), context, status);
  } catch (error) {
    throw new Error(`cannot evaluate the GitHub Actions expression ${JSON.stringify(String(expression))}: ` + `${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

// A value as the runner renders it in a context: each `${{ }}` part evaluated, null as the empty string.
export const renderExpressions = (value: string, context: ActionsContext = {}): string =>
  value.replace(/\$\{\{(.*?)\}\}/g, (_, expression: string) => String(evaluateExpression(expression, context) ?? ""));

// Whether an `if:` calls a status function, which stops GitHub adding its implicit `success() &&`;
// read from the parse tree, so `'always()'` as a string literal is not a call.
function callsStatusFunction(expression: string): boolean {
  const walk = (node: Node): boolean => node.kind === "status" || (node.kind === "not" && walk(node.operand)) ||
    ((node.kind === "and" || node.kind === "or" || node.kind === "compare") && (walk(node.left) || walk(node.right)));
  return walk(parseExpression(unwrap(expression)));
}

export function isSelected(step: WorkflowStep, context: ActionsContext, status: JobStatus): boolean {
  if (step.if === undefined || typeof step.if === "boolean") return step.if !== false && status === "success";
  if (typeof step.if !== "string") {
    throw new Error(`the \`if:\` of step ${JSON.stringify(step.name ?? step.uses ?? step.id ?? "unnamed")} must be a ` + `string expression or a boolean, not ${JSON.stringify(step.if)}`);
  }
  return toBoolean(evaluateExpression(step.if, context, status)) && (status === "success" || callsStatusFunction(step.if));
}

export function selectSteps(steps: readonly WorkflowStep[], context: ActionsContext, status: JobStatus = "success"): WorkflowStep[] {
  return steps.filter((step) => isSelected(step, context, status));
}

type Needs = { needs?: string | string[] };

// A job's status for its `if:` in a workflow's `jobs`: the run's when cancelled, else success only when every ancestor
// succeeded, since GitHub applies a failed or skipped need to every job below it in the needs chain, not only to its own.
// shortcut: a skipped ancestor reads as failure(), which no routed `if:` calls; model a skipped status if one starts to.
export function jobStatus(job: Needs, jobs: Record<string, Needs>, results: Record<string, { result: string }>, cancelled = false): JobStatus {
  const ancestors = (from: Needs): string[] => [from.needs ?? []].flat().flatMap((need) => [need, ...ancestors(jobs[need]!)]);
  const unknown = ancestors(job).filter((need) => results[need] === undefined);
  if (unknown.length > 0) throw new Error(`a job's status reads every ancestor's result, and none is given for ${unknown.join(", ")}`);
  return cancelled ? "cancelled" : ancestors(job).every((need) => results[need]!.result === "success") ? "success" : "failure";
}

