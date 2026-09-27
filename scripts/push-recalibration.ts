#!/usr/bin/env node
// Recalibration push (issue 684): the commit-and-push half of the coverage
// floor calibrate job, as its own step so a refused push can never read as
// green again.
//
//   node scripts/push-recalibration.ts
//
// Commits scripts/coverage.json as github-actions[bot] and pushes
// HEAD:refs/heads/main. The token rides in the push URL alone — the URL is
// an argument, never a `git remote` — so it cannot reach .git/config or the
// log output. A refused push is expected: main's branch protection cannot be
// satisfied by a GITHUB_TOKEN push, so the script fetches the remote main,
// rebases, and retries once. On a failed rebase or a second refusal it
// prints a ::error:: workflow command naming the measured and recorded
// floors, the cause, and the manual remedy, then exits 1. Nothing but a
// landed push exits 0.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DOC_PATH, repoRoot, type CoverageFloorDoc } from "./check-coverage-floor.ts";

const BOT_NAME = "github-actions[bot]";
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
const COMMIT_MESSAGE = "ci: update CI ratchets";
const BRANCH = "refs/heads/main";

// Secrets that must never reach the output. The push and fetch URLs carry
// the token, and git echoes failing URLs verbatim, so every line this
// script prints passes through redact().
const secrets: string[] = [];
function redact(text: string): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== "") out = out.replaceAll(secret, "***");
  }
  return out;
}

// Network git commands must fail, not hang waiting for credentials.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" };

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: GIT_ENV });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${redact(result.stderr ?? result.stdout ?? "")}`);
  }
  return (result.stdout ?? "").trim();
}

// Identity set per command, like the push URL: nothing about the bot is
// persisted to the repository's config either.
function asBot(args: string[]): string[] {
  return ["-c", `user.name=${BOT_NAME}`, "-c", `user.email=${BOT_EMAIL}`, ...args];
}

function pushUrl(): string {
  const override = process.env.PUSH_REMOTE_URL;
  if (override !== undefined && override !== "") {
    return override;
  }
  return `https://x-access-token:${process.env.GH_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git`;
}

function floorAt(root: string, revision: string): number {
  const doc = JSON.parse(git(root, ["show", `${revision}:${DOC_PATH}`])) as CoverageFloorDoc;
  return doc.languages.typescript.floor;
}

// The refusal alarm. Runs once the push has definitely failed for good;
// exits 1 even when the floors themselves cannot be read, so the alarm
// cannot be swallowed by a secondary failure.
function refuse(root: string, detail: string): never {
  let floors: string;
  try {
    floors =
      `recorded floor ${floorAt(root, "HEAD^1")}% vs ` +
      `measured floor ${floorAt(root, "HEAD")}%`;
  } catch {
    floors = "the floors could not be read from HEAD^1 and HEAD (shallow checkout?)";
  }
  console.log(
    redact(
      `::error::coverage-floor recalibration refused (${detail}): ${floors}. ` +
        "Cause: main's branch protection refuses pushes from GITHUB_TOKEN — a bot commit " +
        "can never carry the required checks. Remedy: record the raise by hand: run the " +
        "suite with coverage, run node scripts/calibrate-coverage.ts, commit " +
        "scripts/coverage.json, open an ordinary pull request — CONTRIBUTING.md, " +
        "'Coverage is floored'.",
    ),
  );
  process.exit(1);
}

function tryPush(root: string, url: string): boolean {
  const result = spawnSync("git", ["push", url, `HEAD:${BRANCH}`], {
    cwd: root,
    encoding: "utf8",
    env: GIT_ENV,
  });
  if (result.status !== 0) {
    console.error(redact(result.stderr ?? "").trim());
    return false;
  }
  return true;
}

function main(): void {
  const root = repoRoot();
  // diff --quiet: exit 0 means the doc is unchanged, 1 means calibrate
  // wrote a new one.
  const diff = spawnSync("git", ["diff", "--quiet", "--", DOC_PATH], {
    cwd: root,
    encoding: "utf8",
  });
  if (diff.status === 0) {
    console.log("coverage floor already current; nothing to push");
    return;
  }
  const token = process.env.GH_TOKEN;
  const slug = process.env.GITHUB_REPOSITORY;
  if (
    token === undefined ||
    token === "" ||
    slug === undefined ||
    slug === ""
  ) {
    console.error(
      "coverage floor recalibration: GH_TOKEN and GITHUB_REPOSITORY are required to push",
    );
    process.exit(2);
  }
  secrets.push(token);
  const url = pushUrl();
  try {
    git(root, ["add", DOC_PATH]);
    git(root, asBot(["commit", "-m", COMMIT_MESSAGE]));
  } catch (error) {
    // Leave nothing staged behind on the way out.
    spawnSync("git", ["reset", "-q", "--", DOC_PATH], { cwd: root });
    console.error(redact(`coverage floor recalibration: could not commit: ${String(error)}`));
    process.exit(1);
  }
  try {
    if (tryPush(root, url)) {
      console.log(`coverage floor recalibration: pushed ${git(root, ["rev-parse", "HEAD"])} to main`);
      return;
    }
    // Refused. Expected whenever a warranted raise races main or protection
    // refuses bots: fetch the remote main, replay, retry once.
    const fetched = spawnSync("git", ["fetch", "--depth=2", url, "main"], {
      cwd: root,
      encoding: "utf8",
      env: GIT_ENV,
    });
    if (fetched.status !== 0) {
      console.error(redact(fetched.stderr ?? "").trim());
      refuse(root, "could not fetch main after the refusal");
    }
    const rebased = spawnSync("git", asBot(["rebase", "FETCH_HEAD"]), {
      cwd: root,
      encoding: "utf8",
      env: GIT_ENV,
    });
    if (rebased.status !== 0) {
      spawnSync("git", ["rebase", "--abort"], { cwd: root });
      console.error(redact(rebased.stderr ?? "").trim());
      refuse(root, "rebase onto main failed");
    }
    if (tryPush(root, url)) {
      console.log(`coverage floor recalibration: pushed ${git(root, ["rev-parse", "HEAD"])} to main`);
      return;
    }
    refuse(root, "push refused twice");
  } catch (error) {
    // Never leave a rebase in progress behind, whatever threw.
    spawnSync("git", ["rebase", "--abort"], { cwd: root });
    console.error(redact(`coverage floor recalibration: ${String(error)}`));
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
