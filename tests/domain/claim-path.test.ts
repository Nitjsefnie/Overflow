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

// Snapshot of this repository's claim workflow; no runtime filesystem dependency.
const repositoryClaimWorkflow = [
  "name: claim",
  "",
  "# Lets a contributor take an issue without repository write access. GitHub's",
  "# built-in slash commands do not include assignment, so self-assignment",
  "# otherwise needs someone with write access to use the assignee control.",
  "#",
  "# This is the whole claiming mechanic for Overflow, not a convenience. Overflow",
  "# reads claim state from the GitHub assignee and never writes it, and available",
  "# headroom is settled balance minus the reserve points of open issues assigned",
  "# to outside contributors — so the assignee field is what reserves a sponsor's",
  "# credit. Without this, the people Overflow calls outside contributors are",
  "# exactly the people who cannot perform the action it prices.",
  "#",
  "# The assignment fires an `issues` `assigned` webhook, which Overflow already",
  "# accepts and reconciles, so the claim reaches the ledger with no further",
  "# wiring.",
  "#",
  "# `/claim` assigns the commenter to an unassigned open issue. `/unclaim` and",
  "# `/release` are the same command under two names — both remove the",
  "# commenter's OWN assignment and nobody else's, a DELETE naming exactly one",
  "# login, so a second assignee is left in place. Two names because the",
  "# reference implementation this was modelled on calls it `/release` and people",
  "# arrive expecting that word.",
  "#",
  "# The comment body is attacker-controlled text from a public repository, so it",
  "# reaches the script through the environment and is never interpolated into",
  "# it. The `if:` below is only a cheap prefilter; the exact match happens in the",
  "# script, because expressions have no trim().",
  "",
  "on:",
  "  issue_comment:",
  "    types: [created]",
  "",
  "# The narrowest token that can assign. Nothing here reads the tree, so there",
  "# is no contents: read and no checkout: the job talks to the API only.",
  "permissions:",
  "  issues: write",
  "",
  "concurrency:",
  "  # Per issue, and NOT cancel-in-progress. Two people claiming at once must",
  "  # both get an answer: cancelling the first would leave the loser of the race",
  "  # with silence, and cancelling the second would leave it unanswered.",
  "  group: claim-${{ github.event.issue.number }}",
  "  cancel-in-progress: false",
  "",
  "jobs:",
  "  claim:",
  "    # A pull request is an issue to this event, and its assignees mean",
  "    # something else. A closed issue cannot be worked. A bot's comment is",
  "    # never a claim.",
  "    if: >-",
  "      github.event.issue.pull_request == null",
  "      && github.event.issue.state == 'open'",
  "      && github.event.comment.user.type != 'Bot'",
  "      && (contains(github.event.comment.body, '/claim')",
  "          || contains(github.event.comment.body, '/unclaim')",
  "          || contains(github.event.comment.body, '/release'))",
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 5",
  "",
  "    steps:",
  "      - name: Claim or unclaim",
  "        env:",
  "          GH_TOKEN: ${{ github.token }}",
  "          REPO: ${{ github.repository }}",
  "          ISSUE: ${{ github.event.issue.number }}",
  "          ACTOR: ${{ github.event.comment.user.login }}",
  "          BODY: ${{ github.event.comment.body }}",
  "        run: |",
  "          set -euo pipefail",
  "",
  "          # Exact match on the trimmed body, so \"please /claim this when you",
  "          # can\" is a sentence rather than a command. \\r is stripped first:",
  "          # a comment posted from a Windows client carries them.",
  "          command=\"$(printf '%s' \"$BODY\" | tr -d '\\r' \\",
  "            | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')\"",
  "          case \"$command\" in",
  "            /claim|/unclaim|/release) ;;",
  "            *) echo \"not a command: ${command%%$'\\n'*}\"; exit 0 ;;",
  "          esac",
  "",
  "          say() {",
  "            gh api \"repos/$REPO/issues/$ISSUE/comments\" -f body=\"$1\" --silent",
  "          }",
  "          assignees() {",
  "            gh api \"repos/$REPO/issues/$ISSUE\" --jq '.assignees[].login'",
  "          }",
  "          held_by_actor() {",
  "            assignees | grep -Fxq \"$ACTOR\"",
  "          }",
  "",
  "          if [ \"$command\" = /unclaim ] || [ \"$command\" = /release ]; then",
  "            if ! held_by_actor; then",
  "              say \"@$ACTOR you are not assigned to this issue, so there is nothing to give up.\"",
  "              exit 0",
  "            fi",
  "            # DELETE names one login, so any other assignee stays.",
  "            gh api -X DELETE \"repos/$REPO/issues/$ISSUE/assignees\" \\",
  "              -f \"assignees[]=$ACTOR\" --silent",
  "            say \"Unassigned @$ACTOR.\"",
  "            exit 0",
  "          fi",
  "",
  "          current=\"$(assignees | paste -sd' ' -)\"",
  "          if [ -n \"$current\" ]; then",
  "            if held_by_actor; then",
  "              say \"@$ACTOR you already have this one.\"",
  "            else",
  "              say \"This issue is already claimed by $(assignees | sed 's/^/@/' | paste -sd', ' -). Comment \\`/unclaim\\` (or \\`/release\\`) if you are giving it up.\"",
  "            fi",
  "            exit 0",
  "          fi",
  "",
  "          gh api -X POST \"repos/$REPO/issues/$ISSUE/assignees\" \\",
  "            -f \"assignees[]=$ACTOR\" --silent",
  "          # GitHub silently ignores an assignee it will not accept, so the",
  "          # assignment is confirmed rather than assumed.",
  "          if held_by_actor; then",
  "            say \"Assigned to @$ACTOR.\"",
  "          else",
  "            say \"GitHub would not accept @$ACTOR as an assignee here. That usually means the account needs to have commented on or been granted access to this repository.\"",
  "            exit 1",
  "          fi",
].join("\n");

it("recognizes the repository claim workflow", () => {
  expect(assessClaimPath([{
    path: ".github/workflows/claim.yml",
    content: repositoryClaimWorkflow,
  }])).toBe("EVIDENCE_FOUND");
});
