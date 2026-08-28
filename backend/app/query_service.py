from __future__ import annotations

from time import perf_counter
from typing import Any

import pymysql
from pymysql.constants import FIELD_TYPE
from pymysql.cursors import DictCursor

from .models import Datasource
from .sql_guard import validate_readonly_sql


TYPE_NAMES = {
    FIELD_TYPE.TINY: "TINYINT",
    FIELD_TYPE.SHORT: "SMALLINT",
    FIELD_TYPE.LONG: "INT",
    FIELD_TYPE.LONGLONG: "BIGINT",
    FIELD_TYPE.FLOAT: "FLOAT",
    FIELD_TYPE.DOUBLE: "DOUBLE",
    FIELD_TYPE.DECIMAL: "DECIMAL",
    FIELD_TYPE.NEWDECIMAL: "DECIMAL",
    FIELD_TYPE.DATE: "DATE",
    FIELD_TYPE.DATETIME: "DATETIME",
    FIELD_TYPE.TIMESTAMP: "TIMESTAMP",
    FIELD_TYPE.JSON: "JSON",
    FIELD_TYPE.BLOB: "TEXT",
    FIELD_TYPE.STRING: "VARCHAR",
    FIELD_TYPE.VAR_STRING: "VARCHAR",
    FIELD_TYPE.VARCHAR: "VARCHAR",
}


def connect_to_datasource(datasource: Datasource, password: str):
    ssl_options = {"check_hostname": False} if datasource.ssl else None
    return pymysql.connect(
        host=datasource.host,
        port=datasource.port,
        user=datasource.username,
        password=password,
        database=datasource.database,
        charset="utf8mb4",
        cursorclass=DictCursor,
        connect_timeout=5,
        read_timeout=60,
        write_timeout=10,
        ssl=ssl_options,
        autocommit=True,
    )


def execute_readonly_query(connection, sql: str, limit: int = 200) -> dict[str, Any]:
    normalized = validate_readonly_sql(sql)
    wrapped = f"SELECT * FROM ({normalized}) AS sentinel_preview LIMIT %s"
    started = perf_counter()
    with connection.cursor() as cursor:
        cursor.execute(wrapped, (limit + 1,))
        rows = list(cursor.fetchall())
        fields = [
            {"name": column[0], "type": TYPE_NAMES.get(column[1], "VARCHAR")}
            for column in (cursor.description or ())
        ]
    has_extra_row = len(rows) > limit
    return {
        "fields": fields,
        "rows": rows[:limit],
        "row_count": min(len(rows), limit),
        "truncated": has_extra_row,
        "elapsed_ms": round((perf_counter() - started) * 1000, 2),
    }


def fetch_rule_rows(connection, sql: str, batch_size: int = 1000) -> tuple[list[dict], list[dict]]:
    normalized = validate_readonly_sql(sql)
    rows: list[dict] = []
    with connection.cursor() as cursor:
        cursor.execute(normalized)
        fields = [
            {"name": column[0], "type": TYPE_NAMES.get(column[1], "VARCHAR")}
            for column in (cursor.description or ())
        ]
        while True:
            batch = cursor.fetchmany(batch_size)
            if not batch:
                break
            rows.extend(batch)
    return fields, rows
