#!/usr/bin/env python3
"""Rerun a completed `ci` run once when leaf jobs died to runner/infra cancel.

This is the decision + action helper for `.github/workflows/rerun.atom.yml`.
It is intentionally narrow:

- only `pull_request` / `merge_group` ci runs
- only while `run_attempt < max_attempt` (default 2 → one automatic retry)
- only when at least one job looks like an infra/spot cancel, not a real
  assertion failure
- only when the run's head SHA is still the live PR head or still sitting in
  the main merge queue

Skip paths exit 0. Hard API/protocol errors exit non-zero so the atom job is
visible when the helper itself is broken.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

DEFAULT_MAX_ATTEMPT = 2
ALLOWED_EVENTS = frozenset({"pull_request", "merge_group"})
RETRYABLE_CONCLUSIONS = frozenset({"failure", "cancelled", "timed_out"})

# Annotations / log fingerprints observed on Nexu ARC + AWS spot kills.
# Keep this list tight: plain Playwright assertion failures must not match.
INFRA_CANCEL_MARKERS = (
    "The runner has received a shutdown signal",
    "SpotInterrupted",
    "pod deleted",
    "Node is shutting down",
)


GhRequest = Callable[[str, str, dict[str, str] | None, str | None], Any]


class Skip(Exception):
    """Eligible-gate miss; atom job should succeed without rerunning."""


class HelperError(Exception):
    """Helper/protocol failure; atom job should fail visibly."""


def fail(message: str) -> None:
    raise HelperError(message)


def emit(message: str) -> None:
    print(message, flush=True)


def parse_int(raw: str | None, label: str, *, default: int | None = None) -> int:
    if raw is None or raw == "":
        if default is None:
            fail(f"Missing required {label}")
        return default
    if not re.fullmatch(r"[0-9]+", raw):
        fail(f"{label} must be a positive integer, got {raw!r}")
    value = int(raw)
    if value <= 0:
        fail(f"{label} must be positive, got {value}")
    return value


def require_text(raw: str | None, label: str) -> str:
    if raw is None or not raw.strip():
        fail(f"Missing required {label}")
    return raw.strip()


def require_sha(raw: str | None, label: str) -> str:
    value = require_text(raw, label).lower()
    if not re.fullmatch(r"[0-9a-f]{40}", value):
        fail(f"{label} must be a 40-character lowercase hex SHA, got {raw!r}")
    return value


def job_step_cancelled(job: dict[str, Any]) -> bool:
    steps = job.get("steps") or []
    return any(isinstance(step, dict) and step.get("conclusion") == "cancelled" for step in steps)


def annotation_blob(annotations: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for item in annotations:
        if not isinstance(item, dict):
            continue
        for key in ("message", "title", "raw_details"):
            value = item.get(key)
            if isinstance(value, str) and value:
                parts.append(value)
    return "\n".join(parts)


def has_infra_marker(text: str) -> bool:
    return any(marker in text for marker in INFRA_CANCEL_MARKERS)


def job_looks_like_infra_cancel(job: dict[str, Any], annotations: list[dict[str, Any]]) -> bool:
    """Return True only for runner-lost / spot-style cancels.

    Real test failures stay False even when Playwright left pages closed after a
    normal assertion timeout.
    """
    conclusion = job.get("conclusion")
    blob = annotation_blob(annotations)

    if has_infra_marker(blob):
        return True

    # A fully cancelled leaf job with no prior success path is the common
    # cancel-in-progress / node-kill shape when annotations are empty.
    if conclusion == "cancelled":
        return True

    # Observed Nexu shape: job conclusion=failure, the test step is cancelled,
    # and annotations carry the shutdown signal (handled above). If annotations
    # are missing but the only non-success step is cancelled, treat conservatively
    # as non-infra unless a marker is present.
    if conclusion == "failure" and job_step_cancelled(job) and has_infra_marker(blob):
        return True

    return False


def collect_infra_cancel_jobs(
    jobs: list[dict[str, Any]],
    annotations_by_job_id: dict[int, list[dict[str, Any]]],
) -> list[str]:
    names: list[str] = []
    for job in jobs:
        if not isinstance(job, dict):
            continue
        job_id = job.get("id")
        if not isinstance(job_id, int):
            continue
        if job.get("conclusion") in {None, "success", "skipped"}:
            continue
        annotations = annotations_by_job_id.get(job_id, [])
        if job_looks_like_infra_cancel(job, annotations):
            name = job.get("name")
            names.append(name if isinstance(name, str) and name else f"job-{job_id}")
    return names


def decide(
    *,
    event_name: str,
    conclusion: str | None,
    run_attempt: int,
    max_attempt: int,
    head_sha: str,
    infra_job_names: list[str],
    live_pr_head_sha: str | None,
    merge_queue_head_shas: set[str] | None,
) -> tuple[bool, str]:
    """Pure eligibility gate. Returns (should_rerun, reason)."""
    if event_name not in ALLOWED_EVENTS:
        return False, f"skip: unsupported event {event_name!r}"
    if run_attempt >= max_attempt:
        return False, f"skip: run_attempt {run_attempt} >= max_attempt {max_attempt}"
    if conclusion not in RETRYABLE_CONCLUSIONS:
        return False, f"skip: conclusion {conclusion!r} is not retryable"

    if not infra_job_names:
        return False, "skip: no infra-cancel fingerprint on failed/cancelled jobs"

    if event_name == "pull_request":
        if not live_pr_head_sha:
            return False, "skip: could not resolve live pull request head"
        if live_pr_head_sha.lower() != head_sha.lower():
            return (
                False,
                "skip: run head is stale "
                f"(run={head_sha[:12]} live={live_pr_head_sha[:12]})",
            )
    elif event_name == "merge_group":
        if merge_queue_head_shas is None:
            return False, "skip: could not resolve main merge queue"
        if head_sha.lower() not in {sha.lower() for sha in merge_queue_head_shas}:
            return False, "skip: merge_group head is no longer in the main merge queue"

    joined = ", ".join(infra_job_names)
    return True, f"rerun: infra-cancel jobs detected ({joined})"


def default_gh_request(
    method: str,
    path: str,
    headers: dict[str, str] | None = None,
    body: str | None = None,
) -> Any:
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        fail("GH_TOKEN or GITHUB_TOKEN is required")

    if path.startswith("graphql:"):
        query = path[len("graphql:") :]
        payload = json.dumps({"query": query}).encode("utf-8")
        req = urllib.request.Request(
            "https://api.github.com/graphql",
            data=payload,
            method="POST",
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "X-GitHub-Api-Version": "2022-11-28",
                **(headers or {}),
            },
        )
    else:
        data = None if body is None else body.encode("utf-8")
        req = urllib.request.Request(
            f"https://api.github.com{path}",
            data=data,
            method=method,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {token}",
                "X-GitHub-Api-Version": "2022-11-28",
                **(headers or {}),
            },
        )

    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            raw = response.read().decode("utf-8")
            if not raw:
                return None
            return json.loads(raw)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        fail(f"GitHub API {method} {path} failed: HTTP {error.code}: {detail}")
    except urllib.error.URLError as error:
        fail(f"GitHub API {method} {path} failed: {error}")


def gh_cli_rerun(repo: str, run_id: int) -> None:
    env = os.environ.copy()
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        env["GH_TOKEN"] = token
    try:
        subprocess.run(
            ["gh", "run", "rerun", str(run_id), "--failed", "--repo", repo],
            check=True,
            env=env,
        )
    except FileNotFoundError as error:
        fail(f"gh CLI not found: {error}")
    except subprocess.CalledProcessError as error:
        fail(f"gh run rerun --failed failed with exit {error.returncode}")


def paginate_jobs(request: GhRequest, repo: str, run_id: int) -> list[dict[str, Any]]:
    jobs: list[dict[str, Any]] = []
    page = 1
    while True:
        path = f"/repos/{repo}/actions/runs/{run_id}/jobs?per_page=100&page={page}"
        payload = request("GET", path, None, None)
        if not isinstance(payload, dict):
            fail(f"Unexpected jobs payload for run {run_id}")
        batch = payload.get("jobs") or []
        if not isinstance(batch, list):
            fail(f"Unexpected jobs list for run {run_id}")
        jobs.extend(job for job in batch if isinstance(job, dict))
        if len(batch) < 100:
            break
        page += 1
    return jobs


def fetch_annotations(request: GhRequest, repo: str, job_id: int) -> list[dict[str, Any]]:
    path = f"/repos/{repo}/check-runs/{job_id}/annotations"
    payload = request("GET", path, None, None)
    if payload is None:
        return []
    if not isinstance(payload, list):
        fail(f"Unexpected annotations payload for job {job_id}")
    return [item for item in payload if isinstance(item, dict)]


def resolve_live_pr_head(request: GhRequest, repo: str, head_sha: str, head_branch: str | None) -> str | None:
    owner, _, name = repo.partition("/")
    if not owner or not name:
        fail(f"Invalid repository {repo!r}")

    # Prefer the commit→pulls association (works for same-repo PR heads).
    pulls = request(
        "GET",
        f"/repos/{repo}/commits/{head_sha}/pulls",
        {"Accept": "application/vnd.github.groot-preview+json"},
        None,
    )
    if isinstance(pulls, list):
        for pull in pulls:
            if not isinstance(pull, dict):
                continue
            head = pull.get("head") or {}
            if not isinstance(head, dict):
                continue
            sha = head.get("sha")
            base = pull.get("base") or {}
            base_ref = base.get("ref") if isinstance(base, dict) else None
            state = pull.get("state")
            if state == "open" and isinstance(sha, str) and sha:
                # Prefer PRs targeting main/master when multiple match.
                if base_ref in {None, "main", "master"}:
                    return sha
        for pull in pulls:
            if not isinstance(pull, dict):
                continue
            head = pull.get("head") or {}
            sha = head.get("sha") if isinstance(head, dict) else None
            if pull.get("state") == "open" and isinstance(sha, str) and sha:
                return sha

    if head_branch:
        # Fallback: branch tip (same-repo heads only).
        encoded = urllib.parse.quote(head_branch, safe="")
        ref = request("GET", f"/repos/{repo}/git/ref/heads/{encoded}", None, None)
        if isinstance(ref, dict):
            obj = ref.get("object") or {}
            if isinstance(obj, dict) and isinstance(obj.get("sha"), str):
                return obj["sha"]

    # GraphQL fallback for fork PRs associated to the run SHA.
    query = (
        "query {"
        f'repository(owner: "{owner}", name: "{name}") {{'
        "pullRequests(first: 20, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {"
        "nodes { headRefOid headRepository { nameWithOwner } }"
        "}}}"
    )
    payload = request("POST", f"graphql:{query}", None, None)
    try:
        nodes = payload["data"]["repository"]["pullRequests"]["nodes"]
    except (TypeError, KeyError):
        return None
    if not isinstance(nodes, list):
        return None
    for node in nodes:
        if not isinstance(node, dict):
            continue
        if node.get("headRefOid") == head_sha:
            return head_sha
    return None


def resolve_merge_queue_head_shas(request: GhRequest, repo: str) -> set[str] | None:
    owner, _, name = repo.partition("/")
    if not owner or not name:
        fail(f"Invalid repository {repo!r}")
    query = (
        "query {"
        f'repository(owner: "{owner}", name: "{name}") {{'
        'mergeQueue(branch: "main") {'
        "entries(first: 50) { nodes { headCommit { oid } } }"
        "}}}"
    )
    payload = request("POST", f"graphql:{query}", None, None)
    try:
        nodes = payload["data"]["repository"]["mergeQueue"]["entries"]["nodes"]
    except (TypeError, KeyError):
        return None
    if nodes is None:
        return set()
    if not isinstance(nodes, list):
        return None
    shas: set[str] = set()
    for node in nodes:
        if not isinstance(node, dict):
            continue
        head = node.get("headCommit") or {}
        if isinstance(head, dict):
            oid = head.get("oid")
            if isinstance(oid, str) and oid:
                shas.add(oid)
    return shas


def load_run(request: GhRequest, repo: str, run_id: int) -> dict[str, Any]:
    payload = request("GET", f"/repos/{repo}/actions/runs/{run_id}", None, None)
    if not isinstance(payload, dict):
        fail(f"Unexpected run payload for {run_id}")
    return payload


def run_decision_from_github(
    *,
    repo: str,
    run_id: int,
    event_name: str,
    head_sha: str,
    head_branch: str | None,
    run_attempt: int,
    max_attempt: int,
    request: GhRequest,
) -> tuple[bool, str, list[str]]:
    run = load_run(request, repo, run_id)
    conclusion = run.get("conclusion")
    if not isinstance(conclusion, str) and conclusion is not None:
        fail("run.conclusion must be a string or null")

    # Prefer live run_attempt from API when present (workflow_run payload can lag).
    api_attempt = run.get("run_attempt")
    if isinstance(api_attempt, int) and api_attempt > 0:
        run_attempt = api_attempt

    jobs = paginate_jobs(request, repo, run_id)
    annotations_by_job_id: dict[int, list[dict[str, Any]]] = {}
    for job in jobs:
        job_id = job.get("id")
        conclusion_j = job.get("conclusion")
        if not isinstance(job_id, int):
            continue
        if conclusion_j in {None, "success", "skipped"}:
            continue
        annotations_by_job_id[job_id] = fetch_annotations(request, repo, job_id)

    infra_names = collect_infra_cancel_jobs(jobs, annotations_by_job_id)

    live_pr_head_sha: str | None = None
    merge_queue_head_shas: set[str] | None = None
    if event_name == "pull_request":
        live_pr_head_sha = resolve_live_pr_head(request, repo, head_sha, head_branch)
    elif event_name == "merge_group":
        merge_queue_head_shas = resolve_merge_queue_head_shas(request, repo)

    should, reason = decide(
        event_name=event_name,
        conclusion=conclusion if isinstance(conclusion, str) else None,
        run_attempt=run_attempt,
        max_attempt=max_attempt,
        head_sha=head_sha,
        infra_job_names=infra_names,
        live_pr_head_sha=live_pr_head_sha,
        merge_queue_head_shas=merge_queue_head_shas,
    )
    return should, reason, infra_names


def self_check() -> None:
    # Pure gate cases — no network.
    ok, reason = decide(
        event_name="pull_request",
        conclusion="failure",
        run_attempt=1,
        max_attempt=2,
        head_sha="a" * 40,
        infra_job_names=["UI P0 (entry-settings)"],
        live_pr_head_sha="a" * 40,
        merge_queue_head_shas=None,
    )
    assert ok and reason.startswith("rerun:"), reason

    ok, reason = decide(
        event_name="pull_request",
        conclusion="failure",
        run_attempt=1,
        max_attempt=2,
        head_sha="a" * 40,
        infra_job_names=[],
        live_pr_head_sha="a" * 40,
        merge_queue_head_shas=None,
    )
    assert not ok and "no infra-cancel" in reason, reason

    ok, reason = decide(
        event_name="pull_request",
        conclusion="failure",
        run_attempt=2,
        max_attempt=2,
        head_sha="a" * 40,
        infra_job_names=["UI P0 (entry-settings)"],
        live_pr_head_sha="a" * 40,
        merge_queue_head_shas=None,
    )
    assert not ok and "run_attempt" in reason, reason

    ok, reason = decide(
        event_name="pull_request",
        conclusion="failure",
        run_attempt=1,
        max_attempt=2,
        head_sha="a" * 40,
        infra_job_names=["UI P0 (entry-settings)"],
        live_pr_head_sha="b" * 40,
        merge_queue_head_shas=None,
    )
    assert not ok and "stale" in reason, reason

    ok, reason = decide(
        event_name="merge_group",
        conclusion="cancelled",
        run_attempt=1,
        max_attempt=2,
        head_sha="a" * 40,
        infra_job_names=["Playwright visual (settings-workspace)"],
        live_pr_head_sha=None,
        merge_queue_head_shas={"a" * 40},
    )
    assert ok and reason.startswith("rerun:"), reason

    ok, reason = decide(
        event_name="merge_group",
        conclusion="cancelled",
        run_attempt=1,
        max_attempt=2,
        head_sha="a" * 40,
        infra_job_names=["Playwright visual (settings-workspace)"],
        live_pr_head_sha=None,
        merge_queue_head_shas={"c" * 40},
    )
    assert not ok and "merge queue" in reason, reason

    job_shutdown = {
        "id": 1,
        "name": "UI P0 (entry-settings)",
        "conclusion": "failure",
        "steps": [{"name": "Run UI P0 domain", "conclusion": "cancelled"}],
    }
    assert job_looks_like_infra_cancel(
        job_shutdown,
        [{"message": "The runner has received a shutdown signal. This can happen when the runner service is stopped."}],
    )
    assert not job_looks_like_infra_cancel(
        {
            "id": 2,
            "name": "UI P0 (entry-settings)",
            "conclusion": "failure",
            "steps": [{"name": "Run UI P0 domain", "conclusion": "failure"}],
        },
        [{"message": "Error: expect(locator).toBeVisible() failed"}],
    )
    assert job_looks_like_infra_cancel(
        {"id": 3, "name": "E2E Vitest", "conclusion": "cancelled", "steps": []},
        [],
    )

    emit("rerun_infra_cancel self-check OK")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        nargs="?",
        default="run",
        choices=("run", "self-check"),
        help="run (default) or self-check",
    )
    parser.add_argument("--repo", default=os.environ.get("REPO") or os.environ.get("GITHUB_REPOSITORY"))
    parser.add_argument("--run-id", default=os.environ.get("RUN_ID"))
    parser.add_argument("--event", default=os.environ.get("RUN_EVENT") or os.environ.get("EVENT_NAME"))
    parser.add_argument("--head-sha", default=os.environ.get("HEAD_SHA") or os.environ.get("RUN_HEAD_SHA"))
    parser.add_argument("--head-branch", default=os.environ.get("HEAD_BRANCH") or os.environ.get("RUN_HEAD_BRANCH"))
    parser.add_argument("--attempt", default=os.environ.get("ATTEMPT") or os.environ.get("RUN_ATTEMPT"))
    parser.add_argument(
        "--max-attempt",
        default=os.environ.get("MAX_ATTEMPT") or str(DEFAULT_MAX_ATTEMPT),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=os.environ.get("DRY_RUN", "").lower() in {"1", "true", "yes"},
    )
    args = parser.parse_args(argv)

    if args.command == "self-check":
        self_check()
        return 0

    repo = require_text(args.repo, "repo")
    run_id = parse_int(args.run_id, "run-id")
    event_name = require_text(args.event, "event")
    head_sha = require_sha(args.head_sha, "head-sha")
    head_branch = args.head_branch.strip() if isinstance(args.head_branch, str) and args.head_branch.strip() else None
    run_attempt = parse_int(args.attempt, "attempt", default=1)
    max_attempt = parse_int(args.max_attempt, "max-attempt", default=DEFAULT_MAX_ATTEMPT)

    should, reason, infra_names = run_decision_from_github(
        repo=repo,
        run_id=run_id,
        event_name=event_name,
        head_sha=head_sha,
        head_branch=head_branch,
        run_attempt=run_attempt,
        max_attempt=max_attempt,
        request=default_gh_request,
    )
    emit(reason)
    if infra_names:
        emit("infra_jobs=" + ",".join(infra_names))

    if not should:
        return 0

    if args.dry_run:
        emit(f"dry-run: would gh run rerun {run_id} --failed --repo {repo}")
        return 0

    emit(f"gh run rerun {run_id} --failed --repo {repo}")
    gh_cli_rerun(repo, run_id)
    emit("rerun requested")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Skip as error:
        emit(str(error))
        raise SystemExit(0) from None
    except HelperError as error:
        print(f"::error::{error}", file=sys.stderr)
        raise SystemExit(1) from None
