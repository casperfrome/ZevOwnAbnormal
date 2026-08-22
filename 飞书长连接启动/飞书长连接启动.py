"""Start a Feishu event long connection via the Lark SDK."""

import os
from pathlib import Path

import lark_oapi as lark
from dotenv import load_dotenv

from feishu_callback_gateway import (
    CardActionGateway,
    GatewaySettings,
    resolve_internal_token,
)


ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


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
        if value and not value.strip():
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


def main() -> None:
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

    print("Establishing Feishu long connection. Press Ctrl+C to stop.")
    try:
        client.start()
    finally:
        callback_gateway.close()


if __name__ == "__main__":
    main()
