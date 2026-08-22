from __future__ import annotations

import re
import secrets
from pathlib import Path

from cryptography.fernet import Fernet


ROOT = Path(__file__).resolve().parents[2]
CREDENTIAL_FILE = Path(r"D:\飞书里尔机器人凭证.txt")
ENV_FILE = ROOT / ".env"


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
    values = {
        "DATABASE_URL": "mysql+pymysql://app:dev_app_password@127.0.0.1:3306/app?charset=utf8mb4",
        "DATASOURCE_ENCRYPTION_KEY": Fernet.generate_key().decode("ascii"),
        "SESSION_SECRET": secrets.token_urlsafe(48),
        "INTERNAL_EXECUTION_TOKEN": internal_token,
        "SENTINEL_INTERNAL_TOKEN": internal_token,
        "AUTO_LOGIN": "false",
        "SUPERADMIN_USERNAME": "admin",
        "SUPERADMIN_PASSWORD": "Admin@123456",
        "FEISHU_APP_ID": app_id,
        "FEISHU_APP_SECRET": app_secret,
        "SENTINEL_PUBLIC_BASE_URL": "http://localhost:8000",
        "SENTINEL_API_BASE_URL": "http://127.0.0.1:8000",
        "VALIDATION_TIMEOUT_SCAN_INTERVAL_SECONDS": "60",
        "VALIDATION_MAINTENANCE_BATCH_SIZE": "50",
        "FEISHU_HTTP_TIMEOUT_SECONDS": "10",
        "DOLPHINSCHEDULER_URL": "http://localhost:12345/dolphinscheduler",
        "DOLPHINSCHEDULER_USERNAME": "admin",
        "DOLPHINSCHEDULER_PASSWORD": "dolphinscheduler123",
        "DOLPHINSCHEDULER_TENANT": "default",
        "DOLPHINSCHEDULER_PROJECT": "sentinel-mvp",
        "TIMEZONE": "Asia/Shanghai",
    }
    ENV_FILE.write_text("\n".join(f"{key}={value}" for key, value in values.items()) + "\n", encoding="utf-8")
    print(f"已安全生成 {ENV_FILE}（密钥内容未输出）")


if __name__ == "__main__":
    main()
