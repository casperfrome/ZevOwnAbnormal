from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
from typing import Mapping

from dotenv import dotenv_values


ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = ROOT / ".env"


@dataclass(frozen=True)
class MySQLSettings:
    host: str
    port: int
    admin_user: str
    admin_password: str
    database: str
    app_user: str
    app_password: str


@dataclass(frozen=True)
class StarRocksSettings:
    host: str
    port: int
    user: str
    password: str


@dataclass(frozen=True)
class LocalInfrastructureSettings:
    mysql: MySQLSettings
    starrocks: StarRocksSettings


def load_local_infrastructure_settings(
    env_file: Path = ENV_FILE,
    environ: Mapping[str, str] | None = None,
) -> LocalInfrastructureSettings:
    values = {
        key: value
        for key, value in dotenv_values(env_file).items()
        if value is not None
    }
    values.update(os.environ if environ is None else environ)

    def value(name: str, default: str) -> str:
        configured = values.get(name)
        return str(configured) if configured is not None else default

    return LocalInfrastructureSettings(
        mysql=MySQLSettings(
            host=value("MYSQL_HOST", "127.0.0.1"),
            port=int(value("MYSQL_PORT", "3306")),
            admin_user=value("MYSQL_ROOT_USER", "root"),
            admin_password=value("MYSQL_ROOT_PASSWORD", ""),
            database=value("MYSQL_DATABASE", "zev_abnormal_app"),
            app_user=value("MYSQL_USER", "sentinel_app"),
            app_password=value("MYSQL_PASSWORD", "dev_app_password"),
        ),
        starrocks=StarRocksSettings(
            host=value("STARROCKS_HOST", "127.0.0.1"),
            port=int(value("STARROCKS_SQL_PORT", "9030")),
            user=value("STARROCKS_USER", "root"),
            password=value("STARROCKS_PASSWORD", ""),
        ),
    )
