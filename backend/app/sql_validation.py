from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .rule_engine import MissingComparisonField, evaluate_static_condition, resolve_condition_operands
from .sql_guard import SqlValidationError, validate_readonly_sql


class SqlValidationConfigurationError(ValueError):
    pass


@dataclass(frozen=True)
class CompiledSqlValidation:
    sql: str
    values: tuple[Any, ...]


@dataclass(frozen=True)
class SqlValidationResult:
    passed: bool
    reason: str
    result_detail: dict[str, Any]


def _parameter_mapping(config: dict) -> dict[str, str]:
    mappings: dict[str, str] = {}
    for parameter in config.get("parameters") or []:
        name = str(parameter.get("name") or "").strip()
        field = str(parameter.get("field") or "").strip()
        if not name or not field:
            raise SqlValidationConfigurationError("SQL 参数名和数据集字段不能为空")
        if name in mappings:
            raise SqlValidationConfigurationError(f"SQL 参数名不能重复: {name}")
        mappings[name] = field
    return mappings


def _consume_placeholder(template: str, start: int) -> tuple[str, int]:
    end = template.find("}", start + 1)
    if end < 0:
        raise SqlValidationConfigurationError("SQL 参数必须使用完整参数标记 {参数名}")
    name = template[start + 1:end].strip()
    if not name or "{" in name:
        raise SqlValidationConfigurationError("SQL 参数必须使用完整参数标记 {参数名}")
    return name, end + 1


def _compile_template(template: str) -> tuple[str, str, list[str]]:
    compiled: list[str] = []
    validation: list[str] = []
    names: list[str] = []
    index = 0
    quote: str | None = None
    while index < len(template):
        char = template[index]
        if quote is None:
            if char == "'" and index + 1 < len(template) and template[index + 1] == "{":
                name, after = _consume_placeholder(template, index + 1)
                if after >= len(template) or template[after] != "'":
                    raise SqlValidationConfigurationError("SQL 参数必须使用完整参数标记，不能嵌入字符串")
                compiled.append("%s")
                validation.append("NULL")
                names.append(name)
                index = after + 1
                continue
            if char == "{":
                name, after = _consume_placeholder(template, index)
                compiled.append("%s")
                validation.append("NULL")
                names.append(name)
                index = after
                continue
            if char in {"'", '"', "`"}:
                quote = char
            compiled.append(char)
            validation.append(char)
            index += 1
            continue

        if char == "{" or char == "}":
            raise SqlValidationConfigurationError("SQL 参数必须使用完整参数标记，不能嵌入字符串")
        compiled.append(char)
        validation.append(char)
        if char == quote:
            if index + 1 < len(template) and template[index + 1] == quote:
                compiled.append(template[index + 1])
                validation.append(template[index + 1])
                index += 2
                continue
            quote = None
        index += 1
    if quote is not None:
        raise SqlValidationConfigurationError("SQL 字符串引号未闭合")
    return "".join(compiled), "".join(validation), names


def compile_sql_validation(
    config: dict,
    row_details: dict[str, Any],
    *,
    dataset_fields: set[str] | None = None,
) -> CompiledSqlValidation:
    template = str(config.get("query_template") or "").strip()
    if not template:
        raise SqlValidationConfigurationError("SQL 不能为空")
    sql, validation_sql, placeholder_names = _compile_template(template)
    mappings = _parameter_mapping(config)
    used_names = set(placeholder_names)
    missing = sorted(used_names - set(mappings))
    if missing:
        raise SqlValidationConfigurationError(f"SQL 未配置参数: {', '.join(missing)}")
    unused = sorted(set(mappings) - used_names)
    if unused:
        raise SqlValidationConfigurationError(f"SQL 未使用参数: {', '.join(unused)}")
    values: list[Any] = []
    for name in placeholder_names:
        field = mappings[name]
        if dataset_fields is not None and field not in dataset_fields:
            raise SqlValidationConfigurationError(f"参数 {name} 映射的数据集字段不存在: {field}")
        if field not in row_details:
            raise SqlValidationConfigurationError(f"异常数据缺少参数字段: {field}")
        values.append(row_details[field])
    try:
        validate_readonly_sql(validation_sql)
    except SqlValidationError as exc:
        raise SqlValidationConfigurationError(str(exc)) from exc
    return CompiledSqlValidation(sql=sql, values=tuple(values))


def validate_sql_validation_config(config: dict, dataset_fields: set[str]) -> None:
    row_details = {
        str(parameter.get("field") or "").strip(): None
        for parameter in config.get("parameters") or []
    }
    compile_sql_validation(
        config,
        row_details,
        dataset_fields=dataset_fields,
    )


def execute_sql_validation(
    connection,
    config: dict,
    row_details: dict[str, Any],
    *,
    dataset_fields: set[str] | None = None,
) -> SqlValidationResult:
    compiled = compile_sql_validation(
        config,
        row_details,
        dataset_fields=dataset_fields,
    )
    with connection.cursor() as cursor:
        cursor.execute(compiled.sql, compiled.values)
        rows = list(cursor.fetchmany(2))
    if not rows:
        return SqlValidationResult(False, "no_rows", {})
    if len(rows) > 1:
        return SqlValidationResult(False, "multiple_rows", {})
    condition = config["true_condition"]
    field = condition["field"]
    if field not in rows[0]:
        return SqlValidationResult(False, "missing_field", {
            "field": field,
            "operator": condition["operator"],
            "value": condition.get("value"),
            "upper_value": condition.get("upper_value"),
            "actual": None,
        })
    actual = rows[0][field]
    detail = {
        "field": field,
        "operator": condition["operator"],
        "value": condition.get("value"),
        "upper_value": condition.get("upper_value"),
        "actual": actual,
    }
    try:
        resolved = resolve_condition_operands(condition, rows[0])
    except MissingComparisonField:
        return SqlValidationResult(False, "missing_field", {**condition, "actual": actual})
    # Keep legacy literal result details stable; field comparisons retain both
    # their source expression and the evaluated operands.
    if any(condition.get(f"{name}_source") == "field" for name in ("value", "upper_value")):
        detail.update(resolved)
    try:
        passed = evaluate_static_condition(actual, resolved)
    except ValueError:
        return SqlValidationResult(False, "invalid_comparison", detail)
    return SqlValidationResult(passed, "condition_passed" if passed else "condition_failed", detail)
