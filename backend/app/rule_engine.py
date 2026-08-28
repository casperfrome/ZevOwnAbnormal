from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from statistics import mean
from typing import Any


@dataclass(frozen=True)
class EvaluationMatch:
    row: dict[str, Any]
    business_key: dict[str, Any]
    matched_conditions: list[dict[str, Any]]


def _comparable(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    return value


def _operand_for(actual: Any, operand: Any) -> Any:
    if isinstance(actual, (int, float)) and not isinstance(actual, bool) and isinstance(operand, str):
        return float(operand)
    return operand


class MissingComparisonField(ValueError):
    pass


def resolve_condition_operands(condition: dict[str, Any], row: dict[str, Any]) -> dict[str, Any]:
    resolved = dict(condition)
    if condition["operator"] in {"is_null", "is_not_null"}:
        return resolved
    names = ["value", "upper_value"] if condition["operator"] == "between" else ["value"]
    for name in names:
        if condition.get(f"{name}_source", "literal") == "field":
            field = condition.get(f"{name}_field")
            if not field or field not in row:
                raise MissingComparisonField(f"比较目标字段不存在：{field or '-'}")
            resolved[f"resolved_{name}"] = row[field]
        else:
            resolved[f"resolved_{name}"] = condition.get(name)
    return resolved


def evaluate_static_condition(actual: Any, condition: dict[str, Any]) -> bool:
    operator = condition["operator"]
    actual = _comparable(actual)
    if operator == "is_null":
        return actual is None
    if operator == "is_not_null":
        return actual is not None
    if actual is None:
        return False
    try:
        value = _operand_for(actual, _comparable(condition.get("resolved_value", condition.get("value"))))
        upper = (_operand_for(actual, _comparable(condition.get("resolved_upper_value", condition.get("upper_value"))))
                 if operator == "between" else None)
    except (TypeError, ValueError) as exc:
        raise ValueError("比较值类型不兼容") from exc
    if value is None or (operator == "between" and upper is None):
        return False
    operands = [value, upper] if operator == "between" else [value]
    for operand in operands:
        numeric_pair = (isinstance(actual, (int, float)) and not isinstance(actual, bool)
                        and isinstance(operand, (int, float)) and not isinstance(operand, bool))
        if not numeric_pair and type(actual) is not type(operand):
            raise ValueError("比较值类型不兼容")
    operations = {
        "gt": lambda: actual > value,
        "gte": lambda: actual >= value,
        "lt": lambda: actual < value,
        "lte": lambda: actual <= value,
        "eq": lambda: actual == value,
        "neq": lambda: actual != value,
        "between": lambda: value <= actual <= upper,
    }
    if operator not in operations:
        raise ValueError(f"不支持的操作符: {operator}")
    try:
        return operations[operator]()
    except (TypeError, ValueError) as exc:
        raise ValueError("比较值类型不兼容") from exc


def _date_value(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).date()
        except ValueError:
            return None
    return None


def _baseline_value(
    rows: list[dict[str, Any]],
    index: int,
    field: str,
    baseline: str,
    key_fields: list[str],
    time_field: str,
) -> float | None:
    current = rows[index]
    current_date = _date_value(current.get(time_field))
    if current_date is None:
        return None
    group_fields = [field_name for field_name in key_fields if field_name != time_field]
    prior = [
        row
        for row in rows[:index]
        if all(row.get(name) == current.get(name) for name in group_fields)
        and _date_value(row.get(time_field)) is not None
        and _date_value(row.get(time_field)) < current_date
    ]
    if baseline == "prev_period":
        if not prior:
            return None
        previous_value = prior[-1].get(field)
        return float(_comparable(previous_value)) if previous_value is not None else None
    days = 7 if baseline == "7d_avg" else 30 if baseline == "30d_avg" else None
    if days is None:
        raise ValueError(f"不支持的基线: {baseline}")
    window_start = current_date - timedelta(days=days)
    window = [
        row
        for row in prior
        if _date_value(row.get(time_field)) >= window_start and row.get(field) is not None
    ]
    distinct_days = {_date_value(row.get(time_field)) for row in window}
    if len(distinct_days) < days:
        return None
    return float(mean(float(_comparable(row[field])) for row in window))


def evaluate_rows(
    rows: list[dict[str, Any]],
    conditions: list[dict[str, Any]],
    logic: str,
    key_fields: list[str],
    field_types: dict[str, str] | None = None,
) -> list[EvaluationMatch]:
    if not key_fields:
        raise ValueError("至少选择一个异常主键字段")
    field_types = field_types or {}
    baseline_conditions = [c for c in conditions if c["operator"].endswith("threshold_ratio")]
    time_fields = [
        field for field in key_fields if field_types.get(field, "").upper() in {"DATE", "DATETIME", "TIMESTAMP"}
    ]
    if baseline_conditions and len(time_fields) != 1:
        raise ValueError("基线规则要求异常主键中恰好包含一个日期时间字段")
    time_field = time_fields[0] if time_fields else ""
    if baseline_conditions:
        rows = sorted(
            rows,
            key=lambda row: tuple(str(row.get(k, "")) for k in key_fields if k != time_field)
            + ((_date_value(row.get(time_field)) or date.min).isoformat(),),
        )

    matches: list[EvaluationMatch] = []
    for index, row in enumerate(rows):
        evaluations: list[tuple[bool, dict[str, Any]]] = []
        for condition in conditions:
            if condition["field"] not in row:
                raise MissingComparisonField(f"比较字段不存在：{condition['field']}")
            operator = condition["operator"]
            detail = resolve_condition_operands(condition, row)
            detail["actual"] = row.get(condition["field"])
            if operator.endswith("threshold_ratio"):
                baseline = _baseline_value(rows, index, condition["field"], condition["baseline"], key_fields, time_field)
                detail["baseline_value"] = baseline
                if baseline is None or row.get(condition["field"]) is None or detail.get("resolved_value") is None:
                    passed = False
                else:
                    try:
                        ratio = float(detail["resolved_value"])
                        actual = float(_comparable(row[condition["field"]]))
                    except (TypeError, ValueError) as exc:
                        raise ValueError("基线比较值类型不兼容") from exc
                    passed = actual > baseline * ratio if operator.startswith("gt_") else actual < baseline * ratio
            else:
                passed = evaluate_static_condition(row.get(condition["field"]), detail)
            detail["matched"] = passed
            evaluations.append((passed, detail))
        is_match = all(item[0] for item in evaluations) if logic == "AND" else any(item[0] for item in evaluations)
        if is_match:
            matches.append(
                EvaluationMatch(
                    row=row,
                    business_key={field: row.get(field) for field in key_fields},
                    matched_conditions=[item[1] for item in evaluations if item[0]],
                )
            )
    return matches
