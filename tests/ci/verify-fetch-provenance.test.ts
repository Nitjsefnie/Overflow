import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The verify job's git fetches name trusted provenance, never a pull-request
 * ref.
 *
 * The checkout analysers read a `git fetch` whose command — or whose in-scope
 * environment, by NAME — carries the pull request's number as a fetch of
 * untrusted history, whatever the job later proves about the commit it lands.
 * ci.yml's verify job materialises the pull request's merge tree as data, so
 * the pattern it must not carry is a `refs/pull/<number>` refspec or a
 * PR-number env name on any step that fetches: the merge commit is named by
 * its event provenance instead, and the two-parent bind against the event's
 * head SHA stays the step's trust boundary — the check that fails closed
 * unless the fetched commit is exactly the merge this event is about.
 *
 * The analyser reads the workflow text, so these pins read it too: a
 * re-armed refspec or env name goes red here rather than in the next
 * default-branch analysis, which is hours away and closes nothing.
 */

type WorkflowStep = {
  name?: string;
  id?: string;
  run?: string;
  env?: Record<string, string | undefined>;
};

let steps: WorkflowStep[] = [];

beforeAll(async () => {
  const workflow = parse(await readFile(resolve(".github/workflows/ci.yml"), "utf8")) as {
    jobs?: { verify?: { steps?: WorkflowStep[] } };
  };
  steps = workflow.jobs?.verify?.steps ?? [];
});

/** A run block line that fetches from a remote. */
const FETCH = /\bgit\b[^\n]*\bfetch\b/;

/**
 * Env names the checkout analysers' pull-request-number heuristics match.
 * Matched against the NAME alone, never the expression it holds.
 */
const PR_NUMBER_NAME =
  /(^|[^A-Z0-9_])(PR_NUMBER|PR_ID|PULL_NUMBER|PULL_REQUEST_ID|PULL_REQUEST_NUMBER)([^A-Z0-9_]|$)/i;

function fetchSteps(): WorkflowStep[] {
  return steps.filter((step) => FETCH.test(step.run ?? ""));
}

describe("the verify job's git fetches", () => {
  it("carry no pull-request refspec in any step's run block", () => {
    const flagged = steps
      .filter((step) => (step.run ?? "").includes("refs/pull"))
      .map((step) => step.name ?? "(unnamed)");
    expect(
      flagged,
      "no verify step may name a refs/pull/<number> ref: the pull request's merge commit " +
        "enters by its event provenance, and the two-parent bind against the event's head " +
        "SHA is what makes the fetched commit the one this event is about",
    ).toEqual([]);
  });

  it("carry no env name the checkout analysers read as a pull-request number", () => {
    const flagged: string[] = [];
    for (const step of fetchSteps()) {
      for (const name of Object.keys(step.env ?? {})) {
        if (PR_NUMBER_NAME.test(name)) flagged.push(`${step.name ?? "(unnamed)"}: ${name}`);
      }
    }
    expect(
      flagged,
      "a step that fetches must carry no PR-number-named env — the analysers match the env " +
        "NAME itself, not only the expression it holds — so a fetch's inputs are named by " +
        "what they are trusted to be, never by the pull request they describe",
    ).toEqual([]);
  });

  it("materialise the merge tree by fetching exactly the event's merge commit", () => {
    const materialise = steps.filter((step) =>
      (step.run ?? "").includes("git worktree add --detach"),
    );
    expect(materialise, "exactly one step materialises the merge tree").toHaveLength(1);
    const step = materialise[0]!;

    // The merge commit by its event provenance, under a name no analyser
    // reads as a mutable pull-request ref (not PR_NUMBER, not *_HEAD_SHA for
    // the fetch's own input): the name is deliberately neutral because the
    // trust lives in the bind below, not in the spelling.
    expect(step.env?.MERGE_BIND_SHA).toBe("${{ github.event.pull_request.merge_commit_sha }}");
    expect(step.env?.HEAD_SHA).toBe("${{ github.event.pull_request.head.sha }}");
    expect(step.run).toContain('git fetch --no-tags origin "${MERGE_BIND_SHA:?}"');
    expect(step.run).not.toContain("PR_NUMBER");

    // The trust boundary is untouched: the fetched commit must be a
    // two-parent merge whose second parent is exactly the event's head SHA,
    // or the step fails closed.
    expect(step.run).toContain('[ "${second_parent}" != "${HEAD_SHA}" ]');
    expect(step.run).toContain("exit 1");
  });
});
