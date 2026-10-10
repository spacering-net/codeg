#!/usr/bin/env python3
# managed-by: dev-rules/templates/upstream-merge-notify
"""Open or refresh a human-facing issue when the fork is behind upstream/main.

CI entry:  python3 scripts/upstream/notify-merge-needed.py apply ...
Local:     python3 scripts/upstream/notify-merge-needed.py --selftest

This tool never merges, never opens a PR, and never runs an agent.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Protocol

LABEL = "upstream-merge-needed"
AUTOMATED_LABEL = "automated"
TITLE_PREFIX = "[upstream-merge]"
COMMIT_LIMIT = 30
MANAGED_MARKER = "managed-by: dev-rules/templates/upstream-merge-notify"
WORKFLOW_RELPATH = ".github/workflows/upstream-merge-notify.yml"
FORBIDDEN_WORKFLOW_NEEDLES = (
    "run-headless-agent",
    "ANTHROPIC_AUTH_TOKEN",
    "git merge --no-ff",
    "gh workflow run",
    "claude -p",
    "git remote set-url origin",
    "merge-state.sh",
    "persist-credentials: false",
)
REQUIRED_WORKFLOW_NEEDLES = (
    "unset GITHUB_TOKEN",
    "github.token",
    MANAGED_MARKER,
)


def payload_root() -> Path:
    """Return the install/payload root that contains `.github/` and `scripts/`."""
    return Path(__file__).resolve().parents[2]


def _run_git(args: list[str]) -> str:
    result = subprocess.run(
        ["git", *args],
        text=True,
        capture_output=True,
        check=False,
        cwd=payload_root(),
    )
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


def github_slug_from_remote_url(url: str) -> str:
    text = (url or "").strip()
    if not text:
        return ""
    text = re.sub(r"\.git$", "", text)
    match = re.search(r"github\.com[:/]([^/]+/[^/]+)$", text)
    if match:
        return match.group(1)
    return ""


def detect_repo_names() -> tuple[str, str]:
    upstream = (
        os.environ.get("UPSTREAM_REPO")
        or github_slug_from_remote_url(_run_git(["remote", "get-url", "upstream"]))
        or "upstream"
    )
    fork = (
        os.environ.get("FORK_NAME")
        or os.environ.get("GITHUB_REPOSITORY")
        or github_slug_from_remote_url(_run_git(["remote", "get-url", "origin"]))
        or "origin"
    )
    return upstream, fork


def label_specs(upstream_repo: str, fork_name: str) -> tuple[tuple[str, str, str], ...]:
    return (
        (LABEL, "D93F0B", f"{fork_name} is behind {upstream_repo}"),
        (AUTOMATED_LABEL, "C5DEF5", "Automated signal"),
    )


class IssueHost(Protocol):
    def list_open(self, label: str) -> list[int]: ...
    def list_open_tracking(self) -> list[int]: ...
    def create(self, title: str, body: str, labels: list[str] | None = None) -> int: ...
    def update(self, number: int, title: str, body: str) -> None: ...
    def comment(self, number: int, body: str) -> None: ...
    def close(self, number: int, comment: str) -> None: ...
    def attach_labels(self, number: int, specs: list[tuple[str, str, str]]) -> list[str]: ...


def is_tracking_title(title: str) -> bool:
    return str(title).startswith(TITLE_PREFIX)


def label_is_ready(
    *,
    exists_before: bool,
    create_ok: bool,
    create_err: str,
    exists_after: bool,
) -> bool:
    if exists_before or exists_after or create_ok:
        return True
    return "already exists" in (create_err or "").lower()


def decide_action(*, behind: int, existing_open: bool) -> str:
    if behind < 0:
        raise ValueError("behind must be >= 0")
    if behind > 0:
        return "update" if existing_open else "create"
    return "close" if existing_open else "noop"


def render_title(behind: int, *, upstream_repo: str, fork_name: str) -> str:
    unit = "commit" if behind == 1 else "commits"
    return f"{TITLE_PREFIX} {upstream_repo} is {behind} {unit} ahead of {fork_name}"


def parse_merge_tree_conflicts(raw: str) -> list[str]:
    """Parse `git merge-tree --write-tree --name-only --no-messages` output."""
    lines = [line for line in raw.splitlines() if line.strip()]
    if not lines:
        return []
    first = lines[0].strip()
    if not re.fullmatch(r"[0-9a-f]{40,64}", first):
        raise ValueError("merge-tree output missing leading tree OID")
    return lines[1:]


def truncate_commits(commits: list[str], limit: int = COMMIT_LIMIT) -> tuple[list[str], int]:
    cleaned = [line.rstrip("\n") for line in commits if line.strip()]
    if len(cleaned) <= limit:
        return cleaned, 0
    return cleaned[:limit], len(cleaned) - limit


def render_body(
    *,
    drift: dict[str, Any],
    commits: list[str],
    conflicts: list[str],
    open_prs: list[dict[str, Any]],
    run_url: str,
    fork_name: str,
    hidden_commit_count: int = 0,
) -> str:
    behind = int(drift.get("behind") or 0)
    ahead = int(drift.get("ahead") or 0)
    upstream_head = str(drift.get("upstream_head") or "")
    origin_head = str(drift.get("origin_head") or "")
    shown, hidden = truncate_commits(commits)
    if hidden_commit_count:
        hidden = hidden_commit_count

    commit_block = "\n".join(shown) if shown else "(none)"
    if hidden:
        commit_block += f"\n... ({hidden} more)"

    if conflicts:
        conflict_block = "\n".join(f"- `{path}`" for path in conflicts)
    else:
        conflict_block = "none (clean merge-tree)"

    if open_prs:
        pr_lines = [
            "- Do not treat leftover `merge/upstream-*` PRs as human-approved.",
            "",
        ]
        for pr in open_prs:
            number = pr.get("number")
            title = pr.get("title") or ""
            url = pr.get("url") or ""
            head = pr.get("headRefName") or ""
            pr_lines.append(f"- #{number} `{head}` {title} {url}".rstrip())
        pr_block = "\n".join(pr_lines)
    else:
        pr_block = "none"

    return "\n".join(
        [
            "> Auto-generated by `.github/workflows/upstream-merge-notify.yml`.",
            "> This workflow does **not** merge, open a PR, or run an agent.",
            "",
            "## Drift",
            "",
            f"- {fork_name} behind: {behind} commits (`origin/main..upstream/main`)",
            f"- {fork_name} ahead: {ahead} commits (`upstream/main..origin/main`)",
            f"- upstream/main: `{upstream_head}`",
            f"- origin/main: `{origin_head}`",
            f"- run: {run_url or 'n/a'}",
            "",
            "## New upstream commits (`origin/main..upstream/main`)",
            "",
            "```",
            commit_block,
            "```",
            "",
            "## merge-tree conflict files (read-only)",
            "",
            "If we merged `upstream/main` into `origin/main` now, these files would conflict:",
            "",
            conflict_block,
            "",
            "## Open merge/upstream-* PRs",
            "",
            pr_block,
            "",
            "## Human next steps",
            "",
            "1. Decide whether this batch is worth merging. Large or hotspot-heavy batches can wait.",
            "2. Follow the `upstream-merge` skill (`.cursor/skills/upstream-merge/SKILL.md`).",
            "3. `git fetch upstream && git fetch origin`",
            "4. Create `merge/upstream-$(date -u +%Y-%m-%d)` from `origin/main` via `git-worktree-submodule`.",
            "5. `git merge --no-ff upstream/main`",
            "6. Resolve conflicts, then run the host `scripts/preflight.sh` (or project gates).",
            "7. Open a `merge/upstream-*` PR. Reviewer must use **Create a merge commit** (not Squash).",
            "",
        ]
    ) + "\n"


def apply(
    *,
    drift: dict[str, Any],
    commits: list[str],
    conflicts: list[str],
    open_prs: list[dict[str, Any]],
    run_url: str,
    host: IssueHost,
    upstream_repo: str,
    fork_name: str,
) -> dict[str, Any]:
    if "behind" not in drift:
        raise ValueError("drift JSON missing 'behind'")
    behind = int(drift["behind"])
    existing = host.list_open_tracking()
    action = decide_action(behind=behind, existing_open=bool(existing))
    primary: int | None = existing[0] if existing else None
    label_warnings: list[str] = []
    specs = list(label_specs(upstream_repo, fork_name))

    if action in {"create", "update"}:
        title = render_title(behind, upstream_repo=upstream_repo, fork_name=fork_name)
        body = render_body(
            drift=drift,
            commits=commits,
            conflicts=conflicts,
            open_prs=open_prs,
            run_url=run_url,
            fork_name=fork_name,
        )
        if action == "create":
            create_labels: list[str] = []
            if isinstance(host, GhIssueHost):
                create_labels = host.labels_ready_for_create(specs)
            else:
                create_labels = [name for name, _, _ in specs]
            primary = host.create(title, body, create_labels or None)
        else:
            assert primary is not None
            host.update(primary, title, body)
            host.comment(primary, f"Refreshed by {run_url}: still {behind} commit(s) behind.")
            for extra in existing[1:]:
                host.close(extra, f"Duplicate of #{primary}.")
        if primary is not None:
            label_warnings = host.attach_labels(primary, specs)
    elif action == "close":
        close_comment = (
            f"origin/main now contains upstream/main (`{drift.get('upstream_head') or ''}`). "
            f"{run_url}".rstrip()
        )
        for number in existing:
            host.close(number, close_comment)
        primary = None

    return {
        "action": action,
        "issue": primary,
        "label_warnings": label_warnings,
    }


class GhIssueHost:
    def __init__(self, runner: Any | None = None) -> None:
        self._run = runner or _run_gh

    def list_open(self, label: str) -> list[int]:
        raw = self._run(
            [
                "gh",
                "issue",
                "list",
                "--state",
                "open",
                "--label",
                label,
                "--json",
                "number",
                "--jq",
                "[.[].number]",
            ]
        )
        data = json.loads(raw or "[]")
        return [int(item) for item in data]

    def list_open_tracking(self) -> list[int]:
        raw = self._run(
            [
                "gh",
                "issue",
                "list",
                "--state",
                "open",
                "--limit",
                "100",
                "--json",
                "number,title",
            ]
        )
        items = json.loads(raw or "[]")
        by_title = [
            int(item["number"])
            for item in items
            if is_tracking_title(str(item.get("title") or ""))
        ]
        try:
            by_label = self.list_open(LABEL)
        except RuntimeError:
            by_label = []
        seen: list[int] = []
        for number in by_title + by_label:
            if number not in seen:
                seen.append(number)
        return seen

    def create(self, title: str, body: str, labels: list[str] | None = None) -> int:
        body_path = ""
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as handle:
                handle.write(body)
                body_path = handle.name
            args = [
                "gh",
                "issue",
                "create",
                "--title",
                title,
                "--body-file",
                body_path,
            ]
            repo = os.environ.get("GH_REPO") or os.environ.get("GITHUB_REPOSITORY") or ""
            if repo.strip():
                args.extend(["--repo", repo.strip()])
            ready = [label for label in (labels or []) if label]
            if ready:
                args.extend(["--label", ",".join(ready)])
            raw = self._run(args)
        finally:
            if body_path:
                Path(body_path).unlink(missing_ok=True)
        match = re.search(r"/issues/(\d+)", raw)
        if not match:
            raise RuntimeError(f"gh issue create did not return an issue URL: {raw!r}")
        return int(match.group(1))

    def update(self, number: int, title: str, body: str) -> None:
        self._run(["gh", "issue", "edit", str(number), "--title", title, "--body", body])

    def comment(self, number: int, body: str) -> None:
        self._run(["gh", "issue", "comment", str(number), "--body", body])

    def close(self, number: int, comment: str) -> None:
        self._run(["gh", "issue", "close", str(number), "--comment", comment])

    def _label_exists(self, name: str) -> bool:
        raw = self._run(
            [
                "gh",
                "label",
                "list",
                "--search",
                name,
                "--limit",
                "20",
                "--json",
                "name",
            ]
        )
        items = json.loads(raw or "[]")
        return any(item.get("name") == name for item in items)

    def ensure_label(self, name: str, color: str, description: str) -> bool:
        exists_before = self._label_exists(name)
        create_ok = True
        create_err = ""
        if not exists_before:
            try:
                self._run(
                    [
                        "gh",
                        "label",
                        "create",
                        name,
                        "--color",
                        color,
                        "--description",
                        description[:100],
                    ]
                )
            except RuntimeError as exc:
                create_ok = False
                create_err = str(exc)
        exists_after = exists_before or self._label_exists(name)
        return label_is_ready(
            exists_before=exists_before,
            create_ok=create_ok,
            create_err=create_err,
            exists_after=exists_after,
        )

    def attach_labels(self, number: int, specs: list[tuple[str, str, str]]) -> list[str]:
        warnings: list[str] = []
        for name, color, description in specs:
            if not self.ensure_label(name, color, description):
                warnings.append(f"could not ensure label {name!r}")
                continue
            try:
                self._run(["gh", "issue", "edit", str(number), "--add-label", name])
            except RuntimeError as exc:
                warnings.append(str(exc))
        return warnings

    def labels_ready_for_create(self, specs: list[tuple[str, str, str]]) -> list[str]:
        ready: list[str] = []
        for name, color, description in specs:
            if self.ensure_label(name, color, description):
                ready.append(name)
        return ready


def _run_gh(args: list[str], allow_failure: bool = False) -> str:
    result = subprocess.run(args, text=True, capture_output=True, check=False)
    if result.returncode != 0 and not allow_failure:
        raise RuntimeError(
            f"{args[0]} failed ({result.returncode}): {result.stderr.strip() or result.stdout.strip()}"
        )
    return result.stdout.strip()


def _load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return default
    return json.loads(text)


def _load_lines(path: Path) -> list[str]:
    if not path.exists():
        return []
    return [line.rstrip("\n") for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def cmd_apply(args: argparse.Namespace) -> int:
    drift = _load_json(Path(args.drift), {})
    if not isinstance(drift, dict) or "behind" not in drift:
        print("FAIL: --drift must be JSON with a 'behind' field", file=sys.stderr)
        return 2
    commits = _load_lines(Path(args.commits)) if args.commits else []
    conflicts_raw = Path(args.conflicts).read_text(encoding="utf-8") if args.conflicts else ""
    conflicts = parse_merge_tree_conflicts(conflicts_raw) if conflicts_raw.strip() else []
    open_prs = _load_json(Path(args.open_prs), []) if args.open_prs else []
    if not isinstance(open_prs, list):
        print("FAIL: --open-prs must be a JSON array", file=sys.stderr)
        return 2
    upstream_repo, fork_name = detect_repo_names()
    result = apply(
        drift=drift,
        commits=commits,
        conflicts=conflicts,
        open_prs=open_prs,
        run_url=args.run_url,
        host=GhIssueHost(),
        upstream_repo=upstream_repo,
        fork_name=fork_name,
    )
    print(json.dumps(result, ensure_ascii=False))
    if result.get("label_warnings"):
        print("WARN: " + "; ".join(result["label_warnings"]), file=sys.stderr)
    return 0


def assert_workflow_is_notify_only(text: str) -> None:
    for needle in FORBIDDEN_WORKFLOW_NEEDLES:
        if needle in text:
            raise AssertionError(f"notify workflow must not contain {needle!r}")
    for needle in REQUIRED_WORKFLOW_NEEDLES:
        if needle not in text:
            raise AssertionError(f"notify workflow must contain {needle!r}")
    if "notify-merge-needed.py" not in text:
        raise AssertionError("notify workflow must invoke notify-merge-needed.py")
    if "check-drift.sh" not in text:
        raise AssertionError("notify workflow must invoke check-drift.sh")


class MemoryHost:
    def __init__(
        self,
        open_issues: dict[str, list[int]] | None = None,
        titles: dict[int, str] | None = None,
        attach_fail: bool = False,
    ) -> None:
        self.open_issues = {key: list(value) for key, value in (open_issues or {}).items()}
        self.titles = dict(titles or {})
        for number in self.open_issues.get(LABEL, []):
            self.titles.setdefault(number, f"{TITLE_PREFIX} seeded #{number}")
        self.created: list[tuple[str, str, list[str]]] = []
        self.updated: list[tuple[int, str, str]] = []
        self.comments: list[tuple[int, str]] = []
        self.closed: list[tuple[int, str]] = []
        self.labels: list[str] = []
        self.attached: list[tuple[int, str]] = []
        self.attach_fail = attach_fail
        self._next_number = 9000

    def list_open(self, label: str) -> list[int]:
        return list(self.open_issues.get(label, []))

    def list_open_tracking(self) -> list[int]:
        open_ids: set[int] = set()
        for values in self.open_issues.values():
            open_ids.update(values)
        return [number for number in sorted(open_ids) if is_tracking_title(self.titles.get(number, ""))]

    def create(self, title: str, body: str, labels: list[str] | None = None) -> int:
        self._next_number += 1
        number = self._next_number
        self.created.append((title, body, list(labels or [])))
        self.titles[number] = title
        self.open_issues.setdefault(LABEL, []).append(number)
        return number

    def update(self, number: int, title: str, body: str) -> None:
        self.updated.append((number, title, body))
        self.titles[number] = title

    def comment(self, number: int, body: str) -> None:
        self.comments.append((number, body))

    def close(self, number: int, comment: str) -> None:
        self.closed.append((number, comment))
        for values in self.open_issues.values():
            if number in values:
                values.remove(number)

    def attach_labels(self, number: int, specs: list[tuple[str, str, str]]) -> list[str]:
        if self.attach_fail:
            return [f"could not ensure label {name!r}" for name, _, _ in specs]
        for name, _, _ in specs:
            self.labels.append(name)
            self.attached.append((number, name))
        return []


def run_selftest() -> int:
    failures: list[str] = []
    expect_count = 0
    upstream_repo = "example/upstream"
    fork_name = "example/fork"

    def expect(name: str, cond: bool) -> None:
        nonlocal expect_count
        expect_count += 1
        print(f"{'PASS' if cond else 'FAIL'} {name}")
        if not cond:
            failures.append(name)

    expect("decide_create", decide_action(behind=3, existing_open=False) == "create")
    expect("decide_update", decide_action(behind=3, existing_open=True) == "update")
    expect("decide_close", decide_action(behind=0, existing_open=True) == "close")
    expect("decide_noop", decide_action(behind=0, existing_open=False) == "noop")
    expect(
        "decide_single_commit_title",
        "1 commit ahead" in render_title(1, upstream_repo=upstream_repo, fork_name=fork_name),
    )
    expect(
        "decide_plural_title",
        "2 commits ahead" in render_title(2, upstream_repo=upstream_repo, fork_name=fork_name),
    )
    expect(
        "slug_from_https",
        github_slug_from_remote_url("https://github.com/acme/demo.git") == "acme/demo",
    )
    expect(
        "slug_from_ssh",
        github_slug_from_remote_url("git@github.com:acme/demo.git") == "acme/demo",
    )

    raised = False
    try:
        decide_action(behind=-1, existing_open=False)
    except ValueError:
        raised = True
    expect("decide_rejects_negative", raised)

    tree = "0123456789abcdef0123456789abcdef01234567\nsrc/a.rs\nsrc/b.ts\n"
    expect("parse_conflicts", parse_merge_tree_conflicts(tree) == ["src/a.rs", "src/b.ts"])
    expect("parse_clean_tree", parse_merge_tree_conflicts("0123456789abcdef0123456789abcdef01234567\n") == [])

    body = render_body(
        drift={"behind": 4, "ahead": 12, "upstream_head": "abc1234", "origin_head": "def5678"},
        commits=["aaaaaaa first", "bbbbbbb second"],
        conflicts=["src/lib.rs"],
        open_prs=[
            {
                "number": 12,
                "title": "leftover",
                "url": "https://example.test/12",
                "headRefName": "merge/upstream-2026-10-10",
            }
        ],
        run_url="https://example.test/run/1",
        fork_name=fork_name,
    )
    expect("body_has_range", "origin/main..upstream/main" in body)
    expect("body_has_skill", "upstream-merge" in body)
    expect("body_has_conflict", "src/lib.rs" in body)
    expect("body_warns_leftover_pr", "Do not treat leftover" in body)
    expect("body_no_agent", "run-headless-agent" not in body)

    created_host = MemoryHost()
    created = apply(
        drift={"behind": 5, "ahead": 1, "upstream_head": "up", "origin_head": "fork"},
        commits=["deadbeef feat"],
        conflicts=[],
        open_prs=[],
        run_url="https://example.test/run/2",
        host=created_host,
        upstream_repo=upstream_repo,
        fork_name=fork_name,
    )
    expect("apply_create", created["action"] == "create" and created["issue"] == 9001)

    updated_host = MemoryHost(open_issues={LABEL: [10, 11]})
    updated = apply(
        drift={"behind": 2, "ahead": 0, "upstream_head": "up", "origin_head": "fork"},
        commits=["c1"],
        conflicts=[],
        open_prs=[],
        run_url="https://example.test/run/3",
        host=updated_host,
        upstream_repo=upstream_repo,
        fork_name=fork_name,
    )
    expect("apply_update", updated["action"] == "update" and updated["issue"] == 10)
    expect("apply_update_closes_duplicate", any(number == 11 for number, _ in updated_host.closed))

    closed_host = MemoryHost(open_issues={LABEL: [10]})
    closed = apply(
        drift={"behind": 0, "ahead": 3, "upstream_head": "up", "origin_head": "fork"},
        commits=[],
        conflicts=[],
        open_prs=[],
        run_url="https://example.test/run/4",
        host=closed_host,
        upstream_repo=upstream_repo,
        fork_name=fork_name,
    )
    expect("apply_close", closed["action"] == "close" and closed["issue"] is None)

    noop_host = MemoryHost()
    noop = apply(
        drift={"behind": 0, "ahead": 0, "upstream_head": "up", "origin_head": "fork"},
        commits=[],
        conflicts=[],
        open_prs=[],
        run_url="https://example.test/run/5",
        host=noop_host,
        upstream_repo=upstream_repo,
        fork_name=fork_name,
    )
    expect("apply_noop", noop["action"] == "noop" and not noop_host.created and not noop_host.closed)

    unlabeled_host = MemoryHost(
        open_issues={"other": [12]},
        titles={12: render_title(9, upstream_repo=upstream_repo, fork_name=fork_name)},
    )
    unlabeled = apply(
        drift={"behind": 2, "ahead": 0, "upstream_head": "up", "origin_head": "fork"},
        commits=["c1"],
        conflicts=[],
        open_prs=[],
        run_url="https://example.test/run/6",
        host=unlabeled_host,
        upstream_repo=upstream_repo,
        fork_name=fork_name,
    )
    expect(
        "apply_update_by_title_without_label",
        unlabeled["action"] == "update" and unlabeled["issue"] == 12 and not unlabeled_host.created,
    )

    label_fail_host = MemoryHost(attach_fail=True)
    label_fail = apply(
        drift={"behind": 6, "ahead": 0, "upstream_head": "up", "origin_head": "fork"},
        commits=["deadbeef feat"],
        conflicts=[],
        open_prs=[],
        run_url="https://example.test/run/7",
        host=label_fail_host,
        upstream_repo=upstream_repo,
        fork_name=fork_name,
    )
    expect(
        "apply_create_survives_label_failure",
        label_fail["action"] == "create" and label_fail["issue"] == 9001 and label_fail_host.created,
    )

    root = payload_root()
    workflow = root / WORKFLOW_RELPATH
    expect("workflow_file_exists", workflow.is_file())
    if workflow.is_file():
        try:
            assert_workflow_is_notify_only(workflow.read_text(encoding="utf-8"))
            workflow_ok = True
            workflow_err = ""
        except AssertionError as exc:
            workflow_ok = False
            workflow_err = str(exc)
        expect("workflow_is_notify_only", workflow_ok)
        if not workflow_ok:
            print(f"FAIL workflow_is_notify_only detail: {workflow_err}")

    expect("check_drift_exists", (root / "scripts/upstream/check-drift.sh").is_file())
    expect("drift_lib_exists", (root / "scripts/lib/upstream-drift.sh").is_file())
    expect("upstream_url_conf_exists", (root / "scripts/lib/upstream-url.conf").is_file())
    if (root / "scripts/lib/upstream-drift.sh").is_file():
        lib_text = (root / "scripts/lib/upstream-drift.sh").read_text(encoding="utf-8")
        expect("drift_lib_managed", MANAGED_MARKER in lib_text)
    if (root / "scripts/lib/upstream-url.conf").is_file():
        conf = (root / "scripts/lib/upstream-url.conf").read_text(encoding="utf-8").strip()
        expect("upstream_url_conf_has_placeholder_or_url", bool(conf))

    passed = expect_count - len(failures)
    print(f"notify-merge-needed self-test ({passed}/{expect_count} cases passed)")
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Create or refresh the upstream-merge-needed issue.")
    parser.add_argument("--selftest", action="store_true")
    sub = parser.add_subparsers(dest="command")
    apply_parser = sub.add_parser("apply", help="create/update/close the tracking issue via gh")
    apply_parser.add_argument("--drift", required=True, help="path to check-drift.sh --json output")
    apply_parser.add_argument("--commits", default="", help="path to git log origin/main..upstream/main")
    apply_parser.add_argument("--conflicts", default="", help="path to git merge-tree --name-only output")
    apply_parser.add_argument("--open-prs", default="", help="path to leftover merge/upstream-* PR JSON")
    apply_parser.add_argument("--run-url", default="", help="CI run URL written into the issue body")
    args = parser.parse_args()

    if args.selftest:
        return run_selftest()
    if args.command == "apply":
        return cmd_apply(args)
    parser.error("one of apply / --selftest is required")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
