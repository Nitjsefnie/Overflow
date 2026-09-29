import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { parse } from "yaml";

/**
 * The relay mints its App installation token from the LEDGER_APP_ID and
 * LEDGER_INSTALLATION_ID literals pinned in its step env, so a silently
 * altered literal repoints every relay posting at another App installation
 * whose check-runs protection and the deploy gate read as the ledger App's —
 * and the suite gave it no cover: the final review's mutant (5118624 for
 * 5118623) survived all 129 tests. This suite holds the workflow file to the
 * exact literals; the script-side wiring around them is covered by
 * tests/scripts/ledger-relay.test.ts.
 *
 * Assertions are made on the parsed YAML data, never on the raw bytes, so
 * reformatting the step does not disturb them and a changed, added or
 * duplicated literal fails loudly here instead of quietly repointing the
 * relay.
 */
type WorkflowStep = { name?: string; env?: Record<string, string | undefined> };

describe("the ledger relay workflow's pinned App identity", () => {
  let steps: WorkflowStep[] = [];

  beforeAll(async () => {
    const source = await readFile(resolve(".github/workflows/ledger-relay.yml"), "utf8");
    const workflow = parse(source) as {
      jobs?: Record<string, { steps?: WorkflowStep[] }>;
    };

    steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
  });

  /** Every step-env value the workflow carries for one of the pinned names. */
  const envValues = (name: string): unknown[] =>
    steps.flatMap((step) => (step.env?.[name] === undefined ? [] : [step.env[name]]));

  it("carries the ledger App id exactly once, as the literal the gate and tests pin", () => {
    expect(
      envValues("LEDGER_APP_ID"),
      "the relay job must carry env LEDGER_APP_ID exactly once — the App id every " +
        "relay check-run is posted under, which branch protection and the deploy " +
        "gate read back",
    ).toEqual(["5118623"]);
  });

  it("carries the App installation id exactly once, as the pinned literal", () => {
    expect(
      envValues("LEDGER_INSTALLATION_ID"),
      "the relay job must carry env LEDGER_INSTALLATION_ID exactly once — the " +
        "installation the step mints its token for",
    ).toEqual(["166057493"]);
  });
});
