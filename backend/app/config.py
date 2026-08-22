from functools import lru_cache
import os
from pathlib import Path
from typing import Mapping

from cryptography.fernet import Fernet
from dotenv import dotenv_values
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


PROJECT_ROOT = Path(__file__).resolve().parents[2]
SESSION_COOKIE = "sentinel_session"


def _resolve_internal_token(values: Mapping[str, object]) -> str | None:
    canonical = values.get("SENTINEL_INTERNAL_TOKEN")
    legacy = values.get("INTERNAL_EXECUTION_TOKEN")
    canonical_value = canonical.strip() if isinstance(canonical, str) else ""
    legacy_value = legacy.strip() if isinstance(legacy, str) else ""
    if canonical_value and legacy_value and canonical_value != legacy_value:
        raise ValueError(
            "SENTINEL_INTERNAL_TOKEN 与 INTERNAL_EXECUTION_TOKEN 配置冲突"
        )
    return canonical_value or legacy_value or None


def _dotenv_internal_token(env_file: object) -> str | None:
    if env_file is None:
        return None
    env_files = env_file if isinstance(env_file, (list, tuple)) else [env_file]
    merged: dict[str, object] = {}
    for path in env_files:
        if path is not None and Path(path).is_file():
            merged.update(dotenv_values(path))
    return _resolve_internal_token(merged)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        extra="ignore",
        populate_by_name=True,
    )

    database_url: str = "mysql+pymysql://app:dev_app_password@127.0.0.1:3306/app?charset=utf8mb4"
    datasource_encryption_key: str = Fernet.generate_key().decode("ascii")
    session_secret: str = "change-this-local-session-secret"
    auto_login: bool = False
    superadmin_username: str = "admin"
    superadmin_password: str = "Admin@123456"
    internal_execution_token: str = Field(
        default="change-this-internal-token",
        validation_alias="__RESOLVED_SENTINEL_INTERNAL_TOKEN",
    )
    feishu_app_id: str = ""
    feishu_app_secret: str = ""
    sentinel_public_base_url: str = "http://localhost:8000"
    sentinel_api_base_url: str = "http://127.0.0.1:8000"
    validation_timeout_scan_interval_seconds: int = Field(default=60, ge=1)
    validation_maintenance_batch_size: int = Field(default=50, ge=1, le=500)
    feishu_http_timeout_seconds: float = Field(default=10, ge=1, le=60)
    kafka_bootstrap_servers: str = "localhost:9092"
    kafka_anomaly_push_topic: str = "sentinel-anomaly-push"
    kafka_anomaly_push_group: str = "sentinel-anomaly-push-dispatcher"
    dolphinscheduler_url: str = "http://localhost:12345/dolphinscheduler"
    dolphinscheduler_username: str = "admin"
    dolphinscheduler_password: str = "dolphinscheduler123"
    dolphinscheduler_tenant: str = "default"
    dolphinscheduler_project: str = "sentinel-mvp"
    timezone: str = "Asia/Shanghai"
    reconcile_on_startup: bool = True

    def __init__(self, **values):
        explicit_token = values.get("internal_execution_token")
        if isinstance(explicit_token, str):
            values["internal_execution_token"] = explicit_token.strip()
        if not values.get("internal_execution_token"):
            process_token = _resolve_internal_token(os.environ)
            token = process_token
            if token is None:
                token = _dotenv_internal_token(
                    values.get("_env_file", PROJECT_ROOT / ".env")
                )
            if token is not None:
                values["internal_execution_token"] = token
        super().__init__(**values)


@lru_cache
def get_settings() -> Settings:
    return Settings()
