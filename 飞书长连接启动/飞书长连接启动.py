"""Start a Feishu event long connection via the Lark SDK."""

import os

import lark_oapi as lark


def get_required_env(name: str) -> str:
    """Return a required environment variable with an actionable error."""
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing environment variable {name}. Set it before running this script.")
    return value


def main() -> None:
    app_id = get_required_env("FEISHU_APP_ID")
    app_secret = get_required_env("FEISHU_APP_SECRET")

    event_handler = lark.EventDispatcherHandler.builder("", "").build()
    client = lark.ws.Client(
        app_id,
        app_secret,
        event_handler=event_handler,
        log_level=lark.LogLevel.INFO,
    )

    print("Establishing Feishu long connection. Press Ctrl+C to stop.")
    client.start()


if __name__ == "__main__":
    main()
