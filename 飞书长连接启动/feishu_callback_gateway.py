"""Translate Feishu card callbacks into Sentinel's internal callback API."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable

import httpx
from lark_oapi.event.callback.model.p2_card_action_trigger import (
    P2CardActionTrigger,
    P2CardActionTriggerResponse,
)


ERROR_TOAST = "处理验证请求失败，请稍后重试"
SUPPORTED_TOAST_TYPES = frozenset({"success", "info", "warning", "error"})
logger = logging.getLogger(__name__)


class CallbackPayloadError(ValueError):
    """The callback cannot be mapped to the internal API contract."""


def resolve_internal_token(canonical: object, legacy: object) -> str:
    canonical_value = canonical.strip() if isinstance(canonical, str) else ""
    legacy_value = legacy.strip() if isinstance(legacy, str) else ""
    if canonical_value and legacy_value and canonical_value != legacy_value:
        raise RuntimeError(
            "SENTINEL_INTERNAL_TOKEN 与 INTERNAL_EXECUTION_TOKEN 配置冲突"
        )
    token = canonical_value or legacy_value
    if not token:
        raise RuntimeError("缺少必需环境变量: SENTINEL_INTERNAL_TOKEN")
    return token


@dataclass(frozen=True)
class GatewaySettings:
    api_base_url: str
    internal_token: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "api_base_url", self.api_base_url.rstrip("/"))

    @classmethod
    def from_environment(cls, required_env: Callable[[str], str]) -> "GatewaySettings":
        try:
            canonical = required_env("SENTINEL_INTERNAL_TOKEN")
        except RuntimeError:
            canonical = ""
        try:
            legacy = required_env("INTERNAL_EXECUTION_TOKEN")
        except RuntimeError:
            legacy = ""
        return cls(
            api_base_url=required_env("SENTINEL_API_BASE_URL"),
            internal_token=resolve_internal_token(canonical, legacy),
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
    form_value = {} if data.action.form_value is None else _mapping(data.action.form_value)
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


def _log_callback_failure(
    phase: str,
    error_type: str,
    *,
    http_status: int | None = None,
) -> None:
    metadata: dict[str, object] = {
        "event": "feishu_card_callback_failed",
        "phase": phase,
        "error_type": error_type,
    }
    if http_status is not None:
        metadata["http_status"] = http_status
    logger.warning("feishu_card_callback_failed", extra=metadata)


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
        except Exception as exc:
            _log_callback_failure("normalize", type(exc).__name__)
            return _error_response()

        try:
            response = self._client.post(
                f"{self._settings.api_base_url}/api/internal/feishu/card-actions",
                headers={"X-Internal-Token": self._settings.internal_token},
                json=payload,
            )
        except Exception as exc:
            _log_callback_failure("internal_api", type(exc).__name__)
            return _error_response()

        if not 200 <= response.status_code < 300:
            _log_callback_failure(
                "internal_api",
                "HTTPStatusError",
                http_status=response.status_code,
            )
            return _error_response()

        try:
            return _map_api_response(response.json())
        except Exception as exc:
            _log_callback_failure("response_mapping", type(exc).__name__)
            return _error_response()
