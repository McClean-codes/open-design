#!/usr/bin/env python3
"""Rerun a completed `ci` run once when leaf jobs died to runner/infra cancel.

This is the decision + action helper for `.github/workflows/rerun.atom.yml`.
It is intentionally narrow:

- only `pull_request` / `merge_group` ci runs
- only while `run_attempt < max_attempt` (default 2 → one automatic retry)
- only when every non-success leaf job carries a trusted infra fingerprint
  (shutdown/spot markers — not bare `cancelled` alone; no ordinary assertion
  failure / timeout mixed in)
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

# ci.yml always() jobs that mirror leaf outcomes rather than run leaf work.
# `Validate workspace` fails whenever a required leaf failed/cancelled, and
# `Runtime summary` is diagnostic-only. Neither carries runner/spot markers, so
# classifying them as ordinary would refuse every pure infra-cancel case that
# still reaches the aggregate gate.
IGNORED_AGGREGATE_JOB_NAMES = frozenset(
    {
        "Validate workspace",
        "Runtime summary",
    }
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

    Bare ``cancelled`` without a trusted infra marker is ordinary (manual cancel,
    concurrency cancel, force-push cancel). Treating unmarked cancel as infra
    would authorize ``gh run rerun --failed`` on work the user explicitly
    stopped. Only annotation fingerprints in ``INFRA_CANCEL_MARKERS`` prove
    runner/spot loss.
    """
    # job is retained for the classify call-site signature; conclusion alone is
    # not an infra signal — only trusted annotation markers prove runner loss.
    if not isinstance(job, dict):
        return False
    blob = annotation_blob(annotations)
    return has_infra_marker(blob)


def job_display_name(job: dict[str, Any], job_id: int) -> str:
    name = job.get("name")
    return name if isinstance(name, str) and name else f"job-{job_id}"


def classify_non_success_jobs(
    jobs: list[dict[str, Any]],
    annotations_by_job_id: dict[int, list[dict[str, Any]]],
) -> tuple[list[str], list[str]]:
    """Split non-success leaves into infra-cancel vs ordinary failures.

    `gh run rerun --failed` retries every failed/cancelled job. Authorizing a
    rerun when any ordinary red leaf is present would hide a real assertion
    failure behind an automatic second attempt. Only pure infra-cancel sets
    may authorize a rerun.

    Aggregate always() gates (see ``IGNORED_AGGREGATE_JOB_NAMES``) are excluded:
    they fail as a consequence of leaf outcomes and never carry infra markers.
    """
    infra_names: list[str] = []
    ordinary_names: list[str] = []
    for job in jobs:
        if not isinstance(job, dict):
            continue
        job_id = job.get("id")
        if not isinstance(job_id, int):
            continue
        if job.get("conclusion") in {None, "success", "skipped"}:
            continue
        label = job_display_name(job, job_id)
        if label in IGNORED_AGGREGATE_JOB_NAMES:
            continue
        annotations = annotations_by_job_id.get(job_id, [])
        if job_looks_like_infra_cancel(job, annotations):
            infra_names.append(label)
        else:
            ordinary_names.append(label)
    return infra_names, ordinary_names


def collect_infra_cancel_jobs(
    jobs: list[dict[str, Any]],
    annotations_by_job_id: dict[int, list[dict[str, Any]]],
) -> list[str]:
    infra_names, _ordinary = classify_non_success_jobs(jobs, annotations_by_job_id)
    return infra_names


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
    ordinary_job_names: list[str] | None = None,
) -> tuple[bool, str]:
    """Pure eligibility gate. Returns (should_rerun, reason)."""
    if event_name not in ALLOWED_EVENTS:
        return False, f"skip: unsupported event {event_name!r}"
    if run_attempt >= max_attempt:
        return False, f"skip: run_attempt {run_attempt} >= max_attempt {max_attempt}"
    if conclusion not in RETRYABLE_CONCLUSIONS:
        return False, f"skip: conclusion {conclusion!r} is not retryable"

    ordinary = ordinary_job_names or []
    if ordinary:
        joined_ordinary = ", ".join(ordinary)
        return (
            False,
            "skip: ordinary non-infra failures present "
            f"({joined_ordinary}); refusing mixed rerun",
        )

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


def _open_pr_head_sha(pull: dict[str, Any]) -> str | None:
    """Return the head SHA of an open PR, or None when the PR is not live."""
    if pull.get("state") != "open":
        return None
    head = pull.get("head") or {}
    if not isinstance(head, dict):
        return None
    sha = head.get("sha")
    return sha if isinstance(sha, str) and sha else None


