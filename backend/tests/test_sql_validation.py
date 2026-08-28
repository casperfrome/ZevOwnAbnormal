from __future__ import annotations

from contextlib import contextmanager
from decimal import Decimal

import pytest


SQL_CONFIG = {
    "query_template": (
        "SELECT status, temperature FROM test_table "
        "WHERE id='{目标ID}' AND data_date={数据日期}"
    ),
    "parameters": [
        {"name": "目标ID", "field": "target_id"},
        {"name": "数据日期", "field": "data_date"},
    ],
    "true_condition": {"field": "status", "operator": "eq", "value": "normal"},
}


class FakeCursor:
    def __init__(self, rows):
        self.rows = list(rows)
        self.executed = None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, values):
        self.executed = (sql, values)

    def fetchmany(self, size):
        return self.rows[:size]


class FakeConnection:
    def __init__(self, rows):
        self.cursor_instance = FakeCursor(rows)

    def cursor(self):
        return self.cursor_instance


def test_sql_field_operand_uses_query_result_not_original_anomaly():
    from app.sql_validation import execute_sql_validation
    from app.schemas import SqlTrueCondition
    condition = SqlTrueCondition(field="actual", operator="eq", value_source="field", value_field="expected")
    config = {"query_template": "SELECT actual, expected FROM t", "parameters": [],
              "true_condition": condition.model_dump()}
    result = execute_sql_validation(FakeConnection([{"actual": 5, "expected": 5}]), config, {"expected": 99})
    assert result.passed is True
    assert result.result_detail["resolved_value"] == 5
    missing = execute_sql_validation(FakeConnection([{"actual": 5}]), config, {"expected": 5})
    assert missing.passed is False
    assert missing.reason == "missing_field"
    assert missing.result_detail["value_field"] == "expected"


def test_template_compiles_quoted_and_bare_chinese_placeholders_to_bound_values():
    """String interpolation or losing SQL-order parameter binding must fail this test."""
    from app.sql_validation import compile_sql_validation

    compiled = compile_sql_validation(
        SQL_CONFIG,
        {"target_id": "T' OR 1=1 --", "data_date": "2026-08-22"},
        dataset_fields={"target_id", "data_date"},
    )

    assert compiled.sql == (
        "SELECT status, temperature FROM test_table "
        "WHERE id=%s AND data_date=%s"
    )
    assert compiled.values == ("T' OR 1=1 --", "2026-08-22")


@pytest.mark.parametrize(
    ("config", "row", "message"),
    [
        (
            {**SQL_CONFIG, "parameters": [{"name": "目标ID", "field": "target_id"}]},
            {"target_id": "T1", "data_date": "2026-08-22"},
            "未配置参数",
        ),
        (
            {**SQL_CONFIG, "query_template": "SELECT * FROM t WHERE id='{目标ID}' OR note='%{目标ID}%'"},
            {"target_id": "T1", "data_date": "2026-08-22"},
            "完整参数标记",
        ),
        (
            {
                **SQL_CONFIG,
                "query_template": "DELETE FROM test_table WHERE id='{目标ID}'",
                "parameters": [{"name": "目标ID", "field": "target_id"}],
            },
            {"target_id": "T1", "data_date": "2026-08-22"},
            "仅允许 SELECT",
        ),
        (
            {
                **SQL_CONFIG,
                "query_template": "SELECT status FROM test_table WHERE id='{目标ID}' FOR UPDATE",
                "parameters": [{"name": "目标ID", "field": "target_id"}],
            },
            {"target_id": "T1", "data_date": "2026-08-22"},
            "写入或结构变更",
        ),
    ],
)
def test_template_rejects_incomplete_unsafe_or_mutating_configuration(config, row, message):
    """A malformed template must be rejected before any datasource query is attempted."""
    from app.sql_validation import SqlValidationConfigurationError, compile_sql_validation

    with pytest.raises(SqlValidationConfigurationError, match=message):
        compile_sql_validation(config, row, dataset_fields={"target_id", "data_date"})


def test_executor_requires_exactly_one_row_and_reports_condition_details():
    """Accepting zero/multiple rows or hiding the compared value must fail this test."""
    from app.sql_validation import execute_sql_validation

    passed_connection = FakeConnection([{"status": "normal", "temperature": Decimal("-18.5")}])
    passed = execute_sql_validation(
        passed_connection,
        SQL_CONFIG,
        {"target_id": "T1", "data_date": "2026-08-22"},
        dataset_fields={"target_id", "data_date"},
    )
    assert passed.passed is True
    assert passed.reason == "condition_passed"
    assert passed.result_detail == {
        "field": "status",
        "operator": "eq",
        "value": "normal",
        "upper_value": None,
        "actual": "normal",
    }
    assert passed_connection.cursor_instance.executed[1] == ("T1", "2026-08-22")

    for rows, expected_reason in (([], "no_rows"), ([{"status": "normal"}, {"status": "normal"}], "multiple_rows")):
        result = execute_sql_validation(
            FakeConnection(rows),
            SQL_CONFIG,
            {"target_id": "T1", "data_date": "2026-08-22"},
            dataset_fields={"target_id", "data_date"},
        )
        assert result.passed is False
        assert result.reason == expected_reason


@pytest.mark.parametrize(
    ("operator", "actual", "value", "upper", "expected"),
    [
        ("eq", "ok", "ok", None, True),
        ("neq", "bad", "ok", None, True),
        ("gt", Decimal("2.5"), 2, None, True),
        ("gte", 2, 2, None, True),
        ("lt", -18, -12, None, True),
        ("lte", -12, -12, None, True),
        ("between", 5, 1, 10, True),
        ("is_null", None, None, None, True),
        ("is_not_null", "value", None, None, True),
    ],
)
def test_sql_true_condition_reuses_static_rule_operators(operator, actual, value, upper, expected):
    """Diverging SQL condition semantics from rule static conditions must fail this test."""
    from app.rule_engine import evaluate_static_condition

    assert evaluate_static_condition(
        actual,
        {"operator": operator, "value": value, "upper_value": upper},
    ) is expected
