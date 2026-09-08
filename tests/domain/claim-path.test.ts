import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assessClaimPath } from "@/lib/domain/claim-path";

const restAssignment = 'gh api -X POST "repos/$REPO/issues/$ISSUE/assignees"';

function workflow(trigger: string, assignment = restAssignment) {
  return {
    path: ".github/workflows/claim.yml",
    content: `${trigger}\njobs:\n  claim:\n    steps:\n      - run: |\n          ${assignment.replaceAll("\n", "\n          ")}\n`,
  };
}

describe("claim path assessment", () => {
  for (const [keyName, key] of [
    ["bare on", "on"],
    ["quoted on", '"on"'],
    ["YAML 1.1 boolean key", "%YAML 1.1\n---\non"],
  ]) {
    it.each([
      ["scalar", ": issue_comment"],
      ["sequence", ": [issues, issue_comment]"],
      ["mapping", ":\n  issue_comment:\n    types: [created]"],
    ])(`accepts ${keyName} with a %s trigger`, (_shape, value) => {
      expect(assessClaimPath([workflow(`${key}${value}`)])).toBe("EVIDENCE_FOUND");
    });
  }

  it("rejects an issue-comment workflow without assignment", () => {
    expect(assessClaimPath([workflow("on: issue_comment", "echo hello")])).toBe("NO_EVIDENCE_FOUND");
  });

  it("rejects assignment triggered only by issues", () => {
    expect(assessClaimPath([workflow("on: issues")])).toBe("NO_EVIDENCE_FOUND");
  });

  it.each([
    ["REST", restAssignment],
    ["GraphQL", 'gh api graphql -f query="mutation { addAssigneesToAssignable(input: {}) { clientMutationId } }"'],
    ["Octokit", "await github.rest.issues.addAssignees({ owner, repo, issue_number, assignees });"],
  ])("accepts the %s assignment surface in raw script text", (_surface, assignment) => {
    expect(assessClaimPath([workflow("on: issue_comment", assignment)])).toBe("EVIDENCE_FOUND");
  });

  const broken = { path: ".github/workflows/broken.yml", content: "on: [issue_comment\n" };

  it("skips unparseable YAML before a qualifying workflow", () => {
    expect(assessClaimPath([broken, workflow("on: issue_comment")])).toBe("EVIDENCE_FOUND");
  });

  it("rejects unparseable YAML alone", () => {
    expect(assessClaimPath([broken])).toBe("NO_EVIDENCE_FOUND");
  });

  it("rejects an empty workflow list", () => {
    expect(assessClaimPath([])).toBe("NO_EVIDENCE_FOUND");
  });

  it("requires both signals in the same workflow", () => {
    expect(assessClaimPath([
      workflow("on: issue_comment", "echo hello"),
      workflow("on: issues"),
    ])).toBe("NO_EVIDENCE_FOUND");
  });

  it.each([
    ["semicolon", 'gh api -X POST -f "assignees[]=$ACTOR" repos/$REPO/issues/$ISSUE/assignees; echo assigned'],
    ["line continuation", 'gh api -X POST repos/$REPO/issues/$ISSUE/assignees\\\n  -f "assignees[]=$ACTOR"'],
    ["closing quote", restAssignment],
    ["line ending", 'gh api -X POST repos/$REPO/issues/$ISSUE/assignees'],
  ])("accepts a REST collection followed by a %s", (_terminator, assignment) => {
    expect(assessClaimPath([workflow("on: issue_comment", assignment)])).toBe("EVIDENCE_FOUND");
  });

  it.each([":disabled", "=disabled"])("rejects an assignees endpoint continued by %s", (suffix) => {
    const assignment = `gh api -X POST "repos/acme/demo/issues/42/assignees${suffix}" -f "assignees[]=$ACTOR"`;
    expect(assessClaimPath([workflow("on: issue_comment", assignment)])).toBe("NO_EVIDENCE_FOUND");
  });

  for (const method of ["-X POST", "--method POST", "-x post", "--METHOD post"]) {
    it(`deliberately reports NO_EVIDENCE_FOUND for ${method} when the repository is named removeAssignees`, () => {
      const assignment = `gh api ${method} "repos/acme/removeAssignees/issues/42/assignees" -f "assignees[]=$ACTOR"`;
      expect(assessClaimPath([workflow("on: issue_comment", assignment)])).toBe("NO_EVIDENCE_FOUND");
    });

    it(`deliberately reports NO_EVIDENCE_FOUND for ${method} with a DELETE comment`, () => {
      const assignment = `gh api ${method} "repos/acme/demo/issues/42/assignees" -f "assignees[]=$ACTOR"  # use -X DELETE to unclaim`;
      expect(assessClaimPath([workflow("on: issue_comment", assignment)])).toBe("NO_EVIDENCE_FOUND");
    });
  }

  it.each([
    ["POST comment", 'gh api -X DELETE "repos/acme/demo/issues/42/assignees" -f "assignees[]=$ACTOR" # use -X POST to claim'],
    ["POST to another endpoint", 'gh api -X POST repos/acme/demo/issues/42/comments -f body=unclaim; gh api -X DELETE "repos/acme/demo/issues/42/assignees" -f "assignees[]=$ACTOR"'],
  ])("rejects a DELETE collection call despite a %s", (_context, assignment) => {
    expect(assessClaimPath([workflow("on: issue_comment", assignment)])).toBe("NO_EVIDENCE_FOUND");
  });

  it("accepts assigning the commenter before deleting the claim comment across a shell continuation", () => {
    const assignment = 'gh api -X POST "repos/$REPO/issues/$ISSUE/assignees" -f "assignees[]=$ACTOR" && \\\n  gh api -X DELETE "repos/$REPO/issues/comments/$COMMENT"';
    expect(assessClaimPath([workflow("on: issue_comment", assignment)])).toBe("EVIDENCE_FOUND");
  });

  it.each(["&&", "||", ";", "|", "&"])("accepts assignment separated from an unrelated deletion by %s", (separator) => {
    const assignment = `${restAssignment} -f "assignees[]=$ACTOR" ${separator} gh api -X DELETE "repos/$REPO/issues/comments/$COMMENT"`;
    expect(assessClaimPath([workflow("on: issue_comment", assignment)])).toBe("EVIDENCE_FOUND");
  });

  it.each(["non:issues", "non=issues", "non$issues"])("rejects a longer REST path segment %s", (segment) => {
    expect(assessClaimPath([workflow("on: issue_comment", `gh api repos/acme/demo/${segment}/42/assignees`)])).toBe("NO_EVIDENCE_FOUND");
  });

  it("rejects a nested assignees endpoint", () => {
    expect(assessClaimPath([workflow("on: issue_comment", 'gh api "repos/acme/demo/issues/42/assignees/disabled"')])).toBe("NO_EVIDENCE_FOUND");
  });

  it("deliberately reports NO_EVIDENCE_FOUND for a trailing collection slash", () => {
    expect(assessClaimPath([workflow("on: issue_comment", 'gh api "repos/acme/demo/issues/42/assignees/"')])).toBe("NO_EVIDENCE_FOUND");
  });

  it("deliberately reports NO_EVIDENCE_FOUND for an empty shell expansion after assignees", () => {
    const assignment = 'EMPTY=""\ngh api "repos/acme/demo/issues/42/assignees${EMPTY}"';
    expect(assessClaimPath([workflow("on: issue_comment", assignment)])).toBe("NO_EVIDENCE_FOUND");
  });

  it("deliberately accepts the quoted semicolon suffix as a residual false EVIDENCE_FOUND", () => {
    const assignment = 'gh api "repos/acme/demo/issues/42/assignees;disabled"';
    expect(assessClaimPath([workflow("on: issue_comment", assignment)])).toBe("EVIDENCE_FOUND");
  });

  it("rejects a REST URL with a hyphenated non-issues segment", () => {
    expect(assessClaimPath([workflow("on: issue_comment", "gh api example.com/non-issues/123/assignees")])).toBe("NO_EVIDENCE_FOUND");
  });

  it("accepts an Octokit member access split across lines", () => {
    const assignment = "await github.rest.issues\n  . addAssignees({ owner, repo, issue_number, assignees });";
    expect(assessClaimPath([workflow("on: issue_comment", assignment)])).toBe("EVIDENCE_FOUND");
  });

  it.each([
    '-X DELETE',
    '--method DELETE',
    '-x delete',
    '--METHOD delete',
    '-XDELETE',
    '--method=DELETE',
    '-X "DELETE"',
    "-X 'DELETE'",
  ])("rejects a REST collection line naming deletion with %s", (deletion) => {
    expect(assessClaimPath([workflow("on: issue_comment", `gh api ${deletion} "repos/$REPO/issues/$ISSUE/assignees"`)])).toBe("NO_EVIDENCE_FOUND");
  });

  for (const [ending, newline] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
    it.each([
      ["before", `gh api -X DELETE \\${newline}  "repos/$REPO/issues/$ISSUE/assignees"`],
      ["after", `gh api "repos/$REPO/issues/$ISSUE/assignees" \\${newline}  -X DELETE`],
    ])(`rejects a DELETE method %s the endpoint across a ${ending} shell continuation`, (_order, assignment) => {
      expect(assessClaimPath([workflow("on: issue_comment", assignment)])).toBe("NO_EVIDENCE_FOUND");
    });
  }

  it.each(["removeAssignees", "removeAssigneesFromAssignable"])("rejects an unclaim command wrapped in a shell function named %s", (name) => {
    const assignment = `${name}() {\n  gh api --method DELETE "$@"\n}\n${name} "repos/$REPO/issues/$ISSUE/assignees" -f "assignees[]=$ACTOR"`;
    expect(assessClaimPath([workflow("on: issue_comment", assignment)])).toBe("NO_EVIDENCE_FOUND");
  });

  it("rejects a REST collection with an empty issue identifier", () => {
    expect(assessClaimPath([workflow("on: issue_comment", "gh api issues//assignees")])).toBe("NO_EVIDENCE_FOUND");
  });

  it("rejects a REST collection with a nonissues prefix", () => {
    expect(assessClaimPath([workflow("on: issue_comment", "gh api nonissues/42/assignees")])).toBe("NO_EVIDENCE_FOUND");
  });

  it("rejects a GraphQL mutation name with an extra suffix", () => {
    expect(assessClaimPath([workflow("on: issue_comment", "addAssigneesToAssignableDisabled")])).toBe("NO_EVIDENCE_FOUND");
  });

  it("rejects a slash instead of Octokit member access", () => {
    expect(assessClaimPath([workflow("on: issue_comment", "issues/addAssignees")])).toBe("NO_EVIDENCE_FOUND");
  });

  it("rejects an Octokit method name with an extra suffix", () => {
    expect(assessClaimPath([workflow("on: issue_comment", "issues.addAssigneesDisabled")])).toBe("NO_EVIDENCE_FOUND");
  });

  it("rejects malformed YAML even when raw text contains both signals", () => {
    expect(assessClaimPath([{
      path: ".github/workflows/broken.yml",
      content: "on: [issue_comment\n# issues.addAssignees",
    }])).toBe("NO_EVIDENCE_FOUND");
  });

  it("continues past a valid non-qualifying workflow", () => {
    expect(assessClaimPath([workflow("on: issues"), workflow("on: issue_comment")])).toBe("EVIDENCE_FOUND");
  });

  it("rejects a sequence trigger containing only issues", () => {
    expect(assessClaimPath([workflow("on: [issues]")])).toBe("NO_EVIDENCE_FOUND");
  });

  it("rejects a mapping trigger containing only issues", () => {
    expect(assessClaimPath([workflow("on: { issues: { types: [opened] } }")])).toBe("NO_EVIDENCE_FOUND");
  });

  it.each([
    ["empty document", ""],
    ["scalar document", "issue_comment"],
    ["sequence document", "[issue_comment]"],
    ["nested trigger", "jobs:\n  on: issue_comment"],
    ["event substring", "on: issue_comment_extra"],
  ])("rejects a %s without a top-level issue-comment trigger", (_shape, content) => {
    expect(assessClaimPath([{ path: "workflow.yml", content: `${content}\n# ${restAssignment}` }])).toBe("NO_EVIDENCE_FOUND");
  });

  it.each([
    "repos/$REPO/issues/$ISSUE/assignees-extra",
    "repos/$REPO/pulls/$ISSUE/assignees",
    "repos/$REPO/issues/$ISSUE/comments/assignees",
    "removeAssigneesFromAssignable",
    "issues.removeAssignees",
  ])("rejects a reference to a different surface: %s", (assignment) => {
    expect(assessClaimPath([workflow("on: issue_comment", assignment)])).toBe("NO_EVIDENCE_FOUND");
  });
});