def resolve_live_pr_head(request: GhRequest, repo: str, head_sha: str, head_branch: str | None) -> str | None:
    """Resolve the live head SHA of an open PR for this run, or None.

    Evidence must come from an *open* pull request. A same-repo branch tip is
    not enough: closing a PR can leave the branch at the failed run SHA while
    no live PR remains, and a trusted rerun must not fire for that shape.
    """
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
        preferred: str | None = None
        fallback: str | None = None
        for pull in pulls:
            if not isinstance(pull, dict):
                continue
            sha = _open_pr_head_sha(pull)
            if not sha:
                continue
            base = pull.get("base") or {}
            base_ref = base.get("ref") if isinstance(base, dict) else None
            # Prefer PRs targeting main/master when multiple match.
            if base_ref in {None, "main", "master"}:
                preferred = sha
                break
            if fallback is None:
                fallback = sha
        if preferred is not None:
            return preferred
        if fallback is not None:
            return fallback

    # Same-repo open PR by repository-qualified head ref. Unlike the branch
    # tip, this requires state=open so a closed PR cannot authorize a rerun.
    if head_branch:
        head_filter = urllib.parse.quote(f"{owner}:{head_branch}", safe="")
        open_pulls = request(
            "GET",
            f"/repos/{repo}/pulls?state=open&head={head_filter}&per_page=10",
            None,
            None,
        )
        if isinstance(open_pulls, list):
            for pull in open_pulls:
                if not isinstance(pull, dict):
                    continue
                sha = _open_pr_head_sha(pull)
                if sha:
                    return sha

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

    infra_names, ordinary_names = classify_non_success_jobs(jobs, annotations_by_job_id)

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
        ordinary_job_names=ordinary_names,
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
        ordinary_job_names=[],
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
        ordinary_job_names=[],
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
        ordinary_job_names=[],
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
        ordinary_job_names=[],
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
        ordinary_job_names=[],
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
        ordinary_job_names=[],
        live_pr_head_sha=None,
        merge_queue_head_shas={"c" * 40},
    )
    assert not ok and "merge queue" in reason, reason

    shutdown_annotation = {
        "message": (
            "The runner has received a shutdown signal. This can happen when "
            "the runner service is stopped."
        )
    }
    job_shutdown = {
        "id": 1,
        "name": "UI P0 (entry-settings)",
        "conclusion": "failure",
        "steps": [{"name": "Run UI P0 domain", "conclusion": "cancelled"}],
    }
    # Marker-backed shutdown (failure or cancelled conclusion) is infra.
    assert job_looks_like_infra_cancel(job_shutdown, [shutdown_annotation])
    assert job_looks_like_infra_cancel(
        {"id": 3, "name": "E2E Vitest", "conclusion": "cancelled", "steps": []},
        [shutdown_annotation],
    )
    # Ordinary assertion failure is never infra.
    assert not job_looks_like_infra_cancel(
        {
            "id": 2,
            "name": "UI P0 (entry-settings)",
            "conclusion": "failure",
            "steps": [{"name": "Run UI P0 domain", "conclusion": "failure"}],
        },
        [{"message": "Error: expect(locator).toBeVisible() failed"}],
    )
    # Bare cancelled with empty annotations is ordinary (manual / concurrency cancel).
    assert not job_looks_like_infra_cancel(
        {"id": 4, "name": "E2E Vitest", "conclusion": "cancelled", "steps": []},
        [],
    )

    # Mixed leaf outcomes: marker-backed cancel + ordinary assertion failure.
    # Must refuse --failed (would also retry the genuine red leaf).
    mixed_jobs = [
        {"id": 10, "name": "E2E Vitest", "conclusion": "cancelled", "steps": []},
        {
            "id": 11,
            "name": "UI P0 (entry-settings)",
            "conclusion": "failure",
            "steps": [{"name": "Run UI P0 domain", "conclusion": "failure"}],
        },
    ]
    mixed_annotations = {
        10: [shutdown_annotation],
        11: [{"message": "Error: expect(locator).toBeVisible() failed"}],
    }
    infra_names, ordinary_names = classify_non_success_jobs(mixed_jobs, mixed_annotations)
    assert infra_names == ["E2E Vitest"], infra_names
    assert ordinary_names == ["UI P0 (entry-settings)"], ordinary_names
    ok, reason = decide(
        event_name="pull_request",
        conclusion="failure",
        run_attempt=1,
        max_attempt=2,
        head_sha="a" * 40,
        infra_job_names=infra_names,
        ordinary_job_names=ordinary_names,
        live_pr_head_sha="a" * 40,
        merge_queue_head_shas=None,
    )
    assert not ok and "ordinary non-infra" in reason, reason

    # Manually cancelled current-head PR run: leaves are bare cancelled with no
    # infra markers. Must skip even though the head is still live — otherwise
    # we would restart work the user explicitly cancelled.
    manual_cancel_jobs = [
        {"id": 20, "name": "E2E Vitest", "conclusion": "cancelled", "steps": []},
        {
            "id": 21,
            "name": "Playwright visual (settings-workspace)",
            "conclusion": "cancelled",
            "steps": [],
        },
    ]
    infra_names, ordinary_names = classify_non_success_jobs(manual_cancel_jobs, {})
    assert infra_names == [], infra_names
    assert ordinary_names == [
        "E2E Vitest",
        "Playwright visual (settings-workspace)",
    ], ordinary_names
    ok, reason = decide(
        event_name="pull_request",
        conclusion="cancelled",
        run_attempt=1,
        max_attempt=2,
        head_sha="a" * 40,
        infra_job_names=infra_names,
        ordinary_job_names=ordinary_names,
        live_pr_head_sha="a" * 40,
        merge_queue_head_shas=None,
    )
    assert not ok, reason
    assert "ordinary non-infra" in reason or "no infra-cancel" in reason, reason

    # Marker-backed pure infra-cancel set still authorizes when no ordinary
    # failures exist (spot / runner shutdown with empty steps is common).
    pure_infra_jobs = [
        {"id": 30, "name": "E2E Vitest", "conclusion": "cancelled", "steps": []},
        {
            "id": 31,
            "name": "Playwright visual (settings-workspace)",
            "conclusion": "cancelled",
            "steps": [],
        },
    ]
    pure_infra_annotations = {
        30: [shutdown_annotation],
        31: [{"message": "SpotInterrupted"}],
    }
    infra_names, ordinary_names = classify_non_success_jobs(
        pure_infra_jobs, pure_infra_annotations
    )
    assert infra_names == [
        "E2E Vitest",
        "Playwright visual (settings-workspace)",
    ], infra_names
    assert ordinary_names == [], ordinary_names
    ok, reason = decide(
        event_name="pull_request",
        conclusion="cancelled",
        run_attempt=1,
        max_attempt=2,
        head_sha="a" * 40,
        infra_job_names=infra_names,
        ordinary_job_names=ordinary_names,
        live_pr_head_sha="a" * 40,
        merge_queue_head_shas=None,
    )
    assert ok and reason.startswith("rerun:"), reason

    # Pure infra leaf cancel + always() aggregate gate failure must still
    # authorize. Validate workspace / Runtime summary fail without infra
    # annotations whenever a needed leaf failed or cancelled; counting them as
    # ordinary would refuse the intended runner-shutdown recovery path.
    gate_jobs = [
        {"id": 40, "name": "E2E Vitest", "conclusion": "cancelled", "steps": []},
        {
            "id": 41,
            "name": "Validate workspace",
            "conclusion": "failure",
            "steps": [{"name": "Check workspace validation jobs", "conclusion": "failure"}],
        },
        {
            "id": 42,
            "name": "Runtime summary",
            "conclusion": "failure",
            "steps": [],
        },
    ]
    gate_annotations = {
        40: [shutdown_annotation],
        41: [],
        42: [],
    }
    infra_names, ordinary_names = classify_non_success_jobs(gate_jobs, gate_annotations)
    assert infra_names == ["E2E Vitest"], infra_names
    assert ordinary_names == [], ordinary_names
    ok, reason = decide(
        event_name="pull_request",
        conclusion="failure",
        run_attempt=1,
        max_attempt=2,
        head_sha="a" * 40,
        infra_job_names=infra_names,
        ordinary_job_names=ordinary_names,
        live_pr_head_sha="a" * 40,
        merge_queue_head_shas=None,
    )
    assert ok and reason.startswith("rerun:"), reason

    # Ordinary leaf failure + aggregate gate still refuses (gate ignored; leaf
    # ordinary failure remains the blocking signal).
    ordinary_with_gate = [
        {
            "id": 50,
            "name": "UI P0 (entry-settings)",
            "conclusion": "failure",
            "steps": [{"name": "Run UI P0 domain", "conclusion": "failure"}],
        },
        {
            "id": 51,
            "name": "Validate workspace",
            "conclusion": "failure",
            "steps": [],
        },
    ]
    ordinary_with_gate_annotations = {
        50: [{"message": "Error: expect(locator).toBeVisible() failed"}],
        51: [],
    }
    infra_names, ordinary_names = classify_non_success_jobs(
        ordinary_with_gate, ordinary_with_gate_annotations
    )
    assert infra_names == [], infra_names
    assert ordinary_names == ["UI P0 (entry-settings)"], ordinary_names
    ok, reason = decide(
        event_name="pull_request",
        conclusion="failure",
        run_attempt=1,
        max_attempt=2,
        head_sha="a" * 40,
        infra_job_names=infra_names,
        ordinary_job_names=ordinary_names,
        live_pr_head_sha="a" * 40,
        merge_queue_head_shas=None,
    )
    assert not ok and "ordinary non-infra" in reason, reason

    # Closed PR + branch tip still at the failed run SHA must not resolve a
    # live head. commit→pulls has no open association; the bare branch ref is
    # unchanged. Branch-tip evidence alone used to authorize a trusted rerun.
    closed_run_sha = "d" * 40
    closed_branch = "agent/closed-pr-still-on-tip"
    seen_paths: list[str] = []

    def closed_pr_request(
        method: str,
        path: str,
        headers: dict[str, str] | None = None,
        body: str | None = None,
    ) -> Any:
        del method, headers, body
        seen_paths.append(path)
        if path.startswith(f"/repos/nexu-io/open-design/commits/{closed_run_sha}/pulls"):
            # Association exists but is closed/open-filtered away.
            return [
                {
                    "state": "closed",
                    "head": {"sha": closed_run_sha, "ref": closed_branch},
                    "base": {"ref": "main"},
                }
            ]
        if path.startswith("/repos/nexu-io/open-design/pulls?"):
            # No open PR for this repository-qualified head ref.
            expected_head = urllib.parse.quote(f"nexu-io:{closed_branch}", safe="")
            assert "state=open" in path, path
            assert f"head={expected_head}" in path, path
            return []
        if path.startswith("/repos/nexu-io/open-design/git/ref/heads/"):
            # If consulted, tip still matches the failed SHA — but live-PR
            # resolution must not use bare branch tip as evidence.
            return {"object": {"sha": closed_run_sha, "type": "commit"}}
        if path.startswith("graphql:"):
            return {
                "data": {
                    "repository": {
                        "pullRequests": {
                            "nodes": [
                                {
                                    "headRefOid": "e" * 40,
                                    "headRepository": {"nameWithOwner": "nexu-io/open-design"},
                                }
                            ]
                        }
                    }
                }
            }
        fail(f"unexpected fixture path {path!r}")

    live = resolve_live_pr_head(
        closed_pr_request,
        "nexu-io/open-design",
        closed_run_sha,
        closed_branch,
    )
    assert live is None, live
    assert any("/commits/" in p and p.endswith("/pulls") for p in seen_paths), seen_paths
    assert any(p.startswith("/repos/nexu-io/open-design/pulls?") for p in seen_paths), seen_paths
    # Branch tip must not be consulted as live-PR evidence.
    assert not any("/git/ref/heads/" in p for p in seen_paths), seen_paths

    ok, reason = decide(
        event_name="pull_request",
        conclusion="failure",
        run_attempt=1,
        max_attempt=2,
        head_sha=closed_run_sha,
        infra_job_names=["UI P0 (entry-settings)"],
        ordinary_job_names=[],
        live_pr_head_sha=live,
        merge_queue_head_shas=None,
    )
    assert not ok and "could not resolve live pull request head" in reason, reason

    # Open PR via repository-qualified head ref still resolves when commit
    # association is empty (e.g. timing) but the PR remains open.
    open_run_sha = "f" * 40
    open_branch = "agent/open-pr-head-ref"

    def open_pr_by_head_request(
        method: str,
        path: str,
        headers: dict[str, str] | None = None,
        body: str | None = None,
    ) -> Any:
        del method, headers, body
        if path.startswith(f"/repos/nexu-io/open-design/commits/{open_run_sha}/pulls"):
            return []
        if path.startswith("/repos/nexu-io/open-design/pulls?"):
            return [
                {
                    "state": "open",
                    "head": {"sha": open_run_sha, "ref": open_branch},
                    "base": {"ref": "main"},
                }
            ]
        if path.startswith("graphql:"):
            return {"data": {"repository": {"pullRequests": {"nodes": []}}}}
        fail(f"unexpected fixture path {path!r}")

    live_open = resolve_live_pr_head(
        open_pr_by_head_request,
        "nexu-io/open-design",
        open_run_sha,
        open_branch,
    )
    assert live_open == open_run_sha, live_open

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
