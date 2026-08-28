"""Start a Feishu event long connection via the Lark SDK."""

import os
import argparse
import logging
import sys
from pathlib import Path

import lark_oapi as lark
from dotenv import dotenv_values, load_dotenv

from feishu_callback_gateway import (
    CardActionGateway,
    GatewaySettings,
    resolve_internal_token,
)


ENV_FILE = Path(__file__).resolve().parents[1] / ".env"
sys.path.insert(0, str(ENV_FILE.parent / 'backend'))
from scripts.runtime_support import FeishuLogFilter, ProcessLock, install_break_handler


def load_repository_env() -> None:
    """Load repository-local settings while preserving explicit process overrides."""
    explicit_canonical = os.getenv("SENTINEL_INTERNAL_TOKEN", "")
    explicit_legacy = os.getenv("INTERNAL_EXECUTION_TOKEN", "")
    explicit_token = None
    if explicit_canonical.strip() or explicit_legacy.strip():
        explicit_token = resolve_internal_token(explicit_canonical, explicit_legacy)
    for name, value in (
        ("SENTINEL_INTERNAL_TOKEN", explicit_canonical),
        ("INTERNAL_EXECUTION_TOKEN", explicit_legacy),
    ):
        if name in os.environ and not value.strip():
            os.environ.pop(name, None)
    load_dotenv(ENV_FILE, override=False)
    loaded_canonical = os.getenv("SENTINEL_INTERNAL_TOKEN", "")
    loaded_legacy = os.getenv("INTERNAL_EXECUTION_TOKEN", "")
    if explicit_token is not None:
        token = explicit_token
    elif loaded_canonical.strip() or loaded_legacy.strip():
        token = resolve_internal_token(loaded_canonical, loaded_legacy)
    else:
        return
    os.environ["SENTINEL_INTERNAL_TOKEN"] = token
    os.environ.pop("INTERNAL_EXECUTION_TOKEN", None)


def get_required_env(name: str) -> str:
    """Return a required environment variable with an actionable error."""
    value = os.getenv(name)
    if not value or not value.strip():
        raise RuntimeError(f"Missing environment variable {name}. Set it before running this script.")
    return value.strip()


def main() -> int:
    load_repository_env()
    app_id = get_required_env("FEISHU_APP_ID")
    app_secret = get_required_env("FEISHU_APP_SECRET")
    gateway_settings = GatewaySettings.from_environment(get_required_env)
    callback_gateway = CardActionGateway(gateway_settings)

    event_handler = (
        lark.EventDispatcherHandler.builder("", "")
        .register_p2_card_action_trigger(callback_gateway.handle)
        .build()
    )
    client = lark.ws.Client(
        app_id,
        app_secret,
        event_handler=event_handler,
        log_level=lark.LogLevel.INFO,
    )

    lock = ProcessLock(ENV_FILE.parent / 'tmp' / 'feishu.lock')
    if not lock.acquire():
        callback_gateway.close()
        print('飞书长连接已运行，跳过重复启动', flush=True)
        return 20
    log_filter = FeishuLogFilter()
    sdk_logger = logging.getLogger('Lark')
    sdk_logger.addFilter(log_filter)
    print("飞书正在连接，等待连接成功确认。按 Ctrl+C 停止。", flush=True)
    try:
        client.start()
    finally:
        callback_gateway.close()
        sdk_logger.removeFilter(log_filter)
        lock.close()
    return 0


def run_cli(*, optional: bool = False) -> int:
    install_break_handler()
    try:
        if optional:
            values = dotenv_values(ENV_FILE)
            credentials = [os.environ.get(name, values.get(name) or '').strip()
                           for name in ('FEISHU_APP_ID', 'FEISHU_APP_SECRET')]
            if not any(credentials):
                print('飞书未配置，跳过长连接；后端继续运行', flush=True)
                return 0
        return main()
    except KeyboardInterrupt:
        print('飞书长连接已停止', flush=True)
        return 0
    except Exception as exc:
        print(f'飞书启动或运行失败，请检查配置与网络；后端继续运行 error_type={type(exc).__name__}', flush=True)
        return 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--optional', action='store_true', help='Skip when Feishu credentials are absent')
    sys.exit(run_cli(optional=parser.parse_args().optional))