describe("known limits of textual evidence, not guaranteed runtime assignment", () => {
  it.each([
    ["an Actions fallback || separator inside the quoted endpoint", 'gh api -X POST "repos/$REPO/issues/${{ github.event.issue.number || inputs.issue_number }}/assignees" -f "assignees[]=$ACTOR"'],
    ["a jq pipe separator inside the quoted endpoint command substitution", 'gh api -X POST "repos/$REPO/issues/$(jq -r \'.issue | .number\' "$GITHUB_EVENT_PATH")/assignees" -f "assignees[]=$ACTOR"'],
    ["a semicolon separator inside the quoted endpoint required-variable expansion", 'gh api -X POST "repos/$REPO/issues/${ISSUE:?Missing issue number; refusing to assign}/assignees" -f "assignees[]=$ACTOR"'],
  ])("deliberately reports NO_EVIDENCE_FOUND for %s", (_limit, assignment) => {
    const content = [
      "name: Claim an issue",
      "on:",
      "  issue_comment:",
      "    types: [created]",
      "permissions:",
      "  issues: write",
      "jobs:",
      "  claim:",
      "    if: github.event.comment.body == '/claim' && !github.event.issue.pull_request",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Assign the commenter",
      "        env:",
      "          GH_TOKEN: ${{ github.token }}",
      "          REPO: ${{ github.repository }}",
      "          ISSUE: ${{ github.event.issue.number }}",
      "          ACTOR: ${{ github.event.comment.user.login }}",
      "        run: |",
      "          set -euo pipefail",
      `          ${assignment}`,
      "",
    ].join("\n");

    expect(assessClaimPath([{ path: ".github/workflows/claim.yml", content }])).toBe("NO_EVIDENCE_FOUND");
  });

  it.each([
    ["a read-only GET on the assignees collection", 'gh api -X GET "repos/acme/demo/issues/42/assignees"'],
    ["a commented-out assignment command", `# ${restAssignment}`],
    ["a POST assigning a fixed maintainer instead of the commenter", 'gh api -X POST "repos/acme/demo/issues/42/assignees" -f "assignees[]=maintainer"'],
    ["an ampersand suffix inside the quoted endpoint", 'gh api -X POST "repos/acme/demo/issues/42/assignees&disabled"'],
    ["a path suffix appended after the closing quote", 'gh api -X POST "repos/acme/demo/issues/42/assignees"/disabled'],
  ])("reports EVIDENCE_FOUND for %s", (_limit, assignment) => {
    expect(assessClaimPath([workflow("on: issue_comment", assignment)])).toBe("EVIDENCE_FOUND");
  });

  it("reports EVIDENCE_FOUND for a job gated off by a false expression", () => {
    const gated = workflow("on: issue_comment");
    gated.content = gated.content.replace("  claim:\n", "  claim:\n    if: ${{ false }}\n");
    expect(assessClaimPath([gated])).toBe("EVIDENCE_FOUND");
  });
});

