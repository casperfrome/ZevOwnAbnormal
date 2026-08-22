from functools import lru_cache
from pathlib import Path

from cryptography.fernet import Fernet
from pydantic_settings import BaseSettings, SettingsConfigDict


PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=PROJECT_ROOT / ".env", extra="ignore")

    database_url: str = "mysql+pymysql://app:dev_app_password@127.0.0.1:3306/app?charset=utf8mb4"
    datasource_encryption_key: str = Fernet.generate_key().decode("ascii")
    session_secret: str = "change-this-local-session-secret"
    auto_login: bool = True
    superadmin_username: str = "admin"
    superadmin_password: str = "Admin@123456"
    internal_execution_token: str = "change-this-internal-token"
    feishu_app_id: str = ""
    feishu_app_secret: str = ""
    sentinel_public_base_url: str = "http://localhost:8000"
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
