from __future__ import annotations

import re
import secrets
from pathlib import Path

from cryptography.fernet import Fernet
from dotenv import dotenv_values


ROOT = Path(__file__).resolve().parents[2]
CREDENTIAL_FILE = Path(r"D:\飞书里尔机器人凭证.txt")
ENV_FILE = ROOT / ".env"

PRESERVED_EXISTING_KEYS = {
    "MYSQL_HOST",
    "MYSQL_PORT",
    "MYSQL_ROOT_USER",
    "MYSQL_ROOT_PASSWORD",
    "MYSQL_DATABASE",
    "MYSQL_USER",
    "MYSQL_PASSWORD",
    "STARROCKS_HOST",
    "STARROCKS_SQL_PORT",
    "STARROCKS_USER",
    "STARROCKS_PASSWORD",
    "DATABASE_URL",
    "SENTINEL_DOCKER_API_BASE_URL",
    "DATASOURCE_ENCRYPTION_KEY",
    "SESSION_SECRET",
    "SENTINEL_INTERNAL_TOKEN",
    "INTERNAL_EXECUTION_TOKEN",
}


def parse_credentials(text: str) -> tuple[str, str]:
    app_id = re.search(r"App\s*ID\s*[:=]\s*(\S+)", text, re.IGNORECASE)
    app_secret = re.search(r"App\s*Secret\s*[:=]\s*(\S+)", text, re.IGNORECASE)
    if not app_id or not app_secret:
        raise RuntimeError("凭证文件缺少 App ID 或 App Secret")
    def clean(value: str) -> str:
        return value.strip().strip(",").strip('"\'')

    return clean(app_id.group(1)), clean(app_secret.group(1))


def main():
    app_id, app_secret = parse_credentials(CREDENTIAL_FILE.read_text(encoding="utf-8"))
    internal_token = secrets.token_urlsafe(48)
    existing = dotenv_values(ENV_FILE) if ENV_FILE.exists() else {}
    values = {
        "MYSQL_HOST": "127.0.0.1",
        "MYSQL_PORT": "3306",
        "MYSQL_ROOT_USER": "root",
        "MYSQL_ROOT_PASSWORD": "",
        "MYSQL_DATABASE": "zev_abnormal_app",
        "MYSQL_USER": "sentinel_app",
        "MYSQL_PASSWORD": "dev_app_password",
        "STARROCKS_HOST": "127.0.0.1",
        "STARROCKS_SQL_PORT": "9030",
        "STARROCKS_USER": "root",
        "STARROCKS_PASSWORD": "",
        "DATABASE_URL": "mysql+pymysql://sentinel_app:dev_app_password@127.0.0.1:3306/zev_abnormal_app?charset=utf8mb4",
        "DATASOURCE_ENCRYPTION_KEY": Fernet.generate_key().decode("ascii"),
        "SESSION_SECRET": secrets.token_urlsafe(48),
        "SENTINEL_INTERNAL_TOKEN": internal_token,
        "INTERNAL_EXECUTION_TOKEN": internal_token,
        "AUTO_LOGIN": "false",
        "SUPERADMIN_USERNAME": "admin",
        "SUPERADMIN_PASSWORD": "Admin@123456",
        "FEISHU_APP_ID": app_id,
        "FEISHU_APP_SECRET": app_secret,
        "SENTINEL_PUBLIC_BASE_URL": "http://localhost:8000",
        "SENTINEL_API_BASE_URL": "http://127.0.0.1:8000",
        "SENTINEL_DOCKER_API_BASE_URL": "http://host.docker.internal:8000",
        "VALIDATION_TIMEOUT_SCAN_INTERVAL_SECONDS": "60",
        "VALIDATION_MAINTENANCE_BATCH_SIZE": "50",
        "FEISHU_HTTP_TIMEOUT_SECONDS": "10",
        "KAFKA_BOOTSTRAP_SERVERS": "localhost:9092",
        "KAFKA_ANOMALY_PUSH_TOPIC": "sentinel-anomaly-push",
        "KAFKA_ANOMALY_PUSH_GROUP": "sentinel-anomaly-push-dispatcher",
        "DOLPHINSCHEDULER_URL": "http://localhost:12345/dolphinscheduler",
        "DOLPHINSCHEDULER_USERNAME": "admin",
        "DOLPHINSCHEDULER_PASSWORD": "dolphinscheduler123",
        "DOLPHINSCHEDULER_TENANT": "default",
        "DOLPHINSCHEDULER_PROJECT": "sentinel-mvp",
        "TIMEZONE": "Asia/Shanghai",
    }
    values.update({
        key: str(existing[key])
        for key in PRESERVED_EXISTING_KEYS
        if existing.get(key) is not None
    })
    ENV_FILE.write_text("\n".join(f"{key}={value}" for key, value in values.items()) + "\n", encoding="utf-8")
    print(f"已安全生成 {ENV_FILE}（密钥内容未输出）")


if __name__ == "__main__":
    main()
