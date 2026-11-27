import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Contract suites over `.github/workflows/ci.yml` assert that the verify job's
 * test steps EXIST. None of them asserts that those steps RUN, because nothing
 * else evaluates `if:`. Each of the three `if:` expressions guarding the test
 * steps can be rewritten so that it never fires on a pull request, and each such
 * mutation leaves the rest of the `tests/ci/` surface green — the third disables
 * both test steps at once, so the job concludes green having executed zero of
 * 6 646 tests.
 *
 * The gap is specifically REACHABILITY, and the controls say so: mutating what
 * a step RUNS is killed by an existing suite, so these suites are not inert.
 * What no existing suite could see is a step that is present in the YAML and
 * never selected, which is the only shape in which a merge gate stops gating.
 *
 * So this suite is a STEP-SELECTION SIMULATION rather than a wiring pin. It
 * implements the subset of GitHub's expression language ci.yml actually uses,
 * evaluates each verify step's `if:` against a context for each event the
 * workflow can receive, and asserts over the command sequence GitHub would
 * execute. A condition that cannot fire is then not a string in a file but a
 * step that is absent from the selected list, and the assertions below are
 * about that list.
 *
 * TWO RULES SHAPE THE EVALUATOR, and both exist because a silent `false` would
 * reproduce the very defect this suite closes:
 *
 * 1. **An expression the parser does not understand THROWS**, naming the
 *    expression. A parser that returned `false` for something it could not
 *    parse would make every step look unreachable, and the suite's verdicts
 *    would then be an artefact of the parser's ignorance rather than a fact
 *    about ci.yml — the assertions would pass or fail for reasons that have
 *    nothing to do with the workflow. For the same reason a context value that
 *    is not a scalar throws rather than coercing, and a property path rooted
 *    at something that is not a GitHub context throws rather than resolving to
 *    null: `githbu.event_name` is a typo, and a typo that reads as "no such
 *    context" is a step that silently stops running.
 * 2. **Absent is null, and null is falsy but not equal to a non-numeric
 *    string.** `steps.detect-docs.outputs.docs_only` is null before the
 *    detect step has run, and `... != 'true'` must still hold then — that is
 *    what lets the test step run at all.
 *
 * ONE LIMITATION is deliberate and stated rather than modelled: the scenarios
 * assume every preceding step succeeded, which is what GitHub's implicit
 * `success()` on a step carrying no `if:` means, and never simulate a
 * cancelled or failed job (only Half 4's upload pairs run on a red one). A
 * status function's suppression of that requirement is therefore invisible to
 * them — `!cancelled()` appended to a test step's condition, or `always()`,
 * would leave every scenario verdict unchanged even though it changes what a
 * cancelled run executes.
 *
 * Reordering tolerance is deliberate: the assertions are membership plus the
 * one order that carries meaning (migrations before tests), never an absolute
 * index, so moving an unrelated step cannot fail the suite.
 */

/* -------------------------------------------------------------------------- */
/* Half 1 — the expression evaluator and the step selector                      */
/* -------------------------------------------------------------------------- */

/** A verify-job step as this suite reads it. `if` and `continue-on-error` are
 *  typed as `unknown` because they are precisely the two fields a mutation
 *  rewrites into a shape this suite must fail on rather than read past. */
type WorkflowStep = {
  name?: string;
  id?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  if?: unknown;
  "continue-on-error"?: unknown;
};

/**
 * Everything a GitHub expression operand can hold once evaluated. Objects and
 * arrays are deliberately absent: an object in operand position has no
 * meaning, and inventing one (coercing to `"[object Object]"`, comparing by
 * identity) would let an expression compare two different objects and learn
 * nothing. Resolution throws instead.
 */
export type ExpressionValue = string | number | boolean | null;

/** A context object that property paths resolve against. */
export type ActionsContext = Record<string, unknown>;

/** The job status the status functions report. A step's own `if:` defaults to
 *  `success()`, so `success` is the only status the scenario selector uses. */
export type JobStatus = "success" | "failure" | "cancelled";

/**
 * The contexts GitHub exposes. A path rooted outside this list is a typo or an
 * unimplemented context and throws; a path rooted inside it and naming a key
 * that is absent resolves to null, which is the case
 * `steps.detect-docs.outputs.docs_only != 'true'` depends on before
 * detect-docs has run.
 */
const CONTEXT_ROOTS = ["env", "github", "inputs", "job", "jobs", "matrix", "needs", "runner", "secrets", "steps", "strategy", "vars"];

/** The status functions, and what each reports for a job status. `always()` is
 *  the only one that is not a comparison. */
const STATUS_FUNCTIONS: Record<string, (status: JobStatus) => boolean> = {
  success: (status) => status === "success",
  always: () => true,
  failure: (status) => status === "failure",
  cancelled: (status) => status === "cancelled",
};

type Token =
  | { kind: "punct"; text: string }
  | { kind: "string"; text: string; value: string }
  | { kind: "number"; text: string; value: number }
  | { kind: "word"; text: string }
  | { kind: "end"; text: "" };

/**
 * Identifiers may contain `-`, because GitHub's contexts do: `steps.detect-docs`
 * and `inputs.simulate-refused-raise` are the two this repository ships, and
 * both are property names rather than subtractions.
 */
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
  | { kind: "literal"; value: ExpressionValue }
  | { kind: "status"; name: string }
  | { kind: "path"; segments: string[] }
  | { kind: "not"; operand: Node }
  | { kind: "and"; left: Node; right: Node }
  | { kind: "or"; left: Node; right: Node }
  | { kind: "compare"; operator: "==" | "!="; left: Node; right: Node };

/**
 * Recursive descent over the subset ci.yml uses, lowest precedence first:
 * `||`, then `&&`, then `==`/`!=`, then unary `!`, then a primary.
 *
 * The precedence split between `||` and `&&` is the one that matters here and
 * is the trap the ci.yml concurrency comment already names: `a || b && c`
 * parses as `a || (b && c)`, so the parenthesised form the workflow ships is
 * the only thing keeping the pull-request arm of that group from falling
 * through. A parser that got this backwards would silently misread the shape
 * it is supposed to model, which is why `&&` binding tighter is asserted
 * directly below.
 */
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
        if (!Object.hasOwn(STATUS_FUNCTIONS, token.text)) {
          throw new Error(`${token.text}() is not implemented here — the subset is success(), always(), failure() and cancelled()`);
        }
        return { kind: "status", name: token.text };
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

/** GitHub's truthiness: an empty string, `0`, `null` and the literal string
 *  `'false'` are falsy; every other value is truthy. `!` and the short-circuit
 *  operators all coerce through here. */
function toBoolean(value: ExpressionValue): boolean {
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return value !== "" && value !== "false";
}

/**
 * GitHub's DOCUMENTED loose equality, which is what this implements: values of
 * the same type compare by value, with strings compared case-insensitively, and
 * values of DIFFERENT types are cast to numbers and compared as numbers.
 *
 * What it does NOT claim is that this is the whole of the runner's behaviour.
 * The documentation does not enumerate every case the implementation carries —
 * `'true' == true` is the sort of undocumented residue that is often reported
 * and is not modelled here — and nothing in this file has been cross-checked
 * against a live Actions run, so the residue is UNVERIFIED rather than absent.
 * The direction of that uncertainty is the benign one for this suite: an
 * unmodelled case can only make an assertion red that a real run would keep,
 * not green that a real run would break, so it can block a legitimate refactor
 * and cannot let a wrong merge through. That is a reading of the rule, not a
 * measurement of the runner.
 *
 * The cast is what the whole suite turns on, so it is worth being explicit
 * about the case it decides. `steps.detect-docs.outputs.docs_only != 'true'`
 * compares, on a pull request where detect-docs has already run, the string
 * `'false'` with the string `'true'` — same type, unequal, so `!=` holds and
 * the test step is selected. Before that step has run the left side is null,
 * which is a different type: null casts to 0, `'true'` casts to NaN, and NaN
 * equals nothing, so `!=` still holds. A strict equality, or a null that
 * compared equal to any string, would break the first selected step of the
 * job instead of the mutation this suite exists to catch.
 */
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

/** A context value as an operand, or undefined when it is not a scalar — which
 *  includes an absent key, resolved by the caller to null. */
function asScalar(value: unknown): ExpressionValue | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}

