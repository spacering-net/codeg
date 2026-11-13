#!/usr/bin/env python3
"""Calculate transparent bounded rubric math for one scholarly work."""

from __future__ import annotations

import argparse
from pathlib import Path

import _common


def calculate(rubric: dict, evaluation: dict) -> dict:
    rubric_issues = _common.validate_rubric(rubric)
    _common.require_valid(rubric_issues)
    evaluation_issues = _common.validate_evaluation(evaluation, rubric)
    _common.require_valid(evaluation_issues)
    report = _common.score_evaluation(rubric, evaluation)
    report["rubric_warnings"] = [
        issue.as_dict() for issue in rubric_issues if issue.level == "warning"
    ]
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Compute bounded descriptive rubric scores with explicit missing, "
            "not-applicable, coverage, and uncertainty fields. The output never "
            "makes a decision recommendation."
        )
    )
    parser.add_argument("--rubric", required=True, type=Path, help="Local rubric JSON")
    parser.add_argument(
        "--evaluation", required=True, type=Path, help="Local evaluation JSON"
    )
    parser.add_argument("--output", type=Path, help="Optional local JSON report")
    parser.add_argument(
        "--force", action="store_true", help="Replace an existing output JSON file"
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        rubric = _common.read_json(args.rubric)
        evaluation = _common.read_json(args.evaluation)
        report = calculate(rubric, evaluation)
        _common.write_json(report, args.output, force=args.force)
        return 0
    except _common.ValidationError as error:
        _common.write_json(_common.failure_report(error), None)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
