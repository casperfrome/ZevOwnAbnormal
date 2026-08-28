from sqlglot import exp, parse
from sqlglot.errors import ParseError


class SqlValidationError(ValueError):
    pass


_MUTATING_NODES = (
    exp.Insert,
    exp.Update,
    exp.Delete,
    exp.Create,
    exp.Drop,
    exp.Alter,
    exp.Command,
    exp.Merge,
    exp.TruncateTable,
    exp.Lock,
)


def validate_readonly_sql(sql: str) -> str:
    if not isinstance(sql, str) or not sql.strip():
        raise SqlValidationError("SQL 不能为空")
    try:
        statements = [statement for statement in parse(sql, read="mysql") if statement]
    except ParseError as exc:
        raise SqlValidationError(f"SQL 解析失败: {exc}") from exc
    if len(statements) != 1:
        raise SqlValidationError("仅允许执行一条 SQL")
    statement = statements[0]
    if not isinstance(statement, (exp.Select, exp.Union)):
        raise SqlValidationError("仅允许 SELECT 或 WITH 查询")
    if statement.args.get("into") is not None or any(statement.find(node_type) is not None for node_type in _MUTATING_NODES):
        raise SqlValidationError("SQL 包含写入或结构变更操作")
    return statement.sql(dialect="mysql")
