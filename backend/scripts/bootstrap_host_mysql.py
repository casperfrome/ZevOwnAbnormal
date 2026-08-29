from __future__ import annotations

import re
import sys
from pathlib import Path

import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.local_infrastructure import ENV_FILE, load_local_infrastructure_settings


IDENTIFIER = re.compile(r"^[A-Za-z0-9_]+$")
BUSINESS_DATABASE = "test_260828"


def quote_identifier(value: str) -> str:
    if not IDENTIFIER.fullmatch(value):
        raise ValueError(f"不安全的 MySQL 标识符：{value!r}")
    return f"`{value}`"


def bootstrap(env_file: Path = ENV_FILE) -> None:
    settings = load_local_infrastructure_settings(env_file)
    mysql = settings.mysql
    connection = pymysql.connect(
        host=mysql.host,
        port=mysql.port,
        user=mysql.admin_user,
        password=mysql.admin_password,
        charset="utf8mb4",
        autocommit=False,
    )
    try:
        databases = (mysql.database, BUSINESS_DATABASE)
        with connection.cursor() as cursor:
            for database in databases:
                cursor.execute(
                    f"CREATE DATABASE IF NOT EXISTS {quote_identifier(database)} "
                    "CHARACTER SET utf8mb4"
                )
            for host in ("localhost", "%"):
                account = (mysql.app_user, host)
                cursor.execute(
                    "CREATE USER IF NOT EXISTS %s@%s IDENTIFIED BY %s",
                    (*account, mysql.app_password),
                )
                cursor.execute(
                    "ALTER USER %s@%s IDENTIFIED BY %s",
                    (*account, mysql.app_password),
                )
                cursor.execute(
                    f"GRANT ALL PRIVILEGES ON {quote_identifier(mysql.database)}.* TO %s@%s",
                    account,
                )
                cursor.execute(
                    f"GRANT SELECT ON {quote_identifier(BUSINESS_DATABASE)}.* TO %s@%s",
                    account,
                )
        connection.commit()
    finally:
        connection.close()
    print("容器 MySQL 已完成幂等初始化（未输出任何凭据）")


def main() -> None:
    bootstrap()


if __name__ == "__main__":
    main()
