from functools import lru_cache
from pathlib import Path

from cryptography.fernet import Fernet
from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


PROJECT_ROOT = Path(__file__).resolve().parents[2]
SESSION_COOKIE = "sentinel_session"


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
        validation_alias=AliasChoices("INTERNAL_EXECUTION_TOKEN", "SENTINEL_INTERNAL_TOKEN"),
    )
    feishu_app_id: str = ""
    feishu_app_secret: str = ""
    sentinel_public_base_url: str = "http://localhost:8000"
    sentinel_api_base_url: str = "http://127.0.0.1:8000"
    validation_timeout_scan_interval_seconds: int = Field(default=60, ge=1)
    validation_maintenance_batch_size: int = Field(default=50, ge=1, le=500)
    feishu_http_timeout_seconds: float = Field(default=10, ge=1, le=60)
    dolphinscheduler_url: str = "http://localhost:12345/dolphinscheduler"
    dolphinscheduler_username: str = "admin"
    dolphinscheduler_password: str = "dolphinscheduler123"
    dolphinscheduler_tenant: str = "default"
    dolphinscheduler_project: str = "sentinel-mvp"
    timezone: str = "Asia/Shanghai"
    reconcile_on_startup: bool = True


@lru_cache
def get_settings() -> Settings:
    return Settings()
