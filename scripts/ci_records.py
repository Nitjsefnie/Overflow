"""Classify main pushes and find the ci run that measured a record-only tip."""
import json
import os
import re
import subprocess
import sys
import time

RECORDS = {b".github/" + name for name in (
    b"size-baseline.json", b"comment-share.json", b"ci-thresholds.json", b"test-times.json",
)}


def changes(base):
    paths = subprocess.check_output([
        "git", "diff", "--name-only", "-z", "--no-renames", "--ignore-submodules=none",
        base, "HEAD", "--",
    ])
    return set(paths.rstrip(b"\0").split(b"\0")) if paths else set()


def records_only(before):
    if (os.environ["GITHUB_EVENT_NAME"] != "push" or os.environ["GITHUB_REF"] != "refs/heads/main"
            or not re.fullmatch("[0-9a-f]{40}", before)):
        return False
    if subprocess.run(["git", "merge-base", "--is-ancestor", before, "HEAD"]).returncode:
        return False
    paths = changes(before)
    return bool(paths) and paths <= RECORDS


def api(endpoint):
    command = ["gh", "api", f"repos/{os.environ['GITHUB_REPOSITORY']}/actions/{endpoint}"]
    # Ride out a transient 5xx or rate limit.
    for delay in (5, 10, 20, 40):
        try:
            return json.loads(subprocess.check_output(command))
        except subprocess.CalledProcessError as error:
            print(f"gh api {endpoint} exited {error.returncode}; retrying in {delay} s", file=sys.stderr, flush=True)
            time.sleep(delay)
    return json.loads(subprocess.check_output(command))


def items(endpoint, key):
    page = 1
    separator = "&" if "?" in endpoint else "?"
    while True:
        rows = api(f"{endpoint}{separator}per_page=100&page={page}")[key]
        yield from rows
        if len(rows) < 100:
            return
        page += 1


def unusable(message):
    print(f"{message}; the tip runs its own test matrix", file=sys.stderr, flush=True)
    return ""


def measured_run(run):
    """None for an intervening record-only push, "" for a code run it cannot borrow, else a proven producer."""
    run_id = run["id"]
    while True:
        # A failed-jobs-only rerun can reuse successful shards from an earlier
        # attempt. Keep each job's newest execution, as report does for artifacts.
        jobs = {}
        for job in items(f"runs/{run_id}/jobs?filter=all", "jobs"):
            name = job["name"]
            if name not in jobs or job["run_attempt"] > jobs[name]["run_attempt"]:
                jobs[name] = job
        results = {name: job["conclusion"] for name, job in jobs.items()}
        # Only a records-only push starts record-source.
        source = jobs.get("record-source", {"status": "completed", "conclusion": "skipped"})
        if source["status"] == "in_progress" or source["status"] == "completed" and source["conclusion"] != "skipped":
            return None
        if run["status"] == "completed":
            shards = [result for name, result in results.items() if name.startswith("test (")]
            if (run["conclusion"] != "success" or results.get("plan") != "success"
                    or not shards or any(result != "success" for result in shards)):
                return unusable(f"ci run {run_id} did not successfully test the code")
            # report can warn about a missing shard and leave its times unwritten.
            # Refuse a partial or expired set before treating it as the matrix.
            artifacts = {a["name"] for a in items(f"runs/{run_id}/artifacts", "artifacts")
                         if not a["expired"] and a["name"].startswith("test-ratchet-")}
            if len(artifacts) != len(shards):
                return unusable(f"ci run {run_id} has {len(artifacts)} artifacts for {len(shards)} shards")
            return run_id
        print(f"Waiting for ci run {run_id}", file=sys.stderr, flush=True)
        time.sleep(20)
        run = api(f"runs/{run_id}")


def source_run(before):
    # A rebase merge may have several commits but only its pushed tip has a
    # run. Skip earlier record runs even while their reports are still waiting.
    for sha in subprocess.check_output(["git", "rev-list", "--first-parent", before], text=True).splitlines():
        endpoint = f"workflows/ci.yml/runs?branch=main&event=push&head_sha={sha}"
        runs = api(endpoint)["workflow_runs"]
        if sha == before:  # a [skip ci] push never gets a run
            for delay in (5, 10, 20):
                if runs:
                    break
                time.sleep(delay)
                runs = api(endpoint)["workflow_runs"]
        if not runs:
            continue
        if len(runs) != 1:
            raise ValueError(f"expected one main ci push run at {sha}, found {len(runs)}")
        run = runs[0]
        if (run["path"] != ".github/workflows/ci.yml" or run["event"] != "push"
                or run["head_branch"] != "main" or run["head_sha"] != sha
                or run["head_repository"]["full_name"] != os.environ["GITHUB_REPOSITORY"]
                or changes(sha) - RECORDS):
            raise ValueError(f"run {run['id']} is not a main push over the same code")
        source = measured_run(run)
        if source is not None:
            return source
    raise ValueError("no tested main push found for the record-only tip")


if __name__ == "__main__":
    before_sha = os.environ.get("OVERFLOW_BEFORE_SHA", "")
    if sys.argv[1:] == ["classify"]:
        print("records-only=" + str(records_only(before_sha)).lower())
    elif sys.argv[1:] == ["source"] and records_only(before_sha):
        print(f"run-id={source_run(before_sha)}")
    else:
        sys.exit("expected classify, or source on a record-only push")
