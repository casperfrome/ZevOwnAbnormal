from datetime import date

from app.rule_engine import evaluate_rows


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