function resolvePath(segments: string[], context: ActionsContext): ExpressionValue {
  const [root, ...rest] = segments;
  if (!CONTEXT_ROOTS.includes(root)) {
    throw new Error(
      `${root} is not a context this evaluator resolves; a path rooted outside a GitHub context is a typo, and reading it as null would disable every step that uses it`,
    );
  }
  let current: unknown = context[root];
  for (const segment of rest) {
    if (current === null || current === undefined) return null;
    if (typeof current !== "object") throw new Error(`cannot read ${segment} from a non-object value reached by ${segments.join(".")}`);
    current = (current as Record<string, unknown>)[segment];
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
    // `&&` and `||` RETURN AN OPERAND in GitHub's language, they do not coerce
    // to boolean. `a && b` is `b` when `a` is truthy and `a` otherwise; `a ||
    // b` is `a` when truthy and `b` otherwise. ci.yml depends on that shape in
    // its concurrency group, where `&& 'repo-wide' || github.sha` selects the
    // literal string 'repo-wide' rather than the boolean true.
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

/** Strips a `${{ … }}` wrapper. A bare expression is used as it stands, which
 *  is the form a workflow_dispatch input default or a non-wrapped `if:` uses. */
function unwrap(expression: string): string {
  const trimmed = expression.trim();
  return trimmed.startsWith("${{") && trimmed.endsWith("}}")
    ? trimmed.slice(3, -2).trim()
    : trimmed;
}

/**
 * Evaluates one GitHub Actions expression against a context and returns the
 * OPERAND it yields, not a boolean — the caller coerces with GitHub's rules.
 *
 * Throws, always naming the expression, on anything it cannot parse, on a
 * function or context it does not implement, and on a value it cannot coerce.
 * It never returns `false` to mean "I did not understand this": see the header
 * for why that would be the defect this suite exists to close.
 */
export function evaluateExpression(expression: string, context: ActionsContext = {}, status: JobStatus = "success"): ExpressionValue {
  try {
    return evaluate(parseExpression(unwrap(expression)), context, status);
  } catch (error) {
    throw new Error(
      `cannot evaluate the GitHub Actions expression ${JSON.stringify(String(expression))}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Whether an `if:` calls a status function, which is what stops GitHub adding
 *  its implicit `success() &&`. Read from the parse tree, so `'always()'` as a
 *  string literal is not a call. */
function callsStatusFunction(expression: string): boolean {
  const walk = (node: Node): boolean =>
    node.kind === "status" || (node.kind === "not" && walk(node.operand)) ||
    ((node.kind === "and" || node.kind === "or" || node.kind === "compare") && (walk(node.left) || walk(node.right)));
  return walk(parseExpression(unwrap(expression)));
}

/** Whether GitHub would select this step in this context.
 *
 *  - A step with no `if:`, or one calling no status function, also needs a
 *    green job: GitHub adds `success() &&` to it (the scenarios stay green).
 *  - A `continue-on-error` step IS selected. Selection is about whether the
 *    runner executes the step at all; whether its failure gates anything is a
 *    separate question, and the assertions below ask it separately. Folding
 *    the second question into this one would make the suite unable to say that
 *    a tolerated step does not gate. */
function isSelected(step: WorkflowStep, context: ActionsContext, status: JobStatus): boolean {
  if (step.if === undefined || typeof step.if === "boolean") return step.if !== false && status === "success";
  if (typeof step.if !== "string") {
    throw new Error(
      `the \`if:\` of step ${JSON.stringify(step.name ?? step.uses ?? step.id ?? "unnamed")} must be a ` +
        `string expression or a boolean, not ${JSON.stringify(step.if)}`,
    );
  }
  return toBoolean(evaluateExpression(step.if, context, status)) && (status === "success" || callsStatusFunction(step.if));
}

/**
 * The steps GitHub would execute, in file order, for a given context.
 *
 * It says nothing about WHICH steps matter: it returns what is selected, and
 * the assertions below decide what must be among them. A selector that knew
 * which steps were the test steps would re-introduce the coupling this suite
 * exists to remove — the assertions would be reading a list built to satisfy
 * them.
 */
export function selectSteps(steps: readonly WorkflowStep[], context: ActionsContext, status: JobStatus = "success"): WorkflowStep[] {
  return steps.filter((step) => isSelected(step, context, status));
}

/* -------------------------------------------------------------------------- */
/* Half 2 — the assertions, over the executed command sequence                   */
/* -------------------------------------------------------------------------- */

type Scenario = {
  /** How the assertion messages name the run. */
  label: string;
  event: string;
  /**
   * The workflow file that would receive this event, and therefore whose
   * verify job the scenario selects over. ci.yml is split into a file per leg,
   * so the event no longer determines the file: push and workflow_dispatch
   * reach ci.yml and workflow_run reaches ci-pr.yml.
   */
  file: string;
};

const SCENARIOS: Scenario[] = [
  { label: "a pull request", event: "workflow_run", file: "ci-pr.yml" },
  { label: "a push to main", event: "push", file: "ci.yml" },
  { label: "a workflow_dispatch", event: "workflow_dispatch", file: "ci.yml" },
];

const AWAIT_SUITE_COMMAND = "scripts/await-pr-suite.ts";
const BASE_SHA = "1".repeat(40);
const MERGE_SHA = "2".repeat(40);
const PUSH_BEFORE = "3".repeat(40);

/**
 * The context GitHub would present for a scenario. It is deliberately complete
 * for the event — a push carries `github.event.before`, a pull request carries
 * `steps.pr.outputs.pr_number`, neither carries the other's — so that an
 * expression reading a key this event does not have resolves to null the way
 * the runner's would.
 */
function contextFor(scenario: Scenario): ActionsContext {
  const event =
    scenario.event === "workflow_run"
      ? { workflow_run: { id: 123, run_attempt: 1, head_sha: MERGE_SHA } }
      : scenario.event === "push"
        ? { before: PUSH_BEFORE }
        : {};
  return {
    github: {
      event_name: scenario.event,
      sha: scenario.event === "workflow_run" ? BASE_SHA : MERGE_SHA,
      ref: "refs/heads/main",
      repository: "Nitjsefnie/Overflow",
      run_id: "4242",
      token: "not-a-real-token",
      event,
    },
    inputs: {},
    steps: {
      ...(scenario.event === "workflow_run" ? { pr: { outputs: { pr_number: 849, base_sha: BASE_SHA, base_ref: "main", head_sha: MERGE_SHA } } } : {}),
    },
    needs: {},
    env: {},
    job: { status: "success" },
    runner: { os: "Linux" },
  };
}

function label(step: WorkflowStep): string { return step.name ?? step.uses ?? step.id ?? "(unnamed step)"; }

function runsContaining(steps: readonly WorkflowStep[], needle: string): WorkflowStep[] { return steps.filter((step) => (step.run ?? "").includes(needle)); }

/** The message a run failed with, or "" if it did not throw. */
function captureError(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

/**
 * The verify job of each workflow file, and the events that file's `on:`
 * declares. A run of ci-pr.yml reaches the first entry's steps; a run of
 * ci.yml reaches the second's. Both carry the job id `verify`, which is what
 * makes the pair one required context rather than two.
 */
const LEGS = ["ci-pr.yml", "ci.yml"] as const;
type Leg = (typeof LEGS)[number];
type ParsedLeg = { steps: WorkflowStep[]; outputs: Record<string, unknown>; if: unknown; events: string[] };

const legs = new Map<Leg, ParsedLeg>();

beforeAll(async () => {
  for (const leg of LEGS) {
    const source = await readFile(resolve(`.github/workflows/${leg}`), "utf8");
    const workflow = parse(source) as {
      // Typed as `unknown` and narrowed rather than assumed: `on:` is a trigger
      // map whose keys are the events, and a `schedule:` or a bare-list spelling
      // would arrive as a different shape entirely. The assertion below reads
      // the keys, so a shape it cannot read fails there rather than here.
      on: unknown;
      jobs?: { verify?: { steps?: WorkflowStep[]; outputs?: Record<string, unknown>; if?: unknown } };
    };
    legs.set(leg, {
      steps: workflow.jobs?.verify?.steps ?? [],
      outputs: workflow.jobs?.verify?.outputs ?? {},
      if: workflow.jobs?.verify?.if,
      events:
        workflow.on && typeof workflow.on === "object" ? Object.keys(workflow.on).map(String) : [],
    });
  }
});

/** The leg a scenario runs in, as parsed. */
function legOf(scenario: Scenario): ParsedLeg {
  const parsed = legs.get(scenario.file as Leg);
  expect(parsed, `${scenario.file} must be one of the files this suite reads`).toBeDefined();
  return parsed!;
}

/** The verify steps of the file a scenario runs in. */
function stepsFor(scenario: Scenario): WorkflowStep[] { return legOf(scenario).steps; }

describe("the workflow files this suite simulates", () => {
  it("are parsed, not read as bytes, and each verify job is not empty", () => {
    // Without this the assertions below are vacuous: a relocated jobs key, a
    // rename, or a broken read would leave an empty step list and every
    // selection assertion would pass by finding nothing to run.
    expect([...legs.keys()].sort()).toEqual([...LEGS].sort());
    for (const leg of LEGS) expect(legs.get(leg)!.steps.length, `${leg}'s verify job must not be empty`).toBeGreaterThan(0);
  });

  it("gate nothing at the JOB level, so every step below is reached by step selection", () => {
    // The one layer this suite cannot recover by selecting steps. A step-level
    // `if:` that never fires removes that step, and the scenario assertions
    // below notice; a job-level `if:` that never fires removes every step at
    // once and leaves each of them selected, because selection here is computed
    // from the step list and knows nothing about the job that owns it. A `verify`
    // job that could be skipped posts no required check at all, and the merge
    // gate reads the missing context rather than a red one — so the condition is
    // asserted absent rather than modelled.
    // ci.yml's `always()` never skips: it records a failed or cancelled
    // dependency as a red verify for the deploy gate.
    for (const leg of LEGS) {
      expect(
        leg === "ci.yml" && legs.get(leg)!.if === "${{ always() }}" ? undefined : legs.get(leg)!.if,
        `${leg}: the verify job must carry no ` + "`if:`" + ` but ci.yml's always(). A job-level condition is invisible ` +
          "to step selection: the step list is identical whether the job runs or not, so every " +
          "scenario assertion in this file would stay green while the job carrying the test suite " +
          "never ran. Unlike a step-level condition there is nothing to recover from — the gate " +
          "is the job, not the steps in it.",
      ).toBeUndefined();
    }
  });

  it("declare exactly the events the scenarios cover, per file", () => {
    // The scenarios are a hand-written list, so a trigger added to `on:` would
    // arrive with no scenario, no context and no assertions: an event the
    // workflow receives, about which this file would then say nothing. Equality
    // in both directions, and per file — the event does not determine the file,
    // so asserting over the union would let a trigger land in the wrong file
    // unnoticed.
    for (const leg of LEGS) {
      const covered = [...new Set(SCENARIOS.filter((scenario) => scenario.file === leg).map((scenario) => scenario.event))].sort();
      expect(
        covered,
        `the scenarios above must cover exactly the events .github/workflows/${leg} declares, one ` +
          "per trigger and none for an event that file cannot receive. A trigger with no scenario " +
          "asserts nothing about what it executes; a scenario for an undeclared event asserts " +
          "nothing about anything.",
      ).toEqual([...legs.get(leg)!.events].sort());
    }
    // And the event/file pairing is itself the assertion: a scenario claiming a
    // workflow_run run happens in ci.yml, or a push run in ci-pr.yml,
    // is exactly the split undone.
    for (const scenario of SCENARIOS) {
      expect(
        legs.get(scenario.file as Leg)!.events,
        `${scenario.label}: the scenario names ${scenario.file}, whose on: block does not ` +
          `contain ${scenario.event}`,
      ).toContain(scenario.event);
    }
  });
});

describe("the step selector", () => {
  const context = contextFor(SCENARIOS[0]!);

  it("selects a step with no condition", () => {
    const selected = selectSteps([{ name: "unconditional", run: "true" }], context);
    expect(selected.map(label)).toEqual(["unconditional"]);
  });

  it("drops a step whose condition is false in this context, and keeps one whose condition holds", () => {
    const steps: WorkflowStep[] = [
      { name: "held", if: "${{ github.event_name == 'workflow_run' }}" },
      { name: "dropped", if: "${{ github.event_name == 'push' }}" },
      { name: "bare boolean", if: false },
    ];
    expect(selectSteps(steps, context).map(label)).toEqual(["held"]);
  });

  it("selects a continue-on-error step whose condition holds", () => {
    // Selection is about EXECUTION. A tolerated step still runs; whether it
    // gates the merge is asserted separately over the same list, and folding
    // the two together would make this suite unable to report the difference.
    const steps: WorkflowStep[] = [{ name: "tolerated", "continue-on-error": true, if: "${{ success() }}" }];
    expect(selectSteps(steps, context).map(label)).toEqual(["tolerated"]);
  });

  it("returns the selected steps in file order", () => {
    const steps: WorkflowStep[] = [{ name: "first" }, { name: "second", if: "${{ false }}" }, { name: "third" }];
    expect(selectSteps(steps, context).map(label)).toEqual(["first", "third"]);
  });

  it("propagates an evaluator failure rather than reporting the step as unselected", () => {
    // Every `if:` ci.yml ships today parses, so a selector that caught the
    // evaluator's throw and answered "not selected" would leave all of this
    // green: the mutation is invisible until the workflow grows an expression
    // the parser cannot read, which is exactly when the suite must be loudest.
    // The silent false is the defect this file exists to close, so the failure
    // travels out of the selector instead of stopping inside it.
    const thrown = captureError(() =>
      selectSteps([{ name: "x", if: "githbu.event_name == 'push'" }], context),
    );

    expect(
      thrown,
      "selectSteps must not swallow an evaluator failure; a mistyped context root is a fact about " +
        "the workflow file, not about whether the runner selects the step",
    ).toContain("githbu");
  });
});

describe("the expression evaluator", () => {
  const push = contextFor(SCENARIOS[1]!);
  const pullRequest = contextFor(SCENARIOS[0]!);

  it("returns the operand of && and || rather than a boolean", () => {
    // GitHub's && and || yield a VALUE. An evaluator using JavaScript's
    // boolean && and || would answer `true` here and silently misread every
    // ternary-shaped expression ci.yml writes.
    expect(evaluateExpression("'a' && 'b'")).toBe("b");
    expect(evaluateExpression("'a' || 'b'")).toBe("a");
    expect(evaluateExpression("'' && 'b'")).toBe("");
    expect(evaluateExpression("false && 'b'")).toBe(false);
    expect(evaluateExpression("false || 'b'")).toBe("b");
    expect(evaluateExpression("true || 'b'")).toBe(true);
  });

  it("binds && tighter than || in compound concurrency expressions", () => {
    // The precedence shape the repo-wide groups arm on —
    // `(event test && 'repo-wide') || github.sha`, written with the push arm
    // here; ci.yml's own group is plain per-SHA and needs no parentheses.
    // If the precedence were reversed, `a && b || c` would read as
    // `a && (b || c)` and the repo-wide arm would swallow the fallback.
    const group = "(github.event_name == 'push' && 'repo-wide') || github.sha";
    expect(evaluateExpression(group, push)).toBe("repo-wide");
    expect(evaluateExpression(group, pullRequest)).toBe(BASE_SHA);
    expect(evaluateExpression("false && 'x' || 'y'")).toBe("y");
    expect(evaluateExpression("true || 'x' && 'y'")).toBe(true);
  });

  it("reads a step output that has not been written as null, and still satisfies != 'true'", () => {
    // The case the whole verify job hangs on: the output is absent, so it must
    // be falsy-but-unequal rather than equal.
    const empty: ActionsContext = {};
    expect(evaluateExpression("steps.detect-docs.outputs.docs_only", empty)).toBeNull();
    expect(evaluateExpression("steps.detect-docs.outputs.docs_only != 'true'", empty)).toBe(true);
    expect(evaluateExpression("steps.detect-docs.outputs.docs_only == 'true'", empty)).toBe(false);
  });

  it("reads a nested step output that has been written", () => {
    expect(evaluateExpression("steps.pr.outputs.base_ref", pullRequest)).toBe("main");
  });

  it("resolves the dotted paths ci.yml reads, event by event", () => {
    expect(evaluateExpression("github.event_name", pullRequest)).toBe("workflow_run");
    expect(evaluateExpression("github.event.pull_request", pullRequest)).toBeNull();
    expect(evaluateExpression("github.sha", pullRequest)).toBe(BASE_SHA);
    expect(evaluateExpression("steps.pr.outputs.pr_number", pullRequest)).toBe(849);
    expect(evaluateExpression("github.event.before", pullRequest)).toBeNull();
    expect(evaluateExpression("github.event.before", push)).toBe(PUSH_BEFORE);
    expect(evaluateExpression("steps.pr.outputs.base_sha", pullRequest)).toBe(BASE_SHA);
  });

  it("coerces the literal string 'false' to falsy, and every other string to truthy", () => {
    // A step whose `if:` evaluates to the STRING 'false' does not run, which
    // is a different rule from JavaScript's truthiness and is easy to get
    // wrong in the direction that lets a step through.
    expect(evaluateExpression("!'false'")).toBe(true);
    expect(evaluateExpression("!'true'")).toBe(false);
    expect(evaluateExpression("!''")).toBe(true);
    expect(evaluateExpression("!'docs_only'")).toBe(false);
    expect(evaluateExpression("!0")).toBe(true);
    expect(evaluateExpression("!1")).toBe(false);
    expect(evaluateExpression("!null")).toBe(true);
    expect(evaluateExpression("!false")).toBe(true);
  });

  it("reports the job status through success(), always(), failure() and cancelled()", () => {
    expect(evaluateExpression("success()", pullRequest, "success")).toBe(true);
    expect(evaluateExpression("success()", pullRequest, "failure")).toBe(false);
    expect(evaluateExpression("always()", pullRequest, "cancelled")).toBe(true);
    expect(evaluateExpression("failure()", pullRequest, "failure")).toBe(true);
    expect(evaluateExpression("failure()", pullRequest, "success")).toBe(false);
    expect(evaluateExpression("cancelled()", pullRequest, "cancelled")).toBe(true);
    expect(evaluateExpression("success() && steps.detect-docs.outputs.docs_only != 'true'", pullRequest)).toBe(true);
  });

  it("compares strings case-insensitively and casts across types", () => {
    expect(evaluateExpression("github.event_name == 'WORKFLOW_RUN'", pullRequest)).toBe(true);
    expect(evaluateExpression("steps.pr.outputs.pr_number == '849'", pullRequest)).toBe(true);
    expect(evaluateExpression("inputs.simulate-refused-raise == true", pullRequest)).toBe(false);
  });

  it("casts a missing value to zero when the comparison crosses types", () => {
    // `castToNumber`'s null branch, which nothing else here pins: the string
    // branch does `value.trim()`, so a null reaching it throws rather than
    // casting. An absent `github.event.before` is exactly the value that
    // reaches it, so these two assertions are the difference between a cast and
    // a TypeError on every pull request.
    expect(evaluateExpression("github.event.before == 0", pullRequest)).toBe(true);
    expect(evaluateExpression("github.event.before == 1", pullRequest)).toBe(false);
    // The empty string casts to zero on the same rule, so null and '' are equal.
    expect(evaluateExpression("github.event.before == ''", pullRequest)).toBe(true);
    expect(evaluateExpression("github.event.before != ''", pullRequest)).toBe(false);
    // And the same value on the other side of the comparison, where the cast
    // runs on the literal rather than on the resolved path.
    expect(evaluateExpression("0 == github.event.before", pullRequest)).toBe(true);
  });

  it("accepts a bare expression as well as a ${{ }} wrapper", () => {
    expect(evaluateExpression("github.event_name == 'push'", push)).toBe(true);
    expect(evaluateExpression("${{ github.event_name == 'push' }}", push)).toBe(true);
  });

  it("throws, naming the expression, on anything it cannot parse", () => {
    // Every one of these must THROW. A parser that answered `false` instead
    // would report every step that reads it as unreachable, and the suite's
    // verdicts would then be a fact about the parser rather than about ci.yml.
    for (const bad of [
      "",
      "'unterminated",
      "github.event_name ==",
      "github.event_name == 'push' trailing",
      "github.event_name === 'push'",
      "github.event_name == inputs.base &&",
      "(github.event_name == 'push'",
      "github..event_name",
      "hashFiles('**/package-lock.json')",
      "steps.pr.outputs.pr_number = 1",
      "steps.detect-docs.outputs.docs_only > 'true'",
    ]) {
      const thrown = captureError(() => evaluateExpression(bad, pullRequest));
      // The `.not.toBe("")` is load-bearing rather than belt-and-braces: for
      // the empty expression `toContain("")` would hold for any string at all,
      // including the "" a non-throwing evaluation returns here.
      expect(thrown, `evaluateExpression(${JSON.stringify(bad)}) must throw, never answer false`).not.toBe("");
      expect(thrown, `the failure must name the expression ${JSON.stringify(bad)}`).toContain(bad);
    }
  });

  it("throws rather than treating a mistyped context root as absent", () => {
    // `githbu.event_name` is a typo, and reading it as null would make every
    // step using it look unreachable — or, in a `!=` test, reachable for the
    // wrong reason. Either way the run stops gating without saying so.
    const thrown = captureError(() => evaluateExpression("githbu.event_name == 'push'", push));
    expect(thrown).toContain("githbu");
  });

  it("throws rather than coercing a mapping, which has no scalar meaning", () => {
    const thrown = captureError(() =>
      evaluateExpression("steps.pr.outputs == 'x'", pullRequest),
    );
    expect(thrown).toContain("mapping");
  });

  it("throws rather than reading a property off a scalar reached mid-path", () => {
    // `inputs.base` resolves to a string, and JavaScript would happily answer
    // `"".length` with a number. That number is a silent falsy operand
    // produced by an expression nobody wrote — the class this file's header
    // forbids — so the walk refuses to index anything that is not a context
    // mapping. Delete the guard and nothing else in this file notices, because
    // no `if:` ci.yml ships reaches a scalar this way; this is the test that
    // makes the guard load-bearing rather than decorative.
    const thrown = captureError(() =>
      evaluateExpression("inputs.base.length", { inputs: { base: "" } }),
    );

    expect(thrown).toContain("inputs.base");
  });
});

/* -------------------------------------------------------------------------- */
/* Half 3 — the trust boundary of the workflow_run leg                    */
/* -------------------------------------------------------------------------- */

/**
 * Under workflow_run the executed definition is the base branch's and
 * the job's token is the base repository's, so nothing the pull request
 * carries may execute there: not its package manager, its install scripts,
 * its tests or build, and not its copies of the integrity gates. The pull
 * request's code runs only in pr-suite.yml under `pull_request`; this leg
 * runs the BASE checkout's gate scripts over the pull request's merge tree
 * as data, plus the suite run's outcome as data.
 *
 * These assertions are over the steps the selector picks for each
 * workflow_run scenario, so a step that becomes reachable under that
 * event is judged whatever its name, and a step that stops being reachable
 * stops satisfying the gate list below.
 */

const PRT_SCENARIOS = SCENARIOS.filter((scenario) => scenario.event === "workflow_run");

describe("superseded cancelled suite step selection", () => {
  it.each(PRT_SCENARIOS.map((scenario) => [scenario.label, scenario] as const))("selects no later verify steps for %s", (_label, scenario) => {
    const steps = stepsFor(scenario);
    const resolver = steps.findIndex((step) => step.id === "pr");
    expect(resolver).toBeGreaterThan(-1);
    const context = { ...contextFor(scenario), steps: { pr: { outputs: { superseded: "true" } } } };
    expect(selectSteps(steps.slice(resolver + 1), context).map((step) => step.name)).toEqual([]);
    expect(selectSteps(steps.slice(0, resolver + 1), context).some((step) => step.id === "pr")).toBe(true);
  });
});

/**
 * The ONE sanctioned package-manager invocation on this leg. The
 * base-defined zizmor gate resolves the pull request's pin against PyPI — with
 * the strict pre-parse standing between the pull request's bytes and pip, and
 * with NO token mapped (PyPI is anonymous). Sanctioned by exact step name and
 * by the exact pip argv shape: a dropped or reordered flag, a widened path, or
 * the same shape on any other step fails the assertions below. The step's
 * behavioural contract is executed end to end in
 * tests/ci/verify-zizmor-step.test.ts; this file pins only that the exception
 * cannot quietly widen.
 */
const ZIZMOR_PIN_STEP_NAME = "Verify the zizmor pin's hashes match its version";

/** The step's FULL run text, pinned line for line: the exception is sanctioned only when the workflow step is byte-identical to this, so ANY future addition - a flag, a variable, a probe - de-sanctions the step and re-arms the reachability assertions. Extracted verbatim from the step as shipped (never hand-copied). */
const ZIZMOR_PIN_RUN_TEXT = [
  "manifest=.github/requirements-zizmor.txt",
  "entries=$(git ls-tree \"${OVERFLOW_MERGE_SHA:?}\" -- \"${manifest}\")",
  "count=0",
  "entry_mode=\"\"",
  "entry_type=\"\"",
  "entry_blob=\"\"",
  "while IFS=$'\\t' read -r meta _path; do",
  "  # An empty ls-tree output still feeds the here-string ONE empty",
  "  # line; skipping it is what keeps the count truthful — a deleted",
  "  # manifest must read as zero entries, never as one.",
  "  [ -n \"${meta}\" ] || continue",
  "  count=$((count + 1))",
  "  entry_mode=${meta%% *}",
  "  rest=${meta#* }",
  "  entry_type=${rest%% *}",
  "  entry_blob=${rest#* }",
  "done <<< \"${entries}\"",
  "if [ \"${count}\" -ne 1 ] || [ \"${entry_mode}\" != \"100644\" ] || [ \"${entry_type}\" != \"blob\" ]; then",
  "  echo \"::error::${manifest} must be exactly one mode-100644 blob entry in the merge tree; found ${count} matching entries${entry_mode:+ with mode ${entry_mode}}${entry_type:+ of type ${entry_type}}. The pin is read from git objects, never from the filesystem (issue 1099), so a symlink leaf, a symlinked .github parent, a wrong mode and a non-blob type are all refused.\"",
  "  exit 1",
  "fi",
  "pre_parse=$(cat <<'PY'",
  "import os",
  "import re",
  "import sys",
  "",
  "data = sys.stdin.buffer.read()",
  "if 65536 < len(data):",
  "    sys.stderr.write(\"::error::the zizmor manifest is larger than the 65536-byte cap; refusing\\n\")",
  "    sys.exit(1)",
  "if b\"\\x00\" in data:",
  "    sys.stderr.write(\"::error::the zizmor manifest carries a NUL byte, which is invalid content wherever it sits; refusing\\n\")",
  "    sys.exit(1)",
  "try:",
  "    text = data.decode(\"utf-8\")",
  "except UnicodeDecodeError:",
  "    sys.stderr.write(\"::error::the zizmor manifest is not valid UTF-8; refusing\\n\")",
  "    sys.exit(1)",
  "pin = re.compile(r\"zizmor==[A-Za-z0-9][A-Za-z0-9._+-]*( --hash=sha256:[0-9a-f]{64}){1,32}\")",
  "accepted = None",
  "for number, line in enumerate(text.split(\"\\n\"), start=1):",
  "    if line == \"\" or line.startswith(\"#\"):",
  "        continue",
  "    if accepted is not None:",
  "        sys.stderr.write(f\"::error::line {number}: the manifest carries a second requirement line; exactly one is allowed\\n\")",
  "        sys.exit(1)",
  "    if pin.fullmatch(line) is None:",
  "        sys.stderr.write(f\"::error::line {number}: refused by the pin grammar — the one accepted shape is zizmor==VERSION followed by one to 32 --hash=sha256:HEX64 values; includes, index options, URL lines, environment markers, CRLF and stray whitespace are refused\\n\")",
  "        sys.exit(1)",
  "    accepted = line",
  "if accepted is None:",
  "    sys.stderr.write(\"::error::the manifest carries no requirement line; refusing\\n\")",
  "    sys.exit(1)",
  "with open(os.environ[\"ZIZMOR_SANITIZED_REQUIREMENTS\"], \"w\", encoding=\"utf-8\", newline=\"\\n\") as handle:",
  "    handle.write(accepted)",
  "    handle.write(\"\\n\")",
  "PY",
  ")",
  "sanitized=\"${RUNNER_TEMP}/zizmor-manifest-check\"",
  "if [ -e \"${sanitized}\" ] || [ -L \"${sanitized}\" ]; then",
  "  echo \"::error::${sanitized} already exists; refusing to write the sanitized pin into a directory this run did not create\"",
  "  exit 1",
  "fi",
  "mkdir -- \"${sanitized}\" \"${sanitized}/download\"",
  "git cat-file blob \"${entry_blob}\" | ZIZMOR_SANITIZED_REQUIREMENTS=\"${sanitized}/requirements.txt\" python3 -c \"${pre_parse}\"",
  "pip download --no-deps --only-binary=:all: --require-hashes --index-url https://pypi.org/simple --no-input --disable-pip-version-check --retries 2 --timeout 60 -d \"${sanitized}/download\" -r \"${sanitized}/requirements.txt\"",
  "",
].join("\n");

/** Sanctioned only when the named step is byte-identical to the pinned run text. */
function isSanctionedZizmorPinStep(step: WorkflowStep): boolean { return (step.run ?? "") === ZIZMOR_PIN_RUN_TEXT; }

/**
 * The suppression-list divergence gate is the second inline
 * `python3 -c` step sanctioned on the workflow_run leg. Like the zizmor
 * gate, it reads the pull request's package.json as GIT OBJECTS on both the
 * merge tree and the base, and its behavioural contract is executed end to end
 * in tests/ci/verify-suppression-step.test.ts; this file pins only that the
 * exception cannot quietly widen.
 *
 * The step's FULL run text, pinned line for line: the exception is sanctioned
 * only when the workflow step is byte-identical to this, so ANY future addition
 * - a flag, a variable, a probe - de-sanctions the step and re-arms the
 * reachability assertions. Extracted verbatim from the step as shipped (never
 * hand-copied).
 */
const SUPPRESSION_STEP_NAME = "Refuse a pull request that changes the audit suppression list";

const SUPPRESSION_PIN_RUN_TEXT = [
  "file=package.json",
  "ws_file=pnpm-workspace.yaml",
  "npmrc_file=.npmrc",
  "",
  "# Two more suppression surfaces, measured on pnpm 10.33.0 with a real advisory",
  "# carrying its github_advisory_id (the invalid-first-leg lesson applied): the",
  "# audit honours auditConfig, auditLevel and the registries mapping from",
  "# pnpm-workspace.yaml — the mapping BEATS a pinned npm_config_registry, so it",
  "# redirects the advisory endpoint — and audit-level, registry, strict-ssl,",
  "# cafile, proxy and https-proxy from .npmrc. Both files are therefore compared",
  "# alongside package.json; absent compares equal to a file carrying none of the",
  "# audited keys, and an unparseable CHANGED file is a refusal, never a silent",
  "# pass.",
  "",
  "# Reads the named commit's package.json as git objects, mirroring the zizmor",
  "# step's ls-tree gate: exactly one mode-100644 blob entry at package.json, or",
  "# refuse. Prints the blob id on stdout.",
  "blob_of() {",
  "  entries=$(git ls-tree \"${1:?}\" -- \"${file}\")",
  "  count=0",
  "  entry_mode=\"\"",
  "  entry_type=\"\"",
  "  entry_blob=\"\"",
  "  while IFS=$'\\t' read -r meta _path; do",
  "    [ -n \"${meta}\" ] || continue",
  "    count=$((count + 1))",
  "    entry_mode=${meta%% *}",
  "    rest=${meta#* }",
  "    entry_type=${rest%% *}",
  "    entry_blob=${rest#* }",
  "  done <<< \"${entries}\"",
  "  if [ \"${count}\" -ne 1 ] || [ \"${entry_mode}\" != \"100644\" ] || [ \"${entry_type}\" != \"blob\" ]; then",
  "    echo \"::error::package.json must be exactly one mode-100644 blob entry in a tree; refusing. The suppression list is read from git objects, never from the filesystem, so a symlink leaf, a wrong mode, a non-blob type and an absent file are all refused.\" >&2",
  "    exit 1",
  "  fi",
  "  printf '%s\\n' \"${entry_blob}\"",
  "}",
  "",
  "# Reads a commit's pnpm-workspace.yaml or .npmrc as git objects: absent is a",
  "# legitimate state — the files are optional — so unlike package.json it prints",
  "# the ABSENT sentinel instead of refusing. Any PRESENT shape other than exactly",
  "# one mode-100644 blob is a refusal: pnpm reads these files from the checkout",
  "# on disk, where a symlink leaf redirects the read outside the tree, so the",
  "# git-objects read must refuse what a filesystem read would follow.",
  "optional_entry_of() {",
  "  entries=$(git ls-tree \"${1:?}\" -- \"${2:?}\")",
  "  count=0",
  "  entry_mode=\"\"",
  "  entry_type=\"\"",
  "  entry_blob=\"\"",
  "  while IFS=$'\\t' read -r meta _path; do",
  "    [ -n \"${meta}\" ] || continue",
  "    count=$((count + 1))",
  "    entry_mode=${meta%% *}",
  "    rest=${meta#* }",
  "    entry_type=${rest%% *}",
  "    entry_blob=${rest#* }",
  "  done <<< \"${entries}\"",
  "  if [ \"${count}\" -eq 0 ]; then",
  "    printf 'ABSENT\\n'",
  "    return 0",
  "  fi",
  "  if [ \"${count}\" -ne 1 ] || [ \"${entry_mode}\" != \"100644\" ] || [ \"${entry_type}\" != \"blob\" ]; then",
  "    echo \"::error::pnpm-workspace.yaml and .npmrc must be absent or exactly one mode-100644 blob entry in a tree; refusing. These files are read from git objects, never from the filesystem — pnpm reads the checkout on disk, where a symlink leaf redirects the read outside the tree, so a symlink leaf, a wrong mode and a non-blob type are all refused.\" >&2",
  "    exit 1",
  "  fi",
  "  printf '%s\\n' \"${entry_blob}\"",
  "}",
  "",
  "# Pipes the named blob through the inline python pre-parse, which emits the",
  "# CANONICAL form of .pnpm.auditConfig: sort_keys and compact separators make",
  "# the dump uniquely parseable back to one value, so string equality of the two",
  "# sides is structural equality - key order, indentation and escaping in",
  "# package.json never reach the comparison, while every nested value and the",
  "# order of the ignoreGhsas list itself do, except the strict-subset rule the",
  "# pre-parse applies when handed the base's value.",
  "value_of() {",
  "  git cat-file blob \"${1:?}\" | python3 -c \"${pre_parse}\" \"${@:2}\"",
  "}",
  "",
  "# Projects one side's pnpm-workspace.yaml (a blob id, or the ABSENT sentinel)",
  "# to the canonical form of its audit-affecting settings. Absent compares equal",
  "# to a file carrying none of the audited keys; identical bytes cannot diverge,",
  "# so identical blob ids never reach the parse — the PyYAML install below runs",
  "# only when a side actually needs judging, and a runner without a working",
  "# module only ever reds a pull request that CHANGED the file.",
  "ws_value_of() {",
  "  if [ \"${1:?}\" = \"ABSENT\" ]; then",
  "    printf 'absent\\n'",
  "    return 0",
  "  fi",
  "  git cat-file blob \"${1:?}\" | PYTHONPATH=\"${pyyaml_site}${PYTHONPATH:+:${PYTHONPATH}}\" python3 -c \"${ws_pre_parse}\"",
  "}",
  "",
  "# Projects one side's .npmrc to the canonical form of its audit-affecting",
  "# keys, with the same ABSENT handling as the workspace projection.",
  "npmrc_value_of() {",
  "  if [ \"${1:?}\" = \"ABSENT\" ]; then",
  "    printf 'absent\\n'",
  "    return 0",
  "  fi",
  "  git cat-file blob \"${1:?}\" | python3 -c \"${npmrc_pre_parse}\"",
  "}",
  "",
  "pre_parse=$(cat <<'PY'",
  "import json",
  "import sys",
  "",
  "data = sys.stdin.buffer.read()",
  "if 65536 < len(data):",
  "    sys.stderr.write(\"::error::package.json is larger than the 65536-byte cap; refusing\\n\")",
  "    sys.exit(1)",
  "if b\"\\x00\" in data:",
  "    sys.stderr.write(\"::error::package.json carries a NUL byte, which is invalid content wherever it sits; refusing\\n\")",
  "    sys.exit(1)",
  "try:",
  "    text = data.decode(\"utf-8\")",
  "except UnicodeDecodeError:",
  "    sys.stderr.write(\"::error::package.json is not valid UTF-8; refusing\\n\")",
  "    sys.exit(1)",
  "try:",
  "    parsed = json.loads(text)",
  "except ValueError:",
  "    sys.stderr.write(\"::error::package.json does not parse as JSON; refusing\\n\")",
  "    sys.exit(1)",
  "config = None",
  "if isinstance(parsed, dict):",
  "    pnpm = parsed.get(\"pnpm\")",
  "    if isinstance(pnpm, dict):",
  "        config = pnpm.get(\"auditConfig\")",
  "canonical = lambda value: json.dumps(value, sort_keys=True, separators=(\",\", \":\"))",
  "# Given the base's canonical value, a merge list that is a strict subset of",
  "# the base's (no repeats, the rest of auditConfig equal) projects to the",
  "# base's value: removing ids only makes the audit stricter.",
  "def ids_of(value):",
  "    ids = value.get(\"ignoreGhsas\") if isinstance(value, dict) else None",
  "    return ids if isinstance(ids, list) and all(isinstance(i, str) for i in ids) else None",
  "reference = json.loads(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] != \"absent\" else None",
  "base_ids, merge_ids = ids_of(reference), ids_of(config)",
  "if base_ids is not None and merge_ids is not None:",
  "    rest = lambda value: canonical({k: v for k, v in value.items() if k != \"ignoreGhsas\"})",
  "    if rest(config) == rest(reference) and len(set(merge_ids)) == len(merge_ids) and set(merge_ids) < set(base_ids):",
  "        config = reference",
  "if config is None:",
  "    sys.stdout.write(\"absent\")",
  "else:",
  "    sys.stdout.write(canonical(config))",
  "PY",
  ")",
  "ws_pre_parse=$(cat <<'PY'",
  "import json",
  "import sys",
  "",
  "data = sys.stdin.buffer.read()",
  "if 65536 < len(data):",
  "    sys.stderr.write(\"::error::pnpm-workspace.yaml and .npmrc are larger than the 65536-byte cap; refusing\\n\")",
  "    sys.exit(1)",
  "if b\"\\x00\" in data:",
  "    sys.stderr.write(\"::error::pnpm-workspace.yaml and .npmrc carry a NUL byte, which is invalid content wherever it sits; refusing\\n\")",
  "    sys.exit(1)",
  "try:",
  "    text = data.decode(\"utf-8\")",
  "except UnicodeDecodeError:",
  "    sys.stderr.write(\"::error::pnpm-workspace.yaml and .npmrc are not valid UTF-8; refusing\\n\")",
  "    sys.exit(1)",
  "try:",
  "    import yaml",
  "except ImportError:",
  "    sys.stderr.write(\"::error::python3 has no yaml module; refusing to judge pnpm-workspace.yaml without it — the hash-pinned install above provides it, so a missing module means the install failed and is a red run, never a silent pass\\n\")",
  "    sys.exit(1)",
  "try:",
  "    parsed = yaml.safe_load(text)",
  "except Exception:",
  "    sys.stderr.write(\"::error::pnpm-workspace.yaml does not parse as a mapping of settings; refusing to judge the audit-affecting settings without a parse\\n\")",
  "    sys.exit(1)",
  "if parsed is None:",
  "    parsed = {}",
  "if not isinstance(parsed, dict):",
  "    sys.stderr.write(\"::error::pnpm-workspace.yaml does not parse as a mapping of settings; refusing to judge the audit-affecting settings without a parse\\n\")",
  "    sys.exit(1)",
  "projection = {}",
  "for key in (\"auditConfig\", \"auditLevel\", \"registries\"):",
  "    if key in parsed:",
  "        projection[key] = parsed[key]",
  "try:",
  "    dump = json.dumps(projection, sort_keys=True, separators=(\",\", \":\"))",
  "except (TypeError, ValueError):",
  "    sys.stderr.write(\"::error::pnpm-workspace.yaml carries audit-affecting settings that do not serialize to JSON; refusing\\n\")",
  "    sys.exit(1)",
  "sys.stdout.write(dump if projection else \"absent\")",
  "PY",
  ")",
  "",
  "npmrc_pre_parse=$(cat <<'PY'",
  "import json",
  "import sys",
  "",
  "data = sys.stdin.buffer.read()",
  "if 65536 < len(data):",
  "    sys.stderr.write(\"::error::pnpm-workspace.yaml and .npmrc are larger than the 65536-byte cap; refusing\\n\")",
  "    sys.exit(1)",
  "if b\"\\x00\" in data:",
  "    sys.stderr.write(\"::error::pnpm-workspace.yaml and .npmrc carry a NUL byte, which is invalid content wherever it sits; refusing\\n\")",
  "    sys.exit(1)",
  "try:",
  "    text = data.decode(\"utf-8\")",
  "except UnicodeDecodeError:",
  "    sys.stderr.write(\"::error::pnpm-workspace.yaml and .npmrc are not valid UTF-8; refusing\\n\")",
  "    sys.exit(1)",
  "ALLOWED = (\"audit-level\", \"registry\", \"strict-ssl\", \"cafile\", \"proxy\", \"https-proxy\")",
  "projection = {}",
  "for line in text.split(\"\\n\"):",
  "    stripped = line.strip()",
  "    if not stripped or stripped.startswith(\"#\") or stripped.startswith(\";\"):",
  "        continue",
  "    if \"=\" not in stripped:",
  "        sys.stderr.write(\"::error::.npmrc carries a line that is neither blank, a comment, nor key=value; refusing to judge its audit-affecting keys without a parse\\n\")",
  "        sys.exit(1)",
  "    key, _, value = stripped.partition(\"=\")",
  "    key = key.strip().lower()",
  "    value = value.strip()",
  "    if not key:",
  "        sys.stderr.write(\"::error::.npmrc carries a line that is neither blank, a comment, nor key=value; refusing to judge its audit-affecting keys without a parse\\n\")",
  "        sys.exit(1)",
  "    if key in ALLOWED:",
  "        projection[key] = value",
  "if projection:",
  "    sys.stdout.write(json.dumps(projection, sort_keys=True, separators=(\",\", \":\")))",
  "else:",
  "    sys.stdout.write(\"absent\")",
  "PY",
  ")",
  "",
  "# The workspace parse needs PyYAML, and the runner image does not ship",
  "# it. The module is installed from the BASE's hash-pinned manifest,",
  "# read from git objects exactly like the zizmor gate above: a pull",
  "# request can neither substitute the manifest (base-defined, not in",
  "# the merge tree) nor the wheel content (--require-hashes), so the",
  "# module the parse imports is what main pinned, never what the pull",
  "# request carries. Called only when the two sides' pnpm-workspace.yaml",
  "# blob ids differ — identical bytes cannot diverge, so identical",
  "# trees skip the install (and its network round trip) entirely.",
  "pyyaml_manifest_of() {",
  "  entries=$(git ls-tree \"${1:?}\" -- \"${manifest}\")",
  "  count=0",
  "  entry_mode=\"\"",
  "  entry_type=\"\"",
  "  entry_blob=\"\"",
  "  while IFS=$'\\t' read -r meta _path; do",
  "    [ -n \"${meta}\" ] || continue",
  "    count=$((count + 1))",
  "    entry_mode=${meta%% *}",
  "    rest=${meta#* }",
  "    entry_type=${rest%% *}",
  "    entry_blob=${rest#* }",
  "  done <<< \"${entries}\"",
  "  if [ \"${count}\" -eq 0 ]; then",
  "    echo \"::error::.github/requirements-pyyaml.txt is missing from the base; the workspace gate judges pnpm-workspace.yaml with a hash-pinned PyYAML install and refuses without it — the manifest moves only through a maintainer-reviewed merge, like the list it installs for\" >&2",
  "    exit 1",
  "  fi",
  "  if [ \"${count}\" -ne 1 ] || [ \"${entry_mode}\" != \"100644\" ] || [ \"${entry_type}\" != \"blob\" ]; then",
  "    echo \"::error::.github/requirements-pyyaml.txt must be exactly one mode-100644 blob entry in the base; refusing. The manifest is read from git objects, never from the filesystem — a pull request can neither substitute it nor hide it — so a symlink leaf, a wrong mode, a non-blob type and an absent file are all refused.\" >&2",
  "    exit 1",
  "  fi",
  "  printf '%s\\n' \"${entry_blob}\"",
  "}",
  "",
  "# Validates the manifest by the pin grammar (pyyaml==VERSION followed",
  "# by one to 32 --hash=sha256:HEX64 values) and writes the sanitized",
  "# copy pip installs from — the zizmor pre-parse's shape, so no",
  "# includes, index options, URL lines or environment markers ever",
  "# reach pip.",
  "pyyaml_manifest_pre_parse=$(cat <<'PY'",
  "import os",
  "import re",
  "import sys",
  "",
  "data = sys.stdin.buffer.read()",
  "if 65536 < len(data):",
  "    sys.stderr.write(\"::error::the PyYAML manifest is larger than the 65536-byte cap; refusing\\n\")",
  "    sys.exit(1)",
  "if b\"\\x00\" in data:",
  "    sys.stderr.write(\"::error::the PyYAML manifest carries a NUL byte, which is invalid content wherever it sits; refusing\\n\")",
  "    sys.exit(1)",
  "try:",
  "    text = data.decode(\"utf-8\")",
  "except UnicodeDecodeError:",
  "    sys.stderr.write(\"::error::the PyYAML manifest is not valid UTF-8; refusing\\n\")",
  "    sys.exit(1)",
  "pin = re.compile(r\"pyyaml==[A-Za-z0-9][A-Za-z0-9._+-]*( --hash=sha256:[0-9a-f]{64}){1,32}\")",
  "accepted = None",
  "for number, line in enumerate(text.split(\"\\n\"), start=1):",
  "    if line == \"\" or line.startswith(\"#\"):",
  "        continue",
  "    if accepted is not None:",
  "        sys.stderr.write(f\"::error::line {number}: the PyYAML manifest carries a second requirement line; exactly one is allowed\\n\")",
  "        sys.exit(1)",
  "    if pin.fullmatch(line) is None:",
  "        sys.stderr.write(f\"::error::line {number}: refused by the pin grammar — the one accepted shape is pyyaml==VERSION followed by one to 32 --hash=sha256:HEX64 values; includes, index options, URL lines, environment markers, CRLF and stray whitespace are refused\\n\")",
  "        sys.exit(1)",
  "    accepted = line",
  "if accepted is None:",
  "    sys.stderr.write(\"::error::the PyYAML manifest carries no requirement line; refusing\\n\")",
  "    sys.exit(1)",
  "with open(os.environ[\"PYAML_SANITIZED_REQUIREMENTS\"], \"w\", encoding=\"utf-8\", newline=\"\\n\") as handle:",
  "    handle.write(accepted)",
  "    handle.write(\"\\n\")",
  "PY",
  ")",
  "",
  "install_pyyaml() {",
  "  manifest=.github/requirements-pyyaml.txt",
  "  pyyaml_manifest=$(pyyaml_manifest_of \"${1:?}\")",
  "  sanitized=\"${RUNNER_TEMP}/pyyaml-manifest-check\"",
  "  if [ -e \"${sanitized}\" ] || [ -L \"${sanitized}\" ]; then",
  "    echo \"::error::${sanitized} already exists; refusing to write the sanitized pin into a directory this run did not create\"",
  "    exit 1",
  "  fi",
  "  mkdir -- \"${sanitized}\"",
  "  git cat-file blob \"${pyyaml_manifest}\" | PYAML_SANITIZED_REQUIREMENTS=\"${sanitized}/requirements.txt\" python3 -c \"${pyyaml_manifest_pre_parse}\" || return 1",
  "  # pip writes its progress to stdout; this function's stdout is the",
  "  # site path the caller captures, so pip's own output is diverted to",
  "  # the step log — captured, it would ride inside PYTHONPATH and the",
  "  # import would fall back to the system module or fail.",
  "  pip install --no-deps --require-hashes --disable-pip-version-check --no-input --retries 2 --timeout 60 --target \"${sanitized}/site\" -r \"${sanitized}/requirements.txt\" 1>&2 || return 1",
  "  printf '%s\\n' \"${sanitized}/site\"",
  "}",
  "",
  "base_blob=$(blob_of \"${OVERFLOW_BASE_SHA:?}\")",
  "merge_blob=$(blob_of \"${OVERFLOW_MERGE_SHA:?}\")",
  "base_value=$(value_of \"${base_blob}\") || exit 1",
  "merge_value=$(value_of \"${merge_blob}\" \"${base_value}\") || exit 1",
  "if [ \"${base_value}\" != \"${merge_value}\" ]; then",
  "  echo \"::error::this pull request changes pnpm.auditConfig; a pull request cannot change the audit suppression list — the list moves only through a maintainer-reviewed merge\"",
  "  exit 1",
  "fi",
  "base_ws=$(optional_entry_of \"${OVERFLOW_BASE_SHA:?}\" \"${ws_file}\")",
  "merge_ws=$(optional_entry_of \"${OVERFLOW_MERGE_SHA:?}\" \"${ws_file}\")",
  "if [ \"${base_ws}\" != \"${merge_ws}\" ]; then",
  "  pyyaml_site=$(install_pyyaml \"${OVERFLOW_BASE_SHA:?}\") || exit 1",
  "  base_ws_value=$(ws_value_of \"${base_ws}\") || exit 1",
  "  merge_ws_value=$(ws_value_of \"${merge_ws}\") || exit 1",
  "  if [ \"${base_ws_value}\" != \"${merge_ws_value}\" ]; then",
  "    echo \"::error::this pull request changes audit-affecting settings in pnpm-workspace.yaml; a pull request cannot change the audit suppression list — the list moves only through a maintainer-reviewed merge\"",
  "    exit 1",
  "  fi",
  "fi",
  "",
  "base_npmrc=$(optional_entry_of \"${OVERFLOW_BASE_SHA:?}\" \"${npmrc_file}\")",
  "merge_npmrc=$(optional_entry_of \"${OVERFLOW_MERGE_SHA:?}\" \"${npmrc_file}\")",
  "if [ \"${base_npmrc}\" != \"${merge_npmrc}\" ]; then",
  "  base_npmrc_value=$(npmrc_value_of \"${base_npmrc}\") || exit 1",
  "  merge_npmrc_value=$(npmrc_value_of \"${merge_npmrc}\") || exit 1",
  "  if [ \"${base_npmrc_value}\" != \"${merge_npmrc_value}\" ]; then",
  "    echo \"::error::this pull request changes audit-affecting keys in .npmrc; a pull request cannot change the audit suppression list — the list moves only through a maintainer-reviewed merge\"",
  "    exit 1",
  "  fi",
  "fi",
  "",
].join("\n");

/** Sanctioned only when the named step is byte-identical to the pinned run text. */
function isSanctionedSuppressionStep(step: WorkflowStep): boolean { return (step.run ?? "") === SUPPRESSION_PIN_RUN_TEXT; }
/** A run block that invokes pip or pip3 at all — the one-step allowance is judged over this set. */
function runsPip(step: WorkflowStep): boolean { return /(?<![\w./-])pip3?(?![\w-])/.test(step.run ?? ""); }

/** Commands that run a package manager, which would install or execute the
 *  pull request's dependencies, lifecycle scripts or package.json scripts. */
const PACKAGE_MANAGER = /(?<![\w./-])(pnpm|npm|npx|yarn|corepack|bun|bunx)(?![\w.-])/;

/** An interpreter followed by the first argument it would execute. Options
 *  before that argument are skipped; an inline-code option is refused below. */
const INTERPRETER_CALL =
  /(?<![\w./-])(node|python3?|bash|sh|tsx|deno)((?:\s+-[\w-]+(?:=\S+)?)*)\s+(\S+)/g;

/** The base checkout's own scripts directory, the only place an executed
 *  script may live: one path segment below it, no `..`, nothing else. */
const BASE_SCRIPTS_DIR = /^(?:\$GITHUB_WORKSPACE|\$\{GITHUB_WORKSPACE\})\/scripts\/$/;
const BASE_SCRIPT = /^(?:\$GITHUB_WORKSPACE|\$\{GITHUB_WORKSPACE\})\/scripts\/[\w-]+(\.[\w-]+)*$/;

/** The actions a workflow_run step may use: none of them executes
 *  anything from the tree they operate on. */
const PRT_ACTIONS = ["actions/checkout@", "actions/setup-node@", "Nitjsefnie-Actions/test-ratchet/report@"];

function unquoted(word: string): string { return word.replaceAll("'", "").replaceAll('"', ""); }

/** Every reason one step's run block executes something other than the base
 *  checkout's own scripts. Empty when the step is clean. */
export function untrustedExecutions(run: string): string[] {
  const reasons: string[] = [];
  const manager = PACKAGE_MANAGER.exec(run);
  if (manager) reasons.push(`runs the package manager \`${manager[1]}\``);
  for (const call of run.matchAll(INTERPRETER_CALL)) {
    const [, interpreter, options = "", target = ""] = call;
    if (/(^|\s)-(e|c|p|-eval|-print)(\s|=|$)/.test(options)) {
      reasons.push(`runs inline code through \`${interpreter}${options}\``);
      continue;
    }
    if (!BASE_SCRIPT.test(unquoted(target))) reasons.push(`runs \`${interpreter} ${target}\`, which does not resolve into the base checkout ($GITHUB_WORKSPACE)`);
  }
  // A script named by a repository-relative path resolves against whatever
  // the working directory is, and under this event that may be the pull
  // request's tree; only the base checkout's absolute prefix is unambiguous.
  for (const reference of run.matchAll(/(\S*?)scripts\/[^\s"']*/g)) {
    if (!BASE_SCRIPTS_DIR.test(`${unquoted(reference[1] ?? "")}scripts/`)) {
      reasons.push(`names \`${reference[0]}\` without the base checkout's $GITHUB_WORKSPACE prefix`);
    }
  }
  return reasons;
}

/**
 * Every write a run block makes outside the places a workflow_run step
 * may write: its own GITHUB_OUTPUT, stderr, and a directory it names through a
 * variable assigned from RUNNER_TEMP in the same block. File-moving commands
 * are refused outright; none belongs in this leg.
 */
export function untrustedWrites(run: string): string[] {
  const reasons: string[] = [];
  const tempVariables = new Set([...run.matchAll(/^\s*(\w+)="\$\{RUNNER_TEMP\}\/[\w-]+"$/gm)].map((match) => match[1]));
  // Single-quoted text is literal (a regular expression, say), never a
  // redirection, so it is blanked before the scan.
  const unquotedRun = run.replace(/'[^']*'/g, "''");
  for (const redirect of unquotedRun.matchAll(/(?<![<>&\d])>>?\s*([^\s;|&]+)/g)) {
    const target = redirect[1] ?? "";
    if (target !== '"$GITHUB_OUTPUT"' && target !== "&2") reasons.push(`redirects output into ${target}`);
  }
  for (const command of run.matchAll(/(?<![\w./-])(cp|mv|tee|touch|ln|install|rm|rsync|tar|unzip)(?![\w.-])/g)) reasons.push(`runs \`${command[1]}\``);
  for (const made of run.matchAll(/(?<![\w./-])mkdir\s+(?:-\S+\s+)*"?\$\{?(\w+)\}?"?/g)) {
    if (!tempVariables.has(made[1]!)) reasons.push(`creates a directory from ${made[1]}`);
  }
  for (const made of run.matchAll(/(?<![\w./-])mkdir\s+(?:-\S*\s+)*(?!-|"?\$)(\S+)/g)) reasons.push(`creates the directory ${made[1]}`);
  return reasons;
}

describe("the untrusted-write detector the boundary assertions rely on", () => {
  it("accepts step outputs, stderr and a fresh RUNNER_TEMP directory", () => {
    expect(untrustedWrites('echo "x=1" >> "$GITHUB_OUTPUT"')).toEqual([]);
    expect(untrustedWrites('echo "::error::no" >&2')).toEqual([]);
    expect(untrustedWrites('dir="${RUNNER_TEMP}/suite-coverage"\nmkdir -- "${dir}"')).toEqual([]);
    expect(untrustedWrites('if [ "$found" -gt 1 ]; then exit 1; fi')).toEqual([]);
    expect(untrustedWrites("git grep -nI -E '^(<{7}( |$)|>{7}( |$)|={7}$)' -- .")).toEqual([]);
  });

  it("refuses writes into either tree and file-moving commands", () => {
    expect(untrustedWrites('echo x > "$OVERFLOW_PR_TREE/coverage/coverage-summary.json"')).not.toEqual([]);
    expect(untrustedWrites('echo x >> "$GITHUB_WORKSPACE/scripts/x.ts"')).not.toEqual([]);
    expect(untrustedWrites("echo OVERFLOW_PR_TREE=x >> \"$GITHUB_ENV\"")).not.toEqual([]);
    expect(untrustedWrites('mkdir -p "${OVERFLOW_PR_TREE}/coverage"')).not.toEqual([]);
    expect(untrustedWrites("mkdir coverage")).not.toEqual([]);
    expect(untrustedWrites("mkdir -- coverage")).not.toEqual([]);
    expect(untrustedWrites('cp "$a" "$GITHUB_WORKSPACE/scripts/"')).not.toEqual([]);
    expect(untrustedWrites('tar -xf a.tar -C "$OVERFLOW_PR_TREE"')).not.toEqual([]);
  });
});

describe("the untrusted-execution detector the boundary assertions rely on", () => {
  it("accepts a base-checkout script invocation and plain git", () => {
    expect(untrustedExecutions('node "$GITHUB_WORKSPACE/scripts/check-migration-edits.ts" a b')).toEqual([]);
    expect(untrustedExecutions('python3 "${GITHUB_WORKSPACE}/scripts/commit_scopes.py" --root "$OVERFLOW_PR_TREE"')).toEqual([]);
    expect(untrustedExecutions('bash "$GITHUB_WORKSPACE/scripts/ci-base-freshness.sh"')).toEqual([]);
    expect(untrustedExecutions("git grep -nI -E 'x' -- .")).toEqual([]);
    expect(untrustedExecutions('echo "npm_config_registry is a job variable"')).toEqual([]);
  });

  it("refuses a package manager, a relative script and a pull-request-tree script", () => {
    expect(untrustedExecutions("pnpm test --run")).not.toEqual([]);
    expect(untrustedExecutions("x=$(npx tsc)")).not.toEqual([]);
    expect(untrustedExecutions("node scripts/check-migration-edits.ts HEAD^1 HEAD")).not.toEqual([]);
    expect(untrustedExecutions('cd "$OVERFLOW_PR_TREE" && node ./scripts/docs-only.ts HEAD^1')).not.toEqual([]);
    expect(untrustedExecutions('node "$OVERFLOW_PR_TREE/scripts/check-coverage-floor.ts"')).not.toEqual([]);
    expect(untrustedExecutions('node "$OVERFLOW_PR_TREE/tool.mjs"')).not.toEqual([]);
    expect(untrustedExecutions("bash scripts/ci-base-freshness.sh")).not.toEqual([]);
    expect(untrustedExecutions("./scripts/run.sh")).not.toEqual([]);
    expect(untrustedExecutions('node -e "require(process.env.OVERFLOW_PR_TREE)"')).not.toEqual([]);
    expect(untrustedExecutions('node "$GITHUB_WORKSPACE/../pr-tree/scripts/x.ts"')).not.toEqual([]);
  });
});

for (const scenario of PRT_SCENARIOS) {
  describe(`the workflow_run leg's trust boundary for ${scenario.label}`, () => {
    const selected = () => selectSteps(stepsFor(scenario), contextFor(scenario));

    it("runs no package manager and executes only the base checkout's scripts", () => {
      const offences = selected().flatMap((step) => {
        // The one exception, by exact name AND exact argv: anything else, in
        // any workflow, fails here (see the structural pin directly below,
        // which fails closed if the step's shape drifts).
        if (step.name === ZIZMOR_PIN_STEP_NAME && isSanctionedZizmorPinStep(step)) return [];
        // The issue-1035 suppression gate is the second sanctioned inline
        // `python3 -c` step, under the same fail-closed discipline: its run
        // text must be byte-identical to the pin or it re-joins the offences.
        if (step.name === SUPPRESSION_STEP_NAME && isSanctionedSuppressionStep(step)) return [];
        return untrustedExecutions(step.run ?? "").map((reason) => `${label(step)}: ${reason}`);
      });
      expect(
        offences,
        "a step reachable under workflow_run executes with the base repository's token " +
          "and definition, so it may run only the base checkout's gate scripts over the pull " +
          "request's tree as data — the pull request's own code runs in pr-suite.yml",
      ).toEqual([]);
    });

    it("sanctions the zizmor and suppression gates as the ONLY pip steps, each byte-identical to its pin", () => {
      const pipSteps = selected().filter(runsPip);
      expect(
        pipSteps.map(label),
        "the issue-1099 zizmor gate and the issue-1035 suppression gate are the only steps on " +
          "this leg allowed to invoke pip or pip3 — the latter installs the hash-pinned PyYAML " +
          "its workspace parse needs — and a third package-manager step must fail here, " +
          "sanctioned or not",
      ).toEqual([ZIZMOR_PIN_STEP_NAME, SUPPRESSION_STEP_NAME]);
      expect(
        isSanctionedZizmorPinStep(pipSteps[0]!),
        `the sanctioned step's run text drifted from the pinned shape — it must be byte-identical ` +
          `to ZIZMOR_PIN_RUN_TEXT in this file`,
      ).toBe(true);
      expect(
        isSanctionedSuppressionStep(pipSteps[1]!),
        `the sanctioned step's run text drifted from the pinned shape — it must be byte-identical ` +
          `to SUPPRESSION_PIN_RUN_TEXT in this file`,
      ).toBe(true);
    });

    it("selects the suppression-list divergence gate on this event, whose if survives the evaluator", () => {
      const gates = selected().filter((step) => step.name === SUPPRESSION_STEP_NAME);
      expect(
        gates.map(label),
        "the issue-1035 gate must be selected on every workflow_run run: verify is " +
          "base-defined and required, so a hostile pull request cannot delete the check, and an " +
          "`if:` that never fires would remove it while every other suite stays green",
      ).toHaveLength(1);
      expect(
        gates[0]!.if,
        "the gate keeps its workflow_run condition and skips only superseded cancellations",
      ).toBe("${{ steps.pr.outputs.superseded != 'true' && (github.event_name == 'workflow_run') }}");
    });

    it("sanctions the suppression-list gate only when its run text is byte-identical to the pin", () => {
      const gates = selected().filter((step) => step.name === SUPPRESSION_STEP_NAME);
      expect(gates).toHaveLength(1);
      expect(
        isSanctionedSuppressionStep(gates[0]!),
        "the suppression gate's run text drifted from SUPPRESSION_PIN_RUN_TEXT — any edit to the " +
          "step de-sanctions it here and must be re-pinned deliberately",
      ).toBe(true);
    });

    it("uses only actions that execute nothing from the tree they touch", () => {
      const used = selected().flatMap((step) => (step.uses ? [step.uses] : []));
      expect(used.length).toBeGreaterThan(0);
      for (const uses of used) {
        expect(
          PRT_ACTIONS.some((prefix) => uses.startsWith(prefix)),
          `${uses} is reachable under workflow_run; only ${PRT_ACTIONS.join(", ")} may be`,
        ).toBe(true);
      }
    });

    it("checks out the repository exactly once", () => {
      const checkouts = selected().filter((step) => (step.uses ?? "").startsWith("actions/checkout@"));
      expect(checkouts).toHaveLength(1);
    });

    it("runs every integrity gate from the base checkout, and base freshness last", () => {
      const steps = selected();
      const gates = [
        { gate: "conflict markers", needle: "git grep -nI" },
        { gate: "migration immutability", needle: "/scripts/check-migration-edits.ts" },
        { gate: "legal revision currency", needle: "/scripts/check-legal-revisions.ts" },
        { gate: "commit scopes", needle: "/scripts/commit_scopes.py" },
        { gate: "the pull request suite's outcome", needle: "/scripts/await-pr-suite.ts" },
        { gate: "base freshness", needle: "/scripts/ci-base-freshness.sh" },
      ];
      for (const { gate, needle } of gates) {
        expect(runsContaining(steps, needle).map(label), `${gate} must be judged by exactly one step under workflow_run`).toHaveLength(1);
      }
      expect(
        label(steps.at(-1)!),
        "base freshness must be the LAST step: its certificate is issued as late as the run can " +
          "issue it",
      ).toBe(label(runsContaining(steps, "/scripts/ci-base-freshness.sh")[0]!));
      expect(
        runsContaining(steps, "scripts/check-ratchets.ts"),
        "ratchet-guard.yml already runs main's copy of the ratchet check on every pull request",
      ).toEqual([]);
    });

    it("judges the merge tree it materialised from this event's head and base", () => {
      const steps = selected();
      const materialise = runsContaining(steps, "git worktree add --detach");
      expect(materialise, "exactly one step materialises the merge tree").toHaveLength(1);
      const step = materialise[0]!;
      // Both ends of the merge enter as this event's own SHA values — no
      // refs/pull refspec, no PR-number-named env on the fetching step, and no
      // read of the event's asynchronously computed merge commit
      // (tests/ci/verify-fetch-provenance.test.ts pins the pattern repo-wide
      // for this job).
      expect(step.run).toContain('git fetch --no-tags origin "${OVERFLOW_HEAD_SHA:?}"');
      expect(step.run).not.toContain("merge_commit_sha");
      expect((step as { env?: Record<string, string> }).env).toEqual({
        OVERFLOW_HEAD_SHA: "${{ steps.pr.outputs.head_sha }}",
        OVERFLOW_BASE_SHA: "${{ steps.pr.outputs.base_sha }}",
        // actions/checkout's default: the worktree checkout fetches no LFS
        // object the pull request's attributes point at.
        GIT_LFS_SKIP_SMUDGE: "1",
      });
      // The trust boundary: what is materialised must be a two-parent merge of
      // exactly this event's base and head, or the step fails closed.
      expect(step.run).toContain('git merge-tree --write-tree "${OVERFLOW_BASE_SHA:?}" "${OVERFLOW_HEAD_SHA:?}"');
      expect(step.run).toContain('[ "${second_parent}" != "${OVERFLOW_HEAD_SHA}" ]');
      // Materialised before any gate reads it.
      expect(steps.indexOf(step)).toBeLessThan(steps.indexOf(runsContaining(steps, "git grep -nI")[0]!));
    });

    it("refuses success unless the awaited run's id is a positive integer", () => {
      const steps = selected();
      const awaiter = runsContaining(steps, AWAIT_SUITE_COMMAND)[0]!;
      const required = steps.filter((step) =>
        Object.values((step as { env?: Record<string, string> }).env ?? {}).includes(
          `\${{ steps.${awaiter.id ?? "(no id)"}.outputs.run_id }}`,
        ) && (step.run ?? "").includes("OVERFLOW_RUN_ID"),
      );
      expect(awaiter.id, "the awaiter must carry an id its run_id output is read by").toBeDefined();
      expect(required.map(label), "exactly one step must check the run id").toHaveLength(1);
      expect(steps.indexOf(required[0]!)).toBeGreaterThan(steps.indexOf(awaiter));
    });

    it("writes nothing into the pull request tree or the workspace", () => {
      const offences: string[] = [];
      for (const step of selected()) {
        // The suppression gate is byte-pinned (see the execution sanction
        // above): its write surface — a sanitized manifest copy and the pip
        // site, both under RUNNER_TEMP — is fixed by the pin, and the generic
        // detector's bare-word rules (`pip install` names the file-moving word
        // `install`) cannot apply to a text this fully known.
        if (step.name === SUPPRESSION_STEP_NAME && isSanctionedSuppressionStep(step)) continue;
        for (const value of [step.with?.path, (step.with as Record<string, unknown> | undefined)?.["working-directory"]]) {
          if (value === undefined) continue;
          const text = String(value);
          if (
            text.includes("steps.pr-tree.outputs.path") ||
            /github\.workspace|GITHUB_WORKSPACE/.test(text) ||
            !text.startsWith("${{ steps.")
          ) {
            offences.push(`${label(step)}: writes to ${text}`);
          }
        }
        offences.push(...untrustedWrites(step.run ?? "").map((reason) => `${label(step)}: ${reason}`));
      }
      expect(
        offences,
        "under workflow_run the only places a step may write are its own outputs and a " +
          "fresh directory it created under RUNNER_TEMP",
      ).toEqual([]);
    });
  });
}

for (const scenario of SCENARIOS.filter((entry) => entry.file === "ci.yml")) {
  it(`runs the prerender gate on ${scenario.label}`, () => {
    const selected = selectSteps(stepsFor(scenario), contextFor(scenario));
    const gates = runsContaining(selected, "scripts/check-prerendered-routes.ts");
    expect(gates).toHaveLength(1);
    expect(gates[0]!["continue-on-error"]).toBeFalsy();
    const builds = runsContaining(selected, "pnpm build");
    expect(builds).toHaveLength(1);
    expect(selected.indexOf(gates[0]!)).toBeGreaterThan(selected.indexOf(builds[0]!));
  });
}

/* -------------------------------------------------------------------------- */
/* Half 4 — a bounded second attempt for every required-path artifact upload    */
/* -------------------------------------------------------------------------- */

// actions/upload-artifact rethrows a network error (ETIMEDOUT, ECONNRESET) at
// once, so one dropped connection failed the job and skipped every later step.
// Each upload below is a tolerated first attempt followed at once by an
// identical retry that overwrites what the first left and carries the failure.
// `afterFailure`: the upload runs on a red job too (the findings report).
const NO_STEPS: ActionsContext = { steps: {} };
const RETRIED_UPLOADS: { file: string; artifact: string; afterFailure: boolean; skippedWhen: ActionsContext | null }[] = [
  { file: "secret-scan.yml", artifact: "gitleaks-report", afterFailure: true, skippedWhen: null },
  { file: "pr-gates.yml", artifact: "gitleaks-report", afterFailure: true, skippedWhen: null },
];
// The one exemption: scorecard.yml feeds no required context, so one attempt.
const UNRETRIED_UPLOADS = [{ file: "scorecard.yml", artifact: "scorecard-results" }];

/** Runs a first attempt and its retry as the runner would: each is selected by
 *  `isSelected`, a failed step turns the job red unless it is
 *  `continue-on-error: true`, and a later `if:` reads each earlier step's
 *  outcome. Returns which attempts ran and the job's status. */
function runAttempts(pair: WorkflowStep[], context: ActionsContext, prior: JobStatus, fails: boolean[]) {
  let status = prior;
  const outcomes: Record<string, unknown> = { ...(context.steps as Record<string, unknown>) };
  const ran: string[] = [];
  pair.forEach((step, index) => {
    const tolerated = step["continue-on-error"];
    if (tolerated !== undefined && typeof tolerated !== "boolean") throw new Error(`${label(step)}: continue-on-error must be a boolean`);
    const runs = isSelected(step, { ...context, steps: outcomes }, status);
    if (runs) ran.push(index === 0 ? "first" : "retry");
    if (runs && fails[index] && tolerated !== true) status = "failure";
    if (step.id) outcomes[step.id] = { outcome: runs ? (fails[index] ? "failure" : "success") : "skipped" };
  });
  return { ran, status };
}

describe("every artifact upload on a required path", () => {
  const uploads: { file: string; steps: WorkflowStep[]; step: WorkflowStep }[] = [];
  const requiredFiles: string[] = [];
  beforeAll(async () => {
    for (const file of (await readdir(resolve(".github/workflows"))).filter((name) => name.endsWith(".yml"))) {
      const workflow = parse(await readFile(resolve(`.github/workflows/${file}`), "utf8")) as { jobs?: Record<string, { steps?: WorkflowStep[] }> };
      for (const job of Object.values(workflow.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if ((step.uses ?? "").startsWith("actions/upload-artifact@")) uploads.push({ file, steps: job.steps!, step });
        }
      }
    }
    const required = JSON.parse(await readFile(resolve(".github/required-checks.json"), "utf8")) as Record<string, string[]>;
    requiredFiles.push(...Object.values(required).flat());
  });
  const attemptsOf = (file: string, artifact: string) =>
    uploads.filter((upload) => upload.file === file && upload.step.with?.name === artifact);

  it("is listed here, twice for a retried upload and once for the exemption, which feeds no required context", () => {
    expect(uploads.map(({ file, step }) => `${file} ${String(step.with?.name)}`).sort()).toEqual([
      ...RETRIED_UPLOADS.flatMap(({ file, artifact }) => [`${file} ${artifact}`, `${file} ${artifact}`]),
      ...UNRETRIED_UPLOADS.map(({ file, artifact }) => `${file} ${artifact}`),
    ].sort());
    for (const { file } of UNRETRIED_UPLOADS) expect(requiredFiles, `${file} now feeds a required context`).not.toContain(`.github/workflows/${file}`);
  });

  for (const site of RETRIED_UPLOADS) {
    describe(`${site.file}'s ${site.artifact} upload`, () => {
      const pair = () => attemptsOf(site.file, site.artifact).map(({ step }) => step);

      it("is followed at once by a retry of the same action and inputs that overwrites the first attempt's artifact", () => {
        const [first, retry] = attemptsOf(site.file, site.artifact);
        expect(first!.steps.indexOf(retry!.step), "the retry must be the very next step of the same job").toBe(first!.steps.indexOf(first!.step) + 1);
        expect(retry!.step.uses).toBe(first!.step.uses);
        expect(retry!.step.with).toEqual({ ...first!.step.with, overwrite: true });
      });

      for (const prior of ["success", "failure"] as const) {
        for (const skipped of site.skippedWhen ? [false, true] : [false]) {
          for (const [firstFails, retryFails] of [[false, false], [true, false], [true, true]]) {
            const holds = !skipped && (prior === "success" || site.afterFailure);
            const when = `job ${prior}, ${skipped ? "condition false" : "condition holds"}, first ${firstFails ? "fails" : "succeeds"}, retry ${retryFails ? "fails" : "succeeds"}`;
            it(`on ${when}`, () => {
              const run = runAttempts(pair(), skipped ? site.skippedWhen! : NO_STEPS, prior, [firstFails!, retryFails!]);
              expect(run.ran, "which attempts run").toEqual(holds ? (firstFails ? ["first", "retry"] : ["first"]) : []);
              expect(run.status, "the job's status after them").toBe(prior === "failure" || (holds && firstFails && retryFails) ? "failure" : "success");
            });
          }
        }
      }
    });
  }
});

// Job-level routing of ci.yml's matrix on a main push, through the same evaluator; status is the run's.
describe("ci.yml's matrix routing on a main push", () => {
  it("runs the tip's own matrix on a code push, or on a records-only push whose record source found no usable run", async () => {
    const jobs = (parse(await readFile(resolve(".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, { if: string; needs: string[] }> }).jobs;
    const needs = (records: string | null, source: string, runId?: string, image = "success") => ({ needs: {
      "postgres-image": { result: image, outputs: records === null ? {} : { "records-only": records } },
      "record-source": { result: source, outputs: runId === undefined ? {} : { "run-id": runId } } } });
    expect(jobs.plan!.needs).toEqual(["postgres-image", "record-source"]);
    for (const [context, status, runs] of [
      [needs("false", "skipped"), "success", true], [needs("true", "success", "12"), "success", false], [needs("true", "success", ""), "success", true],
      [needs("true", "failure"), "success", false], [needs(null, "skipped", undefined, "failure"), "success", false], [needs("false", "skipped"), "cancelled", false],
    ] as const) expect(evaluateExpression(jobs.plan!.if, context, status), JSON.stringify([context, status])).toBe(runs);
    for (const [plan, status, runs] of [["success", "success", true], ["skipped", "success", false], ["failure", "success", false], ["success", "cancelled", false]] as const)
      expect(evaluateExpression(jobs.test!.if, { needs: { plan: { result: plan } } }, status), plan + status).toBe(runs);
  });
});