describe("reviewed shared claim action evidence", () => {
  const action = "Nitjsefnie-Actions/claim@d9976f1f803f7a662eed3be17772800b7925e650";
  const caller = (reference: string, trigger = "on: issue_comment") => ({
    path: ".github/workflows/claim.yml",
    content: `${trigger}\njobs:\n  claim:\n    steps:\n      - uses: ${reference}\n`,
  });

  it("recognizes the exact reviewed action in parsed job steps", () => {
    expect(assessClaimPath([caller(action)])).toBe("EVIDENCE_FOUND");
  });

  it.each([
    ["fake owner", "someone-else/claim@d9976f1f803f7a662eed3be17772800b7925e650"],
    ["suffixed action", "Nitjsefnie-Actions/claim-extra@d9976f1f803f7a662eed3be17772800b7925e650"],
    ["wrong SHA", "Nitjsefnie-Actions/claim@0000000000000000000000000000000000000000"],
    ["floating ref", "Nitjsefnie-Actions/claim@main"],
  ])("rejects a %s", (_reason, reference) => {
    expect(assessClaimPath([caller(reference)])).toBe("NO_EVIDENCE_FOUND");
  });

  it.each([
    ["comment", `on: issue_comment\n# uses: ${action}\n`],
    ["run text", `on: issue_comment\njobs:\n  claim:\n    steps:\n      - run: 'echo ${action}'\n`],
    ["job-level uses", `on: issue_comment\njobs:\n  claim:\n    uses: ${action}\n`],
    ["top-level steps", `on: issue_comment\nsteps:\n  - uses: ${action}\n`],
    ["non-list steps", `on: issue_comment\njobs:\n  claim:\n    steps:\n      uses: ${action}\n`],
    ["non-string uses", `on: issue_comment\njobs:\n  claim:\n    steps:\n      - uses: [${action}]\n`],
    ["malformed YAML", `on: [issue_comment\njobs:\n  claim:\n    steps:\n      - uses: ${action}\n`],
  ])("rejects a reference in %s", (_reason, content) => {
    expect(assessClaimPath([{ path: "workflow.yml", content }])).toBe("NO_EVIDENCE_FOUND");
  });

  it("still requires an issue-comment trigger", () => {
    expect(assessClaimPath([caller(action, "on: issues")])).toBe("NO_EVIDENCE_FOUND");
  });

  it("recognizes the actual repository caller", async () => {
    const path = ".github/workflows/claim.yml";
    expect(assessClaimPath([{ path, content: await readFile(resolve(path), "utf8") }]))
      .toBe("EVIDENCE_FOUND");
  });
});
