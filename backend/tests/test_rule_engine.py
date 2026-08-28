from datetime import date

import pytest

from app.rule_engine import evaluate_rows
from app.schemas import RuleSchedule


def test_static_operators_and_and_logic():
    rows = [
        {"store_id": "S1", "gmv": 120, "refund_rate": 0.03},
        {"store_id": "S2", "gmv": 80, "refund_rate": 0.08},
    ]
    conditions = [
        {"field": "gmv", "operator": "gte", "value": 100},
        {"field": "refund_rate", "operator": "lt", "value": 0.05},
    ]

    matches = evaluate_rows(rows, conditions, "AND", ["store_id"])

    assert [m.row["store_id"] for m in matches] == ["S1"]


def test_numeric_field_compares_against_string_threshold_from_rule_form():
    rows = [
        {"store_id": "S1", "gmv": 3499.99},
        {"store_id": "S2", "gmv": 3500.00},
    ]
    conditions = [{"field": "gmv", "operator": "lt", "value": "3500"}]

    matches = evaluate_rows(rows, conditions, "AND", ["store_id"])

    assert [match.row["store_id"] for match in matches] == ["S1"]


def test_between_and_null_operators():
    rows = [
        {"id": 1, "score": 7, "owner": None},
        {"id": 2, "score": 11, "owner": "ou_1"},
    ]
    conditions = [
        {"field": "score", "operator": "between", "value": 5, "upper_value": 10},
        {"field": "owner", "operator": "is_null"},
    ]

    matches = evaluate_rows(rows, conditions, "AND", ["id"])

    assert len(matches) == 1
    assert matches[0].business_key == {"id": 1}


def test_seven_day_baseline_requires_full_history_and_compares_current_row():
    rows = [
        {"store_id": "S1", "metric_date": date(2026, 8, day), "gmv": 100}
        for day in range(1, 8)
    ]
    rows.append({"store_id": "S1", "metric_date": date(2026, 8, 8), "gmv": 250})
    conditions = [
        {
            "field": "gmv",
            "operator": "gt_threshold_ratio",
            "value": 2,
            "baseline": "7d_avg",
        }
    ]

    matches = evaluate_rows(
        rows,
        conditions,
        "AND",
        ["store_id", "metric_date"],
        field_types={"metric_date": "DATE"},
    )

    assert len(matches) == 1
    assert matches[0].row["metric_date"] == date(2026, 8, 8)
    assert matches[0].matched_conditions[0]["baseline_value"] == 100


def test_field_operands_are_resolved_per_row_and_mixed_range_keeps_evidence():
    rows = [{"id": 1, "actual": 7, "minimum": 5}, {"id": 2, "actual": 3, "minimum": 5}]
    conditions = [{"field": "actual", "operator": "between", "value_source": "field",
                   "value_field": "minimum", "upper_value": 10}]
    matches = evaluate_rows(rows, conditions, "AND", ["id"])
    assert [match.business_key for match in matches] == [{"id": 1}]
    assert matches[0].matched_conditions[0]["value_field"] == "minimum"
    assert matches[0].matched_conditions[0]["resolved_value"] == 5
    assert matches[0].matched_conditions[0]["resolved_upper_value"] == 10


def test_field_operand_missing_null_and_incompatible_values_are_not_literals():
    condition = {"field": "actual", "operator": "gt", "value_source": "field", "value_field": "target"}
    assert evaluate_rows([{"id": 1, "actual": 2, "target": None}], [condition], "AND", ["id"]) == []
    with pytest.raises(ValueError, match="target"):
        evaluate_rows([{"id": 1, "actual": 2}], [condition], "AND", ["id"])
    with pytest.raises(ValueError, match="比较"):
        evaluate_rows([{"id": 1, "actual": 2, "target": "bad"}], [condition], "AND", ["id"])


def test_baseline_multiplier_can_come_from_current_row():
    rows = [{"id": 1, "day": date(2026, 8, day), "actual": value, "ratio": 2}
            for day, value in [(1, 10), (2, 21)]]
    matches = evaluate_rows(rows, [{"field": "actual", "operator": "gt_threshold_ratio",
        "baseline": "prev_period", "value_source": "field", "value_field": "ratio"}],
        "AND", ["id", "day"], {"day": "DATE"})
    assert len(matches) == 1
    assert matches[0].matched_conditions[0]["resolved_value"] == 2


@pytest.mark.parametrize("operator", ["eq", "neq"])
def test_equality_rejects_incompatible_field_types(operator):
    with pytest.raises(ValueError, match="比较"):
        evaluate_rows([{"id": 1, "actual": "failed", "expected": 1}], [
            {"field": "actual", "operator": operator, "value_source": "field", "value_field": "expected"}
        ], "AND", ["id"])


def test_inactive_upper_literal_draft_does_not_break_field_comparison_schema():
    from app.schemas import Condition
    condition = Condition(field="actual", operator="gt", value_source="field", value_field="expected",
                          value="old text", upper_value="unused text")
    assert condition.value_field == "expected"


@pytest.mark.parametrize("operator", ["eq", "is_null"])
def test_missing_condition_field_is_not_treated_as_null(operator):
    with pytest.raises(ValueError, match="actual"):
        evaluate_rows([{"id": 1, "target": 2}], [
            {"field": "actual", "operator": operator, "value_source": "field", "value_field": "target"}
        ], "AND", ["id"])


def test_invalid_baselines_are_nonmatches_without_blocking_or_conditions():
    rows = [{"id": 1, "day": "invalid", "actual": 100, "other": 0}, {"id": 2, "day": "2026-08-02", "actual": 100, "other": 1}]
    conditions = [
        {"field": "actual", "operator": "gt_threshold_ratio", "value": 2, "baseline": "prev_period"},
        {"field": "other", "operator": "eq", "value": 1},
    ]
    matches = evaluate_rows(rows, conditions, "OR", ["id", "day"], {"day": "DATE"})
    assert [match.row["id"] for match in matches] == [2]
    assert evaluate_rows(
        [{"id": 1, "day": "2026-08-01", "actual": None}, {"id": 2, "day": "2026-08-02", "actual": 10}],
        [conditions[0]], "AND", ["id", "day"], {"day": "DATE"},
    ) == []


@pytest.mark.parametrize("payload", [
    {"frequency": "day", "interval": 1, "time": "25:00", "start_date": "2026-02-30"},
    {"frequency": "day", "interval": 1, "time": "09:30:00", "start_date": "2026-08-01"},
    {"frequency": "day", "interval": 1, "time": "09:30", "start_date": "2026-08-02", "end_date": "2026-08-01"},
])
def test_rule_schedule_requires_real_iso_dates_hh_mm_and_order(payload):
    with pytest.raises(ValueError):
        RuleSchedule(**payload)
    assert RuleSchedule(frequency="day", interval=1, time="09:30", start_date="2026-08-01", end_date="").end_date is None
