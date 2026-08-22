"""Start a Feishu event long connection via the Lark SDK."""

import os

import lark_oapi as lark

from feishu_callback_gateway import CardActionGateway, GatewaySettings


def get_required_env(name: str) -> str:
    """Return a required environment variable with an actionable error."""
    value = os.getenv(name)
    if not value or not value.strip():
        raise RuntimeError(f"Missing environment variable {name}. Set it before running this script.")
    return value.strip()


def main() -> None:
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
