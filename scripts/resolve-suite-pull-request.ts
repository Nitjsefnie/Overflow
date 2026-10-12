#!/usr/bin/env node
// Base-checkout resolver for ci-pr.yml's completion-triggered verify job.
// Mirrors coverage-comment.yml's issue-656 binding: query open PRs using
// head=owner:branch, then select the exact head repository and SHA (forks
// included). Keep the two bindings in step. Unlike the comment workflow,
// missing, ambiguous or stale destinations fail the required verify check.
// Inputs: GITHUB_REPOSITORY, GH_TOKEN, SUITE_RUN_ID, optional GITHUB_OUTPUT.

import { realpathSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export interface ResolveDeps {
  env: Record<string, string | undefined>;
  fetchFn: typeof fetch;
}

export interface ResolveOutcome {
  exitCode: 0 | 1;
  lines: string[];
  outputs?: { pr_number: string; head_sha: string; base_sha: string; base_ref: string };
}

type RecordValue = Record<string, unknown>;
const SHA = /^[0-9a-f]{40}$/;
const SEGMENT = "[A-Za-z0-9_-][A-Za-z0-9_.-]*";
const REPOSITORY = new RegExp(`^${SEGMENT}/${SEGMENT}$`);

function record(value: unknown): RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue : {};
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Every read fails closed, is uncached, and has a bounded request lifetime. */
async function apiGet(deps: ResolveDeps, url: URL): Promise<unknown> {
  const response = await deps.fetchFn(url, {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "cache-control": "no-cache",
      authorization: `Bearer ${deps.env.GH_TOKEN}`,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub API read failed: HTTP ${response.status}`);
  return response.json();
}

/** API-derived PR values only; no PR content is checked out or executed. */
export async function resolveSuitePullRequest(deps: ResolveDeps): Promise<ResolveOutcome> {
  try {
    const repo = deps.env.GITHUB_REPOSITORY ?? "";
    if (!REPOSITORY.test(repo)) throw new Error("GITHUB_REPOSITORY must name OWNER/REPO");
    if (!deps.env.GH_TOKEN) throw new Error("GH_TOKEN is required");
    const idText = deps.env.SUITE_RUN_ID ?? "";
    if (!/^[1-9][0-9]*$/.test(idText) || !positiveId(Number(idText))) {
      throw new Error("SUITE_RUN_ID must be a positive safe integer");
    }
    const root = `https://api.github.com/repos/${repo}`;
    const run = record(await apiGet(deps, new URL(`${root}/actions/runs/${idText}`)));
    if (run.id !== Number(idText)) throw new Error("the upstream run id does not match SUITE_RUN_ID");
    if (run.path !== ".github/workflows/pr-suite.yml") throw new Error("the upstream path must be .github/workflows/pr-suite.yml");
    if (run.event !== "pull_request") throw new Error("the upstream event must be pull_request");
    if (run.status !== "completed") throw new Error("the upstream run must be completed");
    if (run.conclusion !== "success") throw new Error("the upstream run must conclude success");
    if (typeof run.head_sha !== "string" || !SHA.test(run.head_sha)) {
      throw new Error("the upstream head SHA must be a 40-hex SHA");
    }
    const headRepo = record(run.head_repository);
    const owner = record(headRepo.owner).login;
    if (typeof headRepo.full_name !== "string" || !REPOSITORY.test(headRepo.full_name) ||
        typeof owner !== "string" || owner !== headRepo.full_name.split("/")[0]) {
      throw new Error("the upstream head repository must exist and name its owner");
    }
    if (typeof run.head_branch !== "string" || run.head_branch === "") {
      throw new Error("the upstream head branch is missing");
    }
    const matchesHead = (pr: RecordValue): boolean => {
      const head = record(pr.head);
      return record(head.repo).full_name === headRepo.full_name &&
        head.ref === run.head_branch && head.sha === run.head_sha;
    };
    const matches: RecordValue[] = [];
    for (let page = 1; ; page += 1) {
      const url = new URL(`${root}/pulls`);
      url.searchParams.set("state", "open");
      url.searchParams.set("head", `${owner}:${run.head_branch}`);
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      const prs = await apiGet(deps, url);
      if (!Array.isArray(prs)) throw new Error("the open pull request listing is not an array");
      matches.push(...prs.map(record).filter(matchesHead));
      if (matches.length > 1) throw new Error("more than one open pull request matches the upstream head; refusing an ambiguous destination");
      if (prs.length < 100) break;
    }
    const selected = matches[0];
    if (selected === undefined) throw new Error("no open pull request matches the upstream head repository, branch and SHA (possibly stale)");
    if (!positiveId(selected.number)) throw new Error("the matched pull request has no usable number");

    // The listing may race a synchronize or close. Re-read the PR's current
    // head before emitting anything, and retain the repository/branch bind.
    const current = record(await apiGet(deps, new URL(`${root}/pulls/${selected.number}`)));
    if (current.number !== selected.number || current.state !== "open" || !matchesHead(current)) {
      throw new Error("the matched pull request closed or its head moved; stale suite run refused");
    }
    const base = record(current.base);
    if (typeof base.sha !== "string" || !SHA.test(base.sha) ||
        typeof base.ref !== "string" || base.ref === "" || /[\s\x00-\x1f\x7f]/.test(base.ref)) {
      throw new Error("the matched pull request has no usable base SHA and ref");
    }
    const outputs = {
      pr_number: String(current.number), head_sha: run.head_sha,
      base_sha: base.sha, base_ref: base.ref,
    };
    if (deps.env.GITHUB_OUTPUT) {
      await appendFile(deps.env.GITHUB_OUTPUT,
        Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""), "utf8");
    }
    return { exitCode: 0, lines: [`Resolved suite run ${idText} to pull request ${current.number}`], outputs };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error))
      .replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    return { exitCode: 1, lines: [`::error::${message}`] };
  }
}

const invoked = process.argv[1];
if (invoked !== undefined && realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = 1;
  void resolveSuitePullRequest({ env: process.env, fetchFn: fetch }).then((outcome) => {
    for (const line of outcome.lines) console.log(line);
    process.exitCode = outcome.exitCode;
  });
}
