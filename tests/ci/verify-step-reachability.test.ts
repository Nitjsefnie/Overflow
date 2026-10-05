import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Issue 849: every contract suite over `.github/workflows/ci.yml` asserted that
 * the verify job's test steps EXIST. None of them asserted that those steps
 * RUN, because `if:` was never evaluated by anything. The audit campaign
 * (domain D17) rewrote each of the three `if:` expressions guarding the test
 * steps so that it can never fire on a pull request, and all three mutations
 * left the entire `tests/ci/` surface green — the third disables both test
 * steps at once, so the job concludes green having executed zero of 6 646
 * tests.
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
 * ONE LIMITATION is deliberate and stated rather than modelled: the selector
 * assumes every preceding step succeeded, which is what GitHub's implicit
 * `success()` on a step carrying no `if:` means, and it never simulates a
 * cancelled or failed job. A status function's suppression of that requirement
 * is therefore invisible to it — `!cancelled()` appended to a test step's
 * condition, or `always()`, would leave every verdict below unchanged even
 * though it changes what a cancelled run executes.
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
const CONTEXT_ROOTS = [
  "env",
  "github",
  "inputs",
  "job",
  "jobs",
  "matrix",
  "needs",
  "runner",
  "secrets",
  "steps",
  "strategy",
  "vars",
];

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
      if (!(peek().kind === "punct" && peek().text === ")")) {
        throw new Error(`expected ) to close the parenthesised expression`);
      }
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
          throw new Error(
            `${token.text}() is not implemented here — the subset is success(), always(), failure() and cancelled()`,
          );
        }
        return { kind: "status", name: token.text };
      }
      const segments = [token.text];
      while (peek().kind === "punct" && peek().text === ".") {
        take();
        const segment = peek();
        if (segment.kind !== "word") {
          throw new Error(`expected a property name after '.'`);
        }
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
  if (peek().kind !== "end") {
    throw new Error(`unexpected trailing input ${JSON.stringify(peek().text)}`);
  }
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
  if (typeof left === "string" && typeof right === "string") {
    return left.toLowerCase() === right.toLowerCase();
  }
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
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
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
    if (typeof current !== "object") {
      throw new Error(`cannot read ${segment} from a non-object value reached by ${segments.join(".")}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined) return null;
  const scalar = asScalar(current);
  if (scalar === undefined) {
    throw new Error(
      `${segments.join(".")} resolved to a ${Array.isArray(current) ? "list" : "mapping"}, which has no scalar meaning in an expression`,
    );
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
      const equal = looseEquals(
        evaluate(node.left, context, status),
        evaluate(node.right, context, status),
      );
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
export function evaluateExpression(
  expression: string,
  context: ActionsContext = {},
  status: JobStatus = "success",
): ExpressionValue {
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

/** Whether GitHub would select this step in this context.
 *
 *  - A step with no `if:` is selected: no failures are assumed, and the only
 *    job this suite simulates has every step succeeding.
 *  - A `continue-on-error` step IS selected. Selection is about whether the
 *    runner executes the step at all; whether its failure gates anything is a
 *    separate question, and the assertions below ask it separately. Folding
 *    the second question into this one would make the suite unable to say that
 *    a tolerated step does not gate. */
function isSelected(step: WorkflowStep, context: ActionsContext, status: JobStatus): boolean {
  if (step.if === undefined) return true;
  if (typeof step.if === "boolean") return step.if;
  if (typeof step.if !== "string") {
    throw new Error(
      `the \`if:\` of step ${JSON.stringify(step.name ?? step.uses ?? step.id ?? "unnamed")} must be a ` +
        `string expression or a boolean, not ${JSON.stringify(step.if)}`,
    );
  }
  return toBoolean(evaluateExpression(step.if, context, status));
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
export function selectSteps(
  steps: readonly WorkflowStep[],
  context: ActionsContext,
  status: JobStatus = "success",
): WorkflowStep[] {
  return steps.filter((step) => isSelected(step, context, status));
}

/* -------------------------------------------------------------------------- */
/* Half 2 — the assertions, over the executed command sequence                   */
/* -------------------------------------------------------------------------- */

type Scenario = {
  /** How the assertion messages name the run. */
  label: string;
  event: string;
  /** What `scripts/docs-only.ts` wrote into `detect-docs`'s output. */
  docsOnly: "true" | "false";
  /** Whether this job itself runs the suite. Under pull_request_target it
   *  never does: the pull request's code runs only in pr-suite.yml, and verify
   *  awaits that run's outcome as data. */
  runsSuite: boolean;
  /** Whether the coverage measurement is expected to run IN THIS JOB — the
   *  two-branch design ci.yml ships, written out as data so a reviewer reads
   *  the expected outcome per run rather than deriving it from the branch
   *  under test. */
  coverage: boolean;
  /** Whether the coverage floor is checked: by this job's own measurement on
   *  push and dispatch, and over the awaited suite run's coverage summary on
   *  a pull request carrying code. */
  floor: boolean;
};

const SCENARIOS: Scenario[] = [
  {
    label: "a pull request carrying a code change",
    event: "pull_request_target",
    docsOnly: "false",
    runsSuite: false,
    coverage: false,
    floor: true,
  },
  {
    label: "a pull request carrying a docs-only change",
    event: "pull_request_target",
    docsOnly: "true",
    runsSuite: false,
    coverage: false,
    floor: false,
  },
  {
    label: "a push to main",
    event: "push",
    docsOnly: "false",
    runsSuite: true,
    coverage: true,
    floor: true,
  },
  {
    label: "a workflow_dispatch",
    event: "workflow_dispatch",
    docsOnly: "false",
    runsSuite: true,
    coverage: true,
    floor: true,
  },
];

const TEST_SUITE_COMMAND = "pnpm test --run";
// The script's path, not its invocation: the push leg runs it relative to the
// event commit's checkout, the pull_request_target leg by absolute path into
// the base checkout.
const COVERAGE_FLOOR_COMMAND = "scripts/check-coverage-floor.ts";
const AWAIT_SUITE_COMMAND = "scripts/await-pr-suite.ts";
const MIGRATE_COMMAND = "pnpm db:migrate";
const DETECT_STEP_ID = "detect-docs";
const DETECT_STEP_NAME = "Detect docs-only change";

/**
 * Every flag the workflow's coverage invocation passes, each asserted
 * separately as a WHOLE SHELL WORD, never as a substring.
 *
 * The distinction is the whole point. `--coverage` is a prefix of all three
 * reporter flags, so a substring test for it is satisfied by any single
 * reporter and can never fail — and it is not a redundant pin either: with the
 * reporters left alone but the bare flag dropped, vitest 5.0.0 writes no
 * reports directory at all (measured by the fix round 2 reviewer), so the run
 * measures nothing and every downstream reader is handed a file that was never
 * written. The same holds for `--coverage.include`, which was on the step and
 * pinned nowhere in the repository before this list carried it.
 *
 * Splitting on whitespace is what makes the tokens whole words, and it is also
 * what keeps the assertion indifferent to how the `run:` block is laid out: a
 * folded `>-` block, extra tabs and re-wrapped lines all arrive here as the same
 * list of words (measured by the fix round 3 reviewer — reformatting stayed
 * green at 178/178 and must stay that way).
 */
const COVERAGE_FLAGS = [
  "--coverage",
  "--coverage.reporter=text",
  "--coverage.reporter=json-summary",
  "--coverage.reporter=cobertura",
  "--coverage.include='src/**'",
];

/**
 * A command's shell words, each with its quoting removed.
 *
 * Quote removal is the ONE normalisation here, and it is deliberate in both
 * directions. `--coverage.reporter="text"` is the same shell word as
 * `--coverage.reporter=text`, and asserting on the raw text turned a spelling
 * difference into a red suite claiming the workflow fails to pass a flag it does
 * pass. Nothing wider: whitespace is not collapsed beyond splitting into words,
 * so the layout tolerance above is untouched, and a dropped flag still leaves
 * no word to find.
 */
function shellWords(command: string): string[] {
  return command
    .split(/\s+/)
    .map((word) => word.replaceAll("'", "").replaceAll('"', ""))
    .filter((word) => word !== "");
}

/**
 * The steps that compute or publish a coverage artifact. They carry the same
 * `docs_only != 'true'` condition as the test steps, and rewriting only one of
 * those conditions leaves every assertion this file made before fix round 1
 * green — the artifact simply stops existing while the job concludes green.
 *
 * Each is recognised by what it does rather than by its name, so a rename does
 * not fail the suite: the script one runs, and the artifact name the other two
 * upload.
 *
 * A hand-written table is a hole in itself, and every campaign run against this
 * file so far was scoped to the WORKFLOW, which is structurally unable to reach
 * a deletion in here: deleting the entry for the patch-coverage report turns the
 * mutation that entry was written to catch green, with the test count unmoved.
 * The completeness assertion below is what closes it, and it closes it by
 * comparing this table against the workflow rather than trusting it.
 */
const COVERAGE_ARTIFACTS: { label: string; matches: (step: WorkflowStep) => boolean }[] = [
  {
    label: "the patch coverage report",
    matches: (step) => (step.run ?? "").includes("scripts/patch-coverage.ts"),
  },
  {
    label: "the patch coverage upload",
    matches: (step) =>
      (step.uses ?? "").startsWith("actions/upload-artifact@") && step.with?.name === "patch-coverage",
  },
  {
    label: "the coverage summary upload",
    matches: (step) =>
      (step.uses ?? "").startsWith("actions/upload-artifact@") && step.with?.name === "coverage-summary",
  },
];

/**
 * Whether a step reads or writes something under `coverage/` — the directory the
 * reporters write and the floor reads. This is the WORKFLOW side of the
 * completeness assertion, derived from the parsed steps by what they name rather
 * than by any key the table above carries, so a table entry cannot be removed and
 * the remainder quietly become the definition.
 *
 * It is deliberately broader than the table: it says nothing about which script
 * computes an artifact or which artifact is uploaded, only that a step touches
 * the coverage directory. `scripts/check-coverage-floor.ts` does not match
 * (nothing in its `run:` names a path under `coverage/`), and neither does the
 * test suite's invocation, whose `--coverage.include='src/**'` names no artifact
 * — so the derivation and the table agree at three steps without sharing a key.
 */
function namesCoverageArtifact(step: WorkflowStep): boolean {
  return [step.run ?? "", String(step.with?.path ?? ""), String(step.with?.name ?? "")]
    .join(" ")
    .includes("coverage/");
}

const BASE_SHA = "1".repeat(40);
const MERGE_SHA = "2".repeat(40);
const PUSH_BEFORE = "3".repeat(40);

/**
 * The context GitHub would present for a scenario. It is deliberately complete
 * for the event — a push carries `github.event.before`, a pull request carries
 * `github.event.pull_request.number`, neither carries the other's — so that an
 * expression reading a key this event does not have resolves to null the way
 * the runner's would.
 */
function contextFor(scenario: Scenario): ActionsContext {
  const event =
    scenario.event === "pull_request_target"
      ? { pull_request: { number: 849, base: { sha: BASE_SHA, ref: "main" }, head: { sha: MERGE_SHA } } }
      : scenario.event === "push"
        ? { before: PUSH_BEFORE }
        : {};
  return {
    github: {
      event_name: scenario.event,
      sha: scenario.event === "pull_request_target" ? BASE_SHA : MERGE_SHA,
      ref: "refs/heads/main",
      repository: "Nitjsefnie/Overflow",
      run_id: "4242",
      token: "not-a-real-token",
      event,
    },
    inputs: { base: "", "simulate-refused-raise": false },
    steps: { [DETECT_STEP_ID]: { outputs: { docs_only: scenario.docsOnly } } },
    needs: {},
    env: {},
    job: { status: "success" },
    runner: { os: "Linux" },
  };
}

function label(step: WorkflowStep): string {
  return step.name ?? step.uses ?? step.id ?? "(unnamed step)";
}

function runsContaining(steps: readonly WorkflowStep[], needle: string): WorkflowStep[] {
  return steps.filter((step) => (step.run ?? "").includes(needle));
}

/** The message a run failed with, or "" if it did not throw. */
function captureError(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

let verify: { steps: WorkflowStep[]; outputs: Record<string, unknown>; if: unknown };
let declaredEvents: string[] = [];

beforeAll(async () => {
  const source = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
  const workflow = parse(source) as {
    // Typed as `unknown` and narrowed rather than assumed: `on:` is a trigger
    // map whose keys are the events, and a `schedule:` or a bare-list spelling
    // would arrive as a different shape entirely. The assertion below reads
    // the keys, so a shape it cannot read fails there rather than here.
    on: unknown;
    jobs?: { verify?: { steps?: WorkflowStep[]; outputs?: Record<string, unknown>; if?: unknown } };
  };

  verify = {
    steps: workflow.jobs?.verify?.steps ?? [],
    outputs: workflow.jobs?.verify?.outputs ?? {},
    if: workflow.jobs?.verify?.if,
  };
  declaredEvents =
    workflow.on && typeof workflow.on === "object" ? Object.keys(workflow.on) : [];
});

describe("the workflow file this suite simulates", () => {
  it("is parsed, not read as bytes, and the verify job is not empty", () => {
    // Without this the assertions below are vacuous: a relocated jobs key, a
    // rename, or a broken read would leave an empty step list and every
    // selection assertion would pass by finding nothing to run.
    expect(verify.steps.length).toBeGreaterThan(0);
  });

  it("gates nothing at the JOB level, so every step below is reached by step selection", () => {
    // The one layer this suite cannot recover by selecting steps. A step-level
    // `if:` that never fires removes that step, and the scenario assertions
    // below notice; a job-level `if:` that never fires removes every step at
    // once and leaves each of them selected, because selection here is computed
    // from the step list and knows nothing about the job that owns it. A `verify`
    // job that could be skipped posts no required check at all, and the merge
    // gate reads the missing context rather than a red one — so the condition is
    // asserted absent rather than modelled.
    expect(
      verify.if,
      "the verify job must carry no `if:`. A job-level condition is invisible to step " +
        "selection: the step list is identical whether the job runs or not, so every scenario " +
        "assertion in this file would stay green while the job carrying the test suite never " +
        "ran. Unlike a step-level condition there is nothing to recover from — the gate is " +
        "the job, not the steps in it.",
    ).toBeUndefined();
  });

  it("declares exactly the events the scenarios cover", () => {
    // The scenarios are a hand-written list, so a trigger added to `on:` would
    // arrive with no scenario, no context and no assertions: an event the
    // workflow receives, about which this file would then say nothing. Equality
    // in both directions — a new trigger fails here, a removed one fails here,
    // and a scenario for an event the workflow cannot receive fails here too.
    const covered = [...new Set(SCENARIOS.map((scenario) => scenario.event))].sort();

    expect(
      covered,
      "the scenarios above must cover exactly the events `on:` declares, one per trigger and " +
        "none for an event the workflow cannot receive. A trigger with no scenario asserts " +
        "nothing about what it executes; a scenario for an undeclared event asserts nothing " +
        "about anything.",
    ).toEqual([...declaredEvents].sort());
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
      { name: "held", if: "${{ github.event_name == 'pull_request_target' }}" },
      { name: "dropped", if: "${{ github.event_name == 'push' }}" },
      { name: "bare boolean", if: false },
    ];
    expect(selectSteps(steps, context).map(label)).toEqual(["held"]);
  });

  it("selects a continue-on-error step whose condition holds", () => {
    // Selection is about EXECUTION. A tolerated step still runs; whether it
    // gates the merge is asserted separately over the same list, and folding
    // the two together would make this suite unable to report the difference.
    const steps: WorkflowStep[] = [
      {
        name: "tolerated",
        "continue-on-error": true,
        if: "${{ success() }}",
      },
    ];
    expect(selectSteps(steps, context).map(label)).toEqual(["tolerated"]);
  });

  it("returns the selected steps in file order", () => {
    const steps: WorkflowStep[] = [
      { name: "first" },
      { name: "second", if: "${{ false }}" },
      { name: "third" },
    ];
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
  const push = contextFor(SCENARIOS[2]!);
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

  it("binds && tighter than ||, which is why ci.yml's group parenthesises", () => {
    // The exact shape of ci.yml's concurrency group, on both legs of its
    // event-class split. If the precedence were reversed, `a && b || c` would
    // read as `a && (b || c)` and the pull-request arm would swallow the
    // fallback.
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
    expect(evaluateExpression("steps.detect-docs.outputs.docs_only", pullRequest)).toBe("false");
  });

  it("resolves the dotted paths ci.yml reads, event by event", () => {
    expect(evaluateExpression("github.event_name", pullRequest)).toBe("pull_request_target");
    expect(evaluateExpression("github.sha", pullRequest)).toBe(BASE_SHA);
    expect(evaluateExpression("github.event.pull_request.number", pullRequest)).toBe(849);
    expect(evaluateExpression("github.event.before", pullRequest)).toBeNull();
    expect(evaluateExpression("github.event.before", push)).toBe(PUSH_BEFORE);
    expect(evaluateExpression("inputs.base", pullRequest)).toBe("");
    expect(evaluateExpression("inputs.simulate-refused-raise", pullRequest)).toBe(false);
    expect(evaluateExpression("github.event.pull_request.base.sha", pullRequest)).toBe(BASE_SHA);
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
    expect(evaluateExpression("success() && steps.detect-docs.outputs.docs_only != 'true'", pullRequest)).toBe(
      true,
    );
  });

  it("compares strings case-insensitively and casts across types", () => {
    expect(evaluateExpression("github.event_name == 'PULL_REQUEST_TARGET'", pullRequest)).toBe(true);
    expect(evaluateExpression("github.event.pull_request.number == '849'", pullRequest)).toBe(true);
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
      "github.event.pull_request.number = 1",
      "steps.detect-docs.outputs.docs_only > 'true'",
    ]) {
      const thrown = captureError(() => evaluateExpression(bad, pullRequest));
      // The `.not.toBe("")` is load-bearing rather than belt-and-braces: for
      // the empty expression `toContain("")` would hold for any string at all,
      // including the "" a non-throwing evaluation returns here.
      expect(thrown, `evaluateExpression(${JSON.stringify(bad)}) must throw, never answer false`).not.toBe(
        "",
      );
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
      evaluateExpression("github.event.pull_request == 'x'", pullRequest),
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

describe("the docs-only detection the scenarios above assume", () => {
  it("is produced by exactly one step, under the id the gated steps read", () => {
    // Without this the scenarios are fabricated: an evaluator fed a context
    // the workflow never wires says nothing about what CI does. The three
    // conditions below are all `steps.detect-docs.outputs.docs_only`, so if
    // that output belonged to some other step, or to two, every reachability
    // assertion above would be reasoning about a fiction.
    const producers = verify.steps.filter((step) => step.id === DETECT_STEP_ID);
    expect(
      producers.map(label),
      `exactly one step of the verify job may carry \`id: ${DETECT_STEP_ID}\` — the three test and ` +
        `coverage steps read its output by that id, and a second producer makes that output ` +
        `ambiguous`,
    ).toEqual([DETECT_STEP_NAME]);
    expect(
      producers[0]?.run ?? "",
      "the docs-only producer must be the step that runs scripts/docs-only.ts",
    ).toContain("scripts/docs-only.ts");
    expect(
      producers[0]?.if,
      "the docs-only producer must run unconditionally — a condition on it means the output the " +
        "test steps read may never be written at all",
    ).toBeUndefined();
  });

  it("is what the job publishes as its docs_only output", () => {
    // The calibrate job's own condition reads `needs.verify.outputs.docs_only`,
    // so the value has to be republished under that exact name.
    expect(verify.outputs.docs_only).toBe(`\${{ steps.${DETECT_STEP_ID}.outputs.docs_only }}`);
  });

  it("is selected in every scenario, so its output exists before the steps that read it", () => {
    for (const scenario of SCENARIOS) {
      const selected = selectSteps(verify.steps, contextFor(scenario));
      expect(
        selected.some((step) => step.id === DETECT_STEP_ID),
        `on ${scenario.event} with docs_only=${scenario.docsOnly} the detect step must be among the ` +
          `executed steps; the conditions below read its output, which only exists once it has run`,
      ).toBe(true);
    }
  });

  it("lists exactly the verify steps that touch a coverage artifact, so the table cannot be shrunk", () => {
    // COVERAGE_ARTIFACTS decides what the per-scenario assertion below is about,
    // and a table nobody checks against the workflow is a table that can be
    // edited to stop asserting anything. Deleting an entry does not fail any
    // assertion here — the workflow side is unchanged, so the step is simply no
    // longer checked, and the mutation that entry existed to catch goes green
    // with the test count unmoved.
    //
    // Equality in BOTH directions, against a derivation that shares no key with
    // the table: adding an entry for a step that touches nothing fails, and a
    // step added to the workflow that the table does not list fails, which is
    // the direction that matters — a new coverage step would otherwise arrive
    // with no reachability expectation at all.
    const inWorkflow = verify.steps.filter(namesCoverageArtifact);
    const matched = verify.steps.filter((step) =>
      COVERAGE_ARTIFACTS.some((artifact) => artifact.matches(step)),
    );

    for (const artifact of COVERAGE_ARTIFACTS) {
      expect(
        verify.steps.filter(artifact.matches),
        `the COVERAGE_ARTIFACTS entry for ${artifact.label} must match exactly one step; an entry ` +
          `matching none is dead and one matching several makes the per-scenario expectation ` +
          `ambiguous`,
      ).toHaveLength(1);
    }
    expect(
      matched.map(label),
      "COVERAGE_ARTIFACTS must list exactly the verify-job steps that name something under " +
        "coverage/ — every one of the steps that reads or writes an artifact, and nothing else. " +
        "Delete an entry and the workflow mutation it was written to catch goes green while this " +
        "file still passes; add an entry for a step that touches no artifact and this fails. " +
        `Steps the workflow actually carries: ${inWorkflow.map(label).join(", ") || "none"}`,
    ).toEqual(inWorkflow.map(label));
  });
});

for (const scenario of SCENARIOS) {
  describe(`the verify job's executed steps when CI runs ${scenario.label}`, () => {
    const selected = () => selectSteps(verify.steps, contextFor(scenario));
    const testSteps = () => runsContaining(selected(), TEST_SUITE_COMMAND);
    const executedRunSteps = () => selected().filter((step) => step.run !== undefined);
    const coverageInvocations = () =>
      // Every EXECUTED step's run, not just the test steps': a second step
      // measuring coverage is the same defect as a second test suite — two
      // measurements, one over the other's output — and restricting the search
      // to `testSteps()` made appending `--coverage` to an unrelated step
      // invisible. Token-aware for the same reason the flags are: a substring
      // here counts every command with a `--coverage.*` flag as a measurement.
      executedRunSteps()
        .map((step) => step.run ?? "")
        .filter((run) => shellWords(run).includes("--coverage"));

    it(
      scenario.runsSuite
        ? "runs the test suite exactly once"
        : "runs no test suite of its own and awaits the pull request suite exactly once",
      () => {
        // Zero is issue 849's own failure mode: a condition that can never fire
        // leaves the step in the file, so every presence assertion in tests/ci/
        // stays green while CI executes no tests. Two is a different bug — the
        // suite would run twice against the same database — and neither count
        // is acceptable, which is why this asserts the cardinality and not a
        // substring. Under pull_request_target the suite is the pull request's
        // own code, so it runs only in pr-suite.yml and this job awaits that
        // run's outcome instead: the awaiter is then the step whose absence
        // would stop the gate gating.
        expect(
          testSteps().map(label),
          `on ${scenario.event} with docs_only=${scenario.docsOnly}, ` +
            `${scenario.runsSuite ? "exactly one" : "no"} executed step may invoke ` +
            `\`${TEST_SUITE_COMMAND}\`. Steps that execute a command here: ` +
            `${executedRunSteps().map(label).join(", ") || "none"}`,
        ).toHaveLength(scenario.runsSuite ? 1 : 0);
        expect(
          runsContaining(selected(), AWAIT_SUITE_COMMAND).map(label),
          `on ${scenario.event} with docs_only=${scenario.docsOnly}, ` +
            `${scenario.runsSuite ? "no" : "exactly one"} executed step may await the pull ` +
            `request suite`,
        ).toHaveLength(scenario.runsSuite ? 0 : 1);
      },
    );

    it(
      scenario.runsSuite
        ? "applies the migrations before it runs the tests"
        : "applies no migration, because it runs no pull-request code",
      () => {
        if (!scenario.runsSuite) {
          expect(
            runsContaining(selected(), MIGRATE_COMMAND).map(label),
            `on ${scenario.event} the verify job must not run \`${MIGRATE_COMMAND}\`: it executes the ` +
              `pull request's migration runner`,
          ).toEqual([]);
          return;
        }
        // The suite cannot pass against a schema it never applied. Ordering is
        // asserted as the one relative order that carries meaning; no absolute
        // index is pinned anywhere in this file, so moving an unrelated step
        // cannot fail it.
        const selectedSteps = selected();
        const migrate = selectedSteps.findIndex((step) => (step.run ?? "").includes(MIGRATE_COMMAND));
        const test = selectedSteps.findIndex((step) => (step.run ?? "").includes(TEST_SUITE_COMMAND));

        expect(
          migrate,
          `on ${scenario.event} the verify job must execute \`${MIGRATE_COMMAND}\``,
        ).toBeGreaterThan(-1);
        expect(
          test,
          `on ${scenario.event} the verify job must execute \`${TEST_SUITE_COMMAND}\``,
        ).toBeGreaterThan(-1);
        expect(
          migrate,
          `on ${scenario.event} the migrations must be applied before the tests run — a suite that ` +
            `runs against a schema it never applied can pass against the wrong database`,
        ).toBeLessThan(test);
      },
    );

    it(
      scenario.coverage
        ? "measures coverage alongside the tests"
        : "measures no coverage at all, because the change cannot move coverage",
      () => {
        const joined = selected()
          .flatMap((step) => (step.run ? [step.run] : []))
          .join("\n");
        const expectation =
          `on ${scenario.event} with docs_only=${scenario.docsOnly} the coverage measurement ` +
          `${scenario.coverage ? "must run" : "must not run"}: a docs-only change compares the same ` +
          `tree against itself, and a run that measured it anyway would report a number that means ` +
          `nothing. Steps that execute a command here: ${executedRunSteps().map(label).join(", ") || "none"}`;

        expect(coverageInvocations(), expectation).toHaveLength(scenario.coverage ? 1 : 0);
        expect(
          runsContaining(selected(), COVERAGE_FLOOR_COMMAND).map(label),
          `on ${scenario.event} with docs_only=${scenario.docsOnly} the coverage floor ` +
            `${scenario.floor ? "must be checked exactly once" : "must not be checked"}`,
        ).toHaveLength(scenario.floor ? 1 : 0);
        expect(joined.includes(COVERAGE_FLOOR_COMMAND), expectation).toBe(scenario.floor);
        // Every flag the step passes, one at a time, as a whole token of the
        // command: check-coverage-floor.ts and the patch-coverage step read
        // what these write, so a dropped flag is a silently unreadable
        // artifact rather than a smaller one.
        const coverageWords = shellWords(coverageInvocations()[0] ?? "");
        for (const flag of COVERAGE_FLAGS) {
          expect(
            coverageWords.includes(shellWords(flag)[0]!),
            `${expectation} — the coverage invocation must pass ${flag} as its own shell word, ` +
              `not merely as text inside a longer flag`,
          ).toBe(scenario.coverage);
        }
      },
    );

    it("computes and publishes the coverage artifacts exactly when it measures coverage", () => {
      // The three steps that carry `docs_only != 'true'` without running a
      // test: a mutation on any one of them leaves all ten files in tests/ci/
      // green (fix round 1, finding 4), because nothing asserted over their
      // EXECUTION before this.
      const selectedSteps = selected();
      for (const artifact of COVERAGE_ARTIFACTS) {
        const matching = verify.steps.filter(artifact.matches);

        expect(
          matching,
          `the verify job must carry exactly one step that produces ${artifact.label}, so the ` +
            `expectation below is about a step rather than about nothing`,
        ).toHaveLength(1);
        expect(
          selectedSteps.includes(matching[0]!),
          `on ${scenario.event} with docs_only=${scenario.docsOnly} ${artifact.label} must ` +
            `${scenario.coverage ? "" : "not "}execute: it carries the same docs_only condition as ` +
            `the test steps, and a condition that never fires leaves the artifact unproduced while ` +
            `the job concludes green`,
        ).toBe(scenario.coverage);
      }
    });

    it("tolerates the failure of no test or coverage step", () => {
      // Selected is not the same as gating: a step may be selected and still
      // have its failure ignored, which would leave the same green conclusion
      // this suite exists to deny, one level up.
      const gating = [
        ...testSteps(),
        ...runsContaining(selected(), COVERAGE_FLOOR_COMMAND),
        ...runsContaining(selected(), AWAIT_SUITE_COMMAND),
      ];
      for (const step of gating) {
        expect(
          step["continue-on-error"],
          `${label(step)} runs on ${scenario.event} and must not be continue-on-error — a tolerated ` +
            `failure does not gate the merge`,
        ).toBeFalsy();
      }
      expect(
        gating.length,
        `on ${scenario.event} at least one test, coverage or suite-awaiting step must exist to ` +
          `carry this check`,
      ).toBeGreaterThan(0);
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Half 3 — the trust boundary of the pull_request_target leg                    */
/* -------------------------------------------------------------------------- */

/**
 * Under pull_request_target the executed definition is the base branch's and
 * the job's token is the base repository's, so nothing the pull request
 * carries may execute there: not its package manager, its install scripts,
 * its tests or build, and not its copies of the integrity gates. The pull
 * request's code runs only in pr-suite.yml under `pull_request`; this leg
 * runs the BASE checkout's gate scripts over the pull request's merge tree
 * as data, plus the suite run's outcome as data.
 *
 * These assertions are over the steps the selector picks for each
 * pull_request_target scenario, so a step that becomes reachable under that
 * event is judged whatever its name, and a step that stops being reachable
 * stops satisfying the gate list below.
 */

const PRT_SCENARIOS = SCENARIOS.filter((scenario) => scenario.event === "pull_request_target");

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

/** The actions a pull_request_target step may use: none of them executes
 *  anything from the tree they operate on. */
const PRT_ACTIONS = ["actions/checkout@", "actions/setup-node@", "actions/download-artifact@"];

function unquoted(word: string): string {
  return word.replaceAll("'", "").replaceAll('"', "");
}

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
    if (!BASE_SCRIPT.test(unquoted(target))) {
      reasons.push(
        `runs \`${interpreter} ${target}\`, which does not resolve into the base checkout ` +
          `($GITHUB_WORKSPACE)`,
      );
    }
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

describe("the untrusted-execution detector the boundary assertions rely on", () => {
  it("accepts a base-checkout script invocation and plain git", () => {
    expect(untrustedExecutions('node "$GITHUB_WORKSPACE/scripts/check-migration-edits.ts" a b')).toEqual([]);
    expect(untrustedExecutions('python3 "${GITHUB_WORKSPACE}/scripts/commit_scopes.py" --root "$PR_TREE"')).toEqual([]);
    expect(untrustedExecutions('bash "$GITHUB_WORKSPACE/scripts/ci-base-freshness.sh"')).toEqual([]);
    expect(untrustedExecutions("git grep -nI -E 'x' -- .")).toEqual([]);
    expect(untrustedExecutions('echo "npm_config_registry is a job variable"')).toEqual([]);
  });

  it("refuses a package manager, a relative script and a pull-request-tree script", () => {
    expect(untrustedExecutions("pnpm test --run")).not.toEqual([]);
    expect(untrustedExecutions("x=$(npx tsc)")).not.toEqual([]);
    expect(untrustedExecutions("node scripts/check-migration-edits.ts HEAD^1 HEAD")).not.toEqual([]);
    expect(untrustedExecutions('cd "$PR_TREE" && node ./scripts/docs-only.ts HEAD^1')).not.toEqual([]);
    expect(untrustedExecutions('node "$PR_TREE/scripts/check-module-size.ts"')).not.toEqual([]);
    expect(untrustedExecutions('node "$PR_TREE/tool.mjs"')).not.toEqual([]);
    expect(untrustedExecutions("bash scripts/ci-base-freshness.sh")).not.toEqual([]);
    expect(untrustedExecutions("./scripts/run.sh")).not.toEqual([]);
    expect(untrustedExecutions('node -e "require(process.env.PR_TREE)"')).not.toEqual([]);
    expect(untrustedExecutions('node "$GITHUB_WORKSPACE/../pr-tree/scripts/x.ts"')).not.toEqual([]);
  });
});

for (const scenario of PRT_SCENARIOS) {
  describe(`the pull_request_target leg's trust boundary for ${scenario.label}`, () => {
    const selected = () => selectSteps(verify.steps, contextFor(scenario));

    it("runs no package manager and executes only the base checkout's scripts", () => {
      const offences = selected().flatMap((step) =>
        untrustedExecutions(step.run ?? "").map((reason) => `${label(step)}: ${reason}`),
      );
      expect(
        offences,
        "a step reachable under pull_request_target executes with the base repository's token " +
          "and definition, so it may run only the base checkout's gate scripts over the pull " +
          "request's tree as data — the pull request's own code runs in pr-suite.yml",
      ).toEqual([]);
    });

    it("uses only actions that execute nothing from the tree they touch", () => {
      const used = selected().flatMap((step) => (step.uses ? [step.uses] : []));
      expect(used.length).toBeGreaterThan(0);
      for (const uses of used) {
        expect(
          PRT_ACTIONS.some((prefix) => uses.startsWith(prefix)),
          `${uses} is reachable under pull_request_target; only ${PRT_ACTIONS.join(", ")} may be`,
        ).toBe(true);
      }
    });

    it("checks out the base branch by default, with full history and no persisted token", () => {
      const checkouts = selected().filter((step) => (step.uses ?? "").startsWith("actions/checkout@"));
      expect(checkouts).toHaveLength(1);
      expect(checkouts[0]?.with).toEqual({ "persist-credentials": false, "fetch-depth": 0 });
    });

    it("runs every integrity gate from the base checkout, and base freshness last", () => {
      const steps = selected();
      const gates = [
        { gate: "conflict markers", needle: "git grep -nI" },
        { gate: "docs-only classification", needle: "/scripts/docs-only.ts" },
        { gate: "module size ceilings", needle: "/scripts/check-module-size.ts" },
        { gate: "migration immutability", needle: "/scripts/check-migration-edits.ts" },
        { gate: "legal revision currency", needle: "/scripts/check-legal-revisions.ts" },
        { gate: "commit scopes", needle: "/scripts/commit_scopes.py" },
        { gate: "the pull request suite's outcome", needle: "/scripts/await-pr-suite.ts" },
        { gate: "base freshness", needle: "/scripts/ci-base-freshness.sh" },
      ];
      for (const { gate, needle } of gates) {
        expect(
          runsContaining(steps, needle).map(label),
          `${gate} must be judged by exactly one step under pull_request_target`,
        ).toHaveLength(1);
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

    it("judges the merge tree it materialised from the pull request's merge ref", () => {
      const steps = selected();
      const materialise = runsContaining(steps, "git worktree add --detach");
      expect(materialise, "exactly one step materialises the merge tree").toHaveLength(1);
      const step = materialise[0]!;
      expect(step.run).toContain('"+refs/pull/${PR_NUMBER}/merge:');
      expect(step.run).toContain('"+refs/pull/${PR_NUMBER}/head:');
      expect((step as { env?: Record<string, string> }).env).toEqual({
        PR_NUMBER: "${{ github.event.pull_request.number }}",
        HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
      });
      // Materialised before any gate reads it.
      expect(steps.indexOf(step)).toBeLessThan(
        steps.indexOf(runsContaining(steps, "git grep -nI")[0]!),
      );
    });

    it("refuses success unless the awaited run's id is a positive integer", () => {
      const steps = selected();
      const awaiter = runsContaining(steps, AWAIT_SUITE_COMMAND)[0]!;
      const required = steps.filter((step) =>
        Object.values((step as { env?: Record<string, string> }).env ?? {}).includes(
          `\${{ steps.${awaiter.id ?? "(no id)"}.outputs.run_id }}`,
        ) && (step.run ?? "").includes("RUN_ID"),
      );
      expect(awaiter.id, "the awaiter must carry an id its run_id output is read by").toBeDefined();
      expect(required.map(label), "exactly one step must check the run id").toHaveLength(1);
      expect(steps.indexOf(required[0]!)).toBeGreaterThan(steps.indexOf(awaiter));
    });

    it(
      scenario.floor
        ? "downloads the awaited run's coverage summary into the pull request tree, failing when absent"
        : "downloads nothing for a docs-only change",
      () => {
        const downloads = selected().filter((step) =>
          (step.uses ?? "").startsWith("actions/download-artifact@"),
        );
        expect(downloads).toHaveLength(scenario.floor ? 1 : 0);
        if (!scenario.floor) return;
        const awaiter = runsContaining(selected(), AWAIT_SUITE_COMMAND)[0]!;
        expect(downloads[0]?.with).toEqual({
          name: "coverage-summary",
          path: "${{ steps.pr-tree.outputs.path }}/coverage",
          "run-id": `\${{ steps.${awaiter.id}.outputs.run_id }}`,
          "github-token": "${{ github.token }}",
        });
        expect(downloads[0]?.["continue-on-error"]).toBeFalsy();
      },
    );
  });
}
