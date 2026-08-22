"""Behavior checks for the Feishu long-connection callback gateway."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from lark_oapi.event.callback.model.p2_card_action_trigger import P2CardActionTrigger


LAUNCHER_DIR = Path(__file__).parents[1] / "飞书长连接启动"
sys.path.insert(0, str(LAUNCHER_DIR))


def complete_event(*, user_id="user-42", open_id="open-42", form_value=None):
    """Build the same complete shape the SDK supplies to callback handlers."""
    return P2CardActionTrigger({
        "schema": "2.0",
        "header": {"event_type": "card.action.trigger", "token": "callback-token"},
        "event": {
            "operator": {
                "tenant_key": "tenant-1", "user_id": user_id, "open_id": open_id,
                "union_id": "union-42",
            },
            "token": "event-token",
            "action": {
                "tag": "button",
                "name": "validation_form",
                "value": {"action": "submit_validation", "anomaly_id": "anomaly-9"},
                "form_value": form_value or {"validation_form": {"validation_text": "  looks good  "}},
                "input_value": None,
                "options": None,
                "checked": None,
                "option": None,
                "timezone": None,
            },
            "host": "im_message",
            "delivery_type": "card",
            "context": {
                "url": None, "preview_token": None, "open_message_id": "om_987",
                "open_chat_id": "oc_987",
            },
        },
    })


class FakeResponse:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body

    def json(self):
        return self._body


class RecordingPost:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    def __call__(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if self.error:
            raise self.error
        return self.response


def configured_gateway(post):
    gateway = importlib.import_module("feishu_callback_gateway")
    settings = gateway.GatewaySettings(
        api_base_url="http://sentinel.test/", internal_token="internal-token",
    )
    return gateway.CardActionGateway(settings, post=post)


def test_callback_normalizes_sdk_event_posts_internal_contract_and_maps_sdk_response():
    post = RecordingPost(FakeResponse(200, {
        "toast": {"type": "success", "content": "验证已提交"},
        "card": {"schema": "2.0", "header": {"template": "green"}, "body": {"elements": []}},
    }))

    response = configured_gateway(post).handle(complete_event())

    assert post.calls == [(
        "http://sentinel.test/api/internal/feishu/card-actions",
        {
            "headers": {"X-Internal-Token": "internal-token"},
            "json": {
                "anomaly_id": "anomaly-9", "operator_user_id": "user-42",
                "message_id": "om_987", "action": "submit_validation",
                "validation_text": "looks good",
            },
            "timeout": 10.0,
        },
    )]
    assert response.toast.type == "success"
    assert response.toast.content == "验证已提交"
    assert response.card.type == "raw"
    assert response.card.data["header"]["template"] == "green"


def test_callback_uses_open_id_and_direct_form_value_when_user_id_is_unavailable():
    post = RecordingPost(FakeResponse(200, {
        "toast": {"type": "warning", "content": "已处理"},
        "card": {"schema": "2.0", "header": {"template": "orange"}, "body": {"elements": []}},
    }))

    response = configured_gateway(post).handle(complete_event(
        user_id=None,
        form_value={"validation_text": "  direct input  "},
    ))

    assert post.calls[0][1]["json"]["operator_user_id"] == "open-42"
    assert post.calls[0][1]["json"]["validation_text"] == "direct input"
    assert response.toast.type == "warning"


def test_callback_forwards_an_empty_validation_text_for_the_internal_api_to_explain():
    post = RecordingPost(FakeResponse(200, {
        "toast": {"type": "error", "content": "验证说明长度必须为 1-1000 个字符"},
        "card": {"schema": "2.0", "header": {"template": "orange"}, "body": {"elements": []}},
    }))

    response = configured_gateway(post).handle(complete_event(
        form_value={"validation_form": {"validation_text": "  "}},
    ))

    assert post.calls[0][1]["json"]["validation_text"] == ""
    assert response.toast.content == "验证说明长度必须为 1-1000 个字符"


@pytest.mark.parametrize("post", [
    RecordingPost(FakeResponse(401, {"detail": "unauthorized"})),
    RecordingPost(FakeResponse(404, {
        "toast": {"type": "success", "content": "must not reach Feishu"},
        "card": {"schema": "2.0", "header": {"template": "green"}, "body": {"elements": []}},
    })),
    RecordingPost(FakeResponse(500, {"detail": "backend error"})),
    RecordingPost(FakeResponse(200, {"toast": {"type": "success"}})),
    RecordingPost(error=OSError("connection refused")),
])
def test_callback_failures_return_generic_error_response_without_breaking_future_events(post):
    gateway = configured_gateway(post)

    first = gateway.handle(complete_event())
    second = gateway.handle(complete_event())

    for response in (first, second):
        assert response.toast.type == "error"
        assert response.toast.content == "处理验证请求失败，请稍后重试"
        assert response.card.type == "raw"
        assert response.card.data["header"]["template"] == "red"


def test_launcher_fails_before_connecting_when_callback_gateway_settings_are_missing(monkeypatch):
    launcher = importlib.import_module("飞书长连接启动")
    monkeypatch.delenv("SENTINEL_API_BASE_URL", raising=False)
    monkeypatch.setenv("FEISHU_APP_ID", "app-id")
    monkeypatch.setenv("FEISHU_APP_SECRET", "app-secret")
    monkeypatch.setenv("INTERNAL_EXECUTION_TOKEN", "internal-token")

    with pytest.raises(RuntimeError, match="SENTINEL_API_BASE_URL"):
        launcher.main()


def test_launcher_registers_callback_handler_before_starting_websocket(monkeypatch):
    launcher = importlib.import_module("飞书长连接启动")
    registered = []
    started = []

    class Builder:
        def register_p2_card_action_trigger(self, callback):
            registered.append(callback)
            return self

        def build(self):
            return "event-handler"

    class WebSocketClient:
        def __init__(self, app_id, app_secret, *, event_handler, log_level):
            assert (app_id, app_secret, event_handler, log_level) == (
                "app-id", "app-secret", "event-handler", "INFO",
            )

        def start(self):
            started.append(True)

    class Gateway:
        def __init__(self, settings):
            assert settings == "gateway-settings"

        def handle(self, _event):
            return "response"

    fake_lark = SimpleNamespace(
        EventDispatcherHandler=SimpleNamespace(builder=lambda *_args: Builder()),
        ws=SimpleNamespace(Client=WebSocketClient),
        LogLevel=SimpleNamespace(INFO="INFO"),
    )
    monkeypatch.setattr(launcher, "lark", fake_lark)
    monkeypatch.setattr(launcher, "CardActionGateway", Gateway)
    monkeypatch.setattr(
        launcher.GatewaySettings,
        "from_environment",
        classmethod(lambda _cls, _required_env: "gateway-settings"),
    )
    monkeypatch.setenv("FEISHU_APP_ID", "app-id")
    monkeypatch.setenv("FEISHU_APP_SECRET", "app-secret")

    launcher.main()

    assert len(registered) == 1
    assert registered[0].__self__.__class__ is Gateway
    assert started == [True]
