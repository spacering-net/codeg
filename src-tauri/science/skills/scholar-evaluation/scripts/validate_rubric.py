#!/usr/bin/env python3
"""Validate a bounded scholar-evaluation rubric JSON file."""

from __future__ import annotations

import argparse
from pathlib import Path

import _common


def validate_file(path: Path) -> dict:
    rubric = _common.read_json(path)
    issues = _common.validate_rubric(rubric)
    errors = _common.error_issues(issues)
    return {
        "schema_version": _common.SCHEMA_VERSION,
        "report_type": "rubric_schema_validation",
        "status": "invalid" if errors else "valid",
        "rubric_id": rubric.get("rubric_id") if isinstance(rubric, dict) else None,
        "error_count": len(errors),
        "warning_count": len(issues) - len(errors),
        "issues": [issue.as_dict() for issue in issues],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Validate a strict local rubric schema; no document content, "
            "credentials, models, or network access are used."
        )
    )
    parser.add_argument("--rubric", required=True, type=Path, help="Local rubric JSON")
    parser.add_argument("--output", type=Path, help="Optional local JSON report")
    parser.add_argument(
        "--force", action="store_true", help="Replace an existing output JSON file"
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        report = validate_file(args.rubric)
        _common.write_json(report, args.output, force=args.force)
        return 0 if report["status"] == "valid" else 2
    except _common.ValidationError as error:
        _common.write_json(_common.failure_report(error), None)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
