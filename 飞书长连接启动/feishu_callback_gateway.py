"""Translate Feishu card callbacks into Sentinel's internal callback API."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

import httpx
from lark_oapi.event.callback.model.p2_card_action_trigger import (
    P2CardActionTrigger,
    P2CardActionTriggerResponse,
)


ERROR_TOAST = "处理验证请求失败，请稍后重试"
SUPPORTED_TOAST_TYPES = frozenset({"success", "info", "warning", "error"})


class CallbackPayloadError(ValueError):
    """The callback cannot be mapped to the internal API contract."""


@dataclass(frozen=True)
class GatewaySettings:
    api_base_url: str
    internal_token: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "api_base_url", self.api_base_url.rstrip("/"))

    @classmethod
    def from_environment(cls, required_env: Callable[[str], str]) -> "GatewaySettings":
        return cls(
            api_base_url=required_env("SENTINEL_API_BASE_URL"),
            internal_token=required_env("INTERNAL_EXECUTION_TOKEN"),
        )


def _required_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CallbackPayloadError(f"missing {field}")
    return value.strip()


def _form_text(value: object) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise CallbackPayloadError("action.form_value.validation_text is not text")
    return value.strip()


def _mapping(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CallbackPayloadError("callback field is not an object")
    return value


def normalize_card_action(event: P2CardActionTrigger) -> dict[str, str]:
    """Map the SDK callback object to the exact Task 3 request payload."""
    data = event.event
    if data is None or data.operator is None or data.context is None or data.action is None:
        raise CallbackPayloadError("incomplete callback event")

    operator_user_id = data.operator.user_id or data.operator.open_id
    action_value = _mapping(data.action.value)
    form_value = _mapping(data.action.form_value)
    action_name = data.action.name
    validation_text = form_value.get("validation_text")
    if validation_text is None and isinstance(action_name, str):
        named_form = form_value.get(action_name)
        if isinstance(named_form, dict):
            validation_text = named_form.get("validation_text")
    if validation_text is None:
        default_form = form_value.get("validation_form")
        if isinstance(default_form, dict):
            validation_text = default_form.get("validation_text")

    return {
        "anomaly_id": _required_text(action_value.get("anomaly_id"), "action.value.anomaly_id"),
        "operator_user_id": _required_text(operator_user_id, "event.operator user id"),
        "message_id": _required_text(data.context.open_message_id, "event.context.open_message_id"),
        "action": _required_text(action_value.get("action") or action_name, "action.name/value"),
        "validation_text": _form_text(validation_text),
    }


def _error_response() -> P2CardActionTriggerResponse:
    return P2CardActionTriggerResponse({
        "toast": {"type": "error", "content": ERROR_TOAST},
        "card": {
            "type": "raw",
            "data": {
                "schema": "2.0",
                "config": {"update_multi": True},
                "header": {
                    "title": {"tag": "plain_text", "content": "验证请求失败"},
                    "template": "red",
                },
                "body": {"elements": [{"tag": "markdown", "content": "请稍后重试。"}]},
            },
        },
    })


def _map_api_response(payload: object) -> P2CardActionTriggerResponse:
    response = _mapping(payload)
    toast = _mapping(response.get("toast"))
    card = _mapping(response.get("card"))
    toast_type = _required_text(toast.get("type"), "toast.type")
    toast_content = _required_text(toast.get("content"), "toast.content")
    if toast_type not in SUPPORTED_TOAST_TYPES:
        raise CallbackPayloadError("unsupported toast.type")
    _validate_raw_card(card)
    return P2CardActionTriggerResponse({
        "toast": {"type": toast_type, "content": toast_content},
        "card": {"type": "raw", "data": card},
    })


def _validate_raw_card(card: dict[str, Any]) -> None:
    if card.get("schema") != "2.0":
        raise CallbackPayloadError("unsupported card schema")
    header = _mapping(card.get("header"))
    title = _mapping(header.get("title"))
    if title.get("tag") != "plain_text":
        raise CallbackPayloadError("unsupported card title")
    _required_text(title.get("content"), "card.header.title.content")
    _required_text(header.get("template"), "card.header.template")
    body = _mapping(card.get("body"))
    elements = body.get("elements")
    if not isinstance(elements, list) or not elements or not all(isinstance(item, dict) for item in elements):
        raise CallbackPayloadError("invalid card body elements")


class CardActionGateway:
    """Handle one card action without allowing transport failures to escape."""

    def __init__(self, settings: GatewaySettings, *, client_factory: Callable[..., httpx.Client] = httpx.Client):
        self._settings = settings
        self._client = client_factory(timeout=10.0)

    def close(self) -> None:
        self._client.close()

    def handle(self, event: P2CardActionTrigger) -> P2CardActionTriggerResponse:
        try:
            payload = normalize_card_action(event)
            response = self._client.post(
                f"{self._settings.api_base_url}/api/internal/feishu/card-actions",
                headers={"X-Internal-Token": self._settings.internal_token},
                json=payload,
            )
            if not 200 <= response.status_code < 300:
                return _error_response()
            return _map_api_response(response.json())
        except Exception:
            return _error_response()
