"""Behavior checks for the Feishu long-connection callback gateway."""

from __future__ import annotations

import importlib
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import httpx
import lark_oapi as lark
import pytest
from lark_oapi.event.callback.model.p2_card_action_trigger import P2CardActionTrigger


LAUNCHER_DIR = Path(__file__).parents[1] / "飞书长连接启动"
BACKEND_DIR = Path(__file__).parents[1] / "backend"
sys.path.insert(0, str(LAUNCHER_DIR))
sys.path.insert(0, str(BACKEND_DIR))

VALID_CARD = {
    "schema": "2.0",
    "header": {
        "title": {"tag": "plain_text", "content": "异常实时验证 · 已解决"},
        "template": "green",
    },
    "body": {"elements": [{"tag": "markdown", "content": "验证已提交"}]},
}


@pytest.fixture(autouse=True)
def restore_internal_token_environment():
    names = ("SENTINEL_INTERNAL_TOKEN", "INTERNAL_EXECUTION_TOKEN")
    original = {name: os.environ.get(name) for name in names}
    yield
    for name, value in original.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value


def complete_event(
    *, user_id="user-42", open_id="open-42", form_value=None,
    action_name="validation_form", action_value=None,
):
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
                "name": action_name,
                "value": action_value or {"action": "submit_validation", "anomaly_id": "anomaly-9"},
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


class PostClient:
    def __init__(self, post, **_kwargs):
        self._post = post

    def post(self, url, **kwargs):
        return self._post(url, **kwargs)

    def close(self):
        return None


def configured_gateway(post):
    gateway = importlib.import_module("feishu_callback_gateway")
    settings = gateway.GatewaySettings(
        api_base_url="http://sentinel.test/", internal_token="internal-token",
    )
    return gateway.CardActionGateway(settings, client_factory=lambda **kwargs: PostClient(post, **kwargs))


def configured_settings():
    gateway = importlib.import_module("feishu_callback_gateway")
    return gateway.GatewaySettings(
        api_base_url="http://sentinel.test/", internal_token="internal-token",
    )


@pytest.mark.parametrize(
    ("values", "expected"),
    [
        ({"SENTINEL_INTERNAL_TOKEN": "canonical"}, "canonical"),
        ({"INTERNAL_EXECUTION_TOKEN": "legacy"}, "legacy"),
        ({
            "SENTINEL_INTERNAL_TOKEN": "shared",
            "INTERNAL_EXECUTION_TOKEN": "shared",
        }, "shared"),
    ],
)
def test_gateway_settings_accept_canonical_or_legacy_internal_token(values, expected):
    gateway = importlib.import_module("feishu_callback_gateway")
    values = {"SENTINEL_API_BASE_URL": "http://sentinel.test", **values}

    def required(name):
        if not values.get(name):
            raise RuntimeError(f"missing {name}")
        return values[name]

    assert gateway.GatewaySettings.from_environment(required).internal_token == expected


def test_gateway_settings_reject_conflicting_tokens_without_disclosing_values():
    gateway = importlib.import_module("feishu_callback_gateway")
    values = {
        "SENTINEL_API_BASE_URL": "http://sentinel.test",
        "SENTINEL_INTERNAL_TOKEN": "canonical-gateway-secret",
        "INTERNAL_EXECUTION_TOKEN": "legacy-gateway-secret",
    }

    with pytest.raises(RuntimeError) as conflict:
        gateway.GatewaySettings.from_environment(lambda name: values[name])

    assert "SENTINEL_INTERNAL_TOKEN" in str(conflict.value)
    assert "INTERNAL_EXECUTION_TOKEN" in str(conflict.value)
    assert "canonical-gateway-secret" not in str(conflict.value)
    assert "legacy-gateway-secret" not in str(conflict.value)


def response_client_factory(status_code, body, requests, clients):
    def factory(**kwargs):
        def respond(request):
            requests.append(request)
            return httpx.Response(status_code, json=body)

        client = httpx.Client(transport=httpx.MockTransport(respond), **kwargs)
        clients.append(client)
        return client

    return factory


def test_callback_normalizes_sdk_event_posts_internal_contract_and_maps_sdk_response():
    post = RecordingPost(FakeResponse(200, {
        "toast": {"type": "success", "content": "验证已提交"},
        "card": VALID_CARD,
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
        },
    )]
    assert response.toast.type == "success"
    assert response.toast.content == "验证已提交"
    assert response.card.type == "raw"
    assert response.card.data["header"]["template"] == "green"


def test_production_card_button_round_trips_official_flat_form_value_and_action_value():
    """The gateway must consume the callback shape generated by the actual Card JSON 2.0 card."""
    from app.models import AnomalyRecord
    from app.validation_service import build_validation_card

    anomaly = AnomalyRecord(
        id="anomaly-production-9", rule_id="rule-9", rule_name="Revenue rule",
        dataset_name="Finance mart", severity="high", status="pending",
        description="Revenue is outside the expected range", fingerprint="f" * 64,
        active_fingerprint="f" * 64, business_key={"id": 9}, row_details={"amount": 42},
        matched_conditions=[],
    )
    card = build_validation_card(anomaly, "https://sentinel.example")
    form = next(element for element in card["body"]["elements"] if element["tag"] == "form")
    input_element = next(element for element in form["elements"] if element["tag"] == "input")
    button = next(element for element in form["elements"] if element["tag"] == "button")
    callback = next(behavior for behavior in button["behaviors"] if behavior["type"] == "callback")
    post = RecordingPost(FakeResponse(200, {
        "toast": {"type": "success", "content": "验证已提交"},
        "card": VALID_CARD,
    }))

    configured_gateway(post).handle(complete_event(
        action_name=button["name"],
        action_value=callback["value"],
        form_value={input_element["name"]: "  production input  "},
    ))

    forwarded = post.calls[0][1]["json"]
    assert forwarded["anomaly_id"] == anomaly.id
    assert forwarded["action"] == "submit_validation"
    assert forwarded["validation_text"] == "production input"


def test_callback_uses_open_id_and_direct_form_value_when_user_id_is_unavailable():
    post = RecordingPost(FakeResponse(200, {
        "toast": {"type": "warning", "content": "已处理"},
        "card": {**VALID_CARD, "header": {**VALID_CARD["header"], "template": "orange"}},
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
        "card": {**VALID_CARD, "header": {**VALID_CARD["header"], "template": "orange"}},
    }))

    response = configured_gateway(post).handle(complete_event(
        form_value={"validation_form": {"validation_text": "  "}},
    ))

    assert post.calls[0][1]["json"]["validation_text"] == ""
    assert response.toast.content == "验证说明长度必须为 1-1000 个字符"


def test_callback_accepts_every_successful_2xx_response():
    post = RecordingPost(FakeResponse(201, {
        "toast": {"type": "success", "content": "验证已提交"},
        "card": VALID_CARD,
    }))

    response = configured_gateway(post).handle(complete_event())

    assert response.toast.type == "success"
    assert response.card.data == VALID_CARD


@pytest.mark.parametrize("post", [
    RecordingPost(FakeResponse(401, {"detail": "unauthorized"})),
    RecordingPost(FakeResponse(404, {
        "toast": {"type": "success", "content": "must not reach Feishu"},
        "card": VALID_CARD,
    })),
    RecordingPost(FakeResponse(500, {"detail": "backend error"})),
    RecordingPost(FakeResponse(200, {"toast": {"type": "success"}})),
    RecordingPost(FakeResponse(200, {"toast": {"type": "banana", "content": "bad type"}, "card": VALID_CARD})),
    RecordingPost(FakeResponse(200, {"toast": {"type": "success", "content": "bad card"}, "card": {}})),
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


def test_callback_exception_logs_only_structured_non_sensitive_metadata(caplog):
    post = RecordingPost(error=OSError(
        "connection refused internal-token anomaly-9 looks-good payload"
    ))
    caplog.set_level("WARNING", logger="feishu_callback_gateway")

    configured_gateway(post).handle(complete_event())

    records = [record for record in caplog.records if record.name == "feishu_callback_gateway"]
    assert len(records) == 1
    record = records[0]
    assert record.getMessage() == "feishu_card_callback_failed"
    assert record.event == "feishu_card_callback_failed"
    assert record.error_type == "OSError"
    assert record.exc_info is None
    serialized = " ".join(str(value) for value in record.__dict__.values())
    for secret in ("internal-token", "anomaly-9", "looks-good", "payload"):
        assert secret not in serialized


def test_gateway_reuses_one_owned_httpx_client_and_closes_it():
    requests = []
    clients = []
    factory = response_client_factory(200, {
        "toast": {"type": "success", "content": "验证已提交"}, "card": VALID_CARD,
    }, requests, clients)
    gateway_module = importlib.import_module("feishu_callback_gateway")

    callback_gateway = gateway_module.CardActionGateway(
        configured_settings(), client_factory=factory,
    )
    callback_gateway.handle(complete_event())
    callback_gateway.handle(complete_event())
    callback_gateway.close()

    assert len(clients) == 1
    assert len(requests) == 2
    assert clients[0].is_closed is True


def test_sdk_dispatcher_marshals_registered_card_callback_response():
    requests = []
    clients = []
    factory = response_client_factory(200, {
        "toast": {"type": "success", "content": "验证已提交"}, "card": VALID_CARD,
    }, requests, clients)
    gateway_module = importlib.import_module("feishu_callback_gateway")
    callback_gateway = gateway_module.CardActionGateway(
        configured_settings(), client_factory=factory,
    )
    handler = (
        lark.EventDispatcherHandler.builder("", "")
        .register_p2_card_action_trigger(callback_gateway.handle)
        .build()
    )
    request = lark.RawRequest()
    request.uri = "/callback"
    request.body = json.dumps({
        "schema": "2.0",
        "header": {"event_type": "card.action.trigger", "token": ""},
        "event": {
            "operator": {"tenant_key": "tenant-1", "user_id": "user-42", "open_id": "open-42", "union_id": "union-42"},
            "token": "event-token",
            "action": {"tag": "button", "name": "validation_form", "value": {"action": "submit_validation", "anomaly_id": "anomaly-9"}, "form_value": {"validation_form": {"validation_text": "looks good"}}},
            "host": "im_message",
            "delivery_type": "card",
            "context": {"open_message_id": "om_987", "open_chat_id": "oc_987"},
        },
    }).encode()

    response = handler.do(request)
    callback_gateway.close()

    assert response.status_code == 200
    assert json.loads(response.content) == {
        "toast": {"type": "success", "content": "验证已提交"},
        "card": {"type": "raw", "data": VALID_CARD},
    }


def test_launcher_fails_before_connecting_when_callback_gateway_settings_are_missing(monkeypatch):
    launcher = importlib.import_module("飞书长连接启动")
    monkeypatch.delenv("SENTINEL_API_BASE_URL", raising=False)
    monkeypatch.setenv("FEISHU_APP_ID", "app-id")
    monkeypatch.setenv("FEISHU_APP_SECRET", "app-secret")
    monkeypatch.setenv("INTERNAL_EXECUTION_TOKEN", "internal-token")

    with pytest.raises(RuntimeError, match="SENTINEL_API_BASE_URL"):
        launcher.main()


def test_launcher_starts_with_repository_env_as_its_only_configuration(tmp_path, monkeypatch):
    launcher = importlib.import_module("飞书长连接启动")
    env_file = tmp_path / ".env"
    env_file.write_text(
        "\n".join([
            "FEISHU_APP_ID=file-app-id",
            "FEISHU_APP_SECRET=file-app-secret",
            "SENTINEL_API_BASE_URL=http://api.from.file:8000",
            "SENTINEL_INTERNAL_TOKEN=file-internal-token",
        ]) + "\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(launcher, "ENV_FILE", env_file, raising=False)
    for name in (
        "FEISHU_APP_ID", "FEISHU_APP_SECRET", "SENTINEL_API_BASE_URL",
        "SENTINEL_INTERNAL_TOKEN", "INTERNAL_EXECUTION_TOKEN",
    ):
        monkeypatch.delenv(name, raising=False)
    observed = {}

    class Builder:
        def register_p2_card_action_trigger(self, callback):
            observed["callback"] = callback
            return self

        def build(self):
            return "handler"

    class WebSocketClient:
        def __init__(self, app_id, app_secret, *, event_handler, log_level):
            observed["websocket"] = (app_id, app_secret, event_handler, log_level)

        def start(self):
            observed["started"] = True

    class Gateway:
        def __init__(self, settings):
            observed["settings"] = settings

        def handle(self, _event):
            return None

        def close(self):
            observed["closed"] = True

    monkeypatch.setattr(launcher, "CardActionGateway", Gateway)
    monkeypatch.setattr(launcher, "lark", SimpleNamespace(
        EventDispatcherHandler=SimpleNamespace(builder=lambda *_args: Builder()),
        ws=SimpleNamespace(Client=WebSocketClient),
        LogLevel=SimpleNamespace(INFO="INFO"),
    ))

    launcher.main()

    assert observed["websocket"] == ("file-app-id", "file-app-secret", "handler", "INFO")
    assert observed["settings"].api_base_url == "http://api.from.file:8000"
    assert observed["settings"].internal_token == "file-internal-token"
    assert observed["started"] is True
    assert observed["closed"] is True


def test_repository_env_loader_preserves_explicit_process_values(tmp_path, monkeypatch):
    launcher = importlib.import_module("飞书长连接启动")
    env_file = tmp_path / ".env"
    env_file.write_text("FEISHU_APP_ID=file-app-id\n", encoding="utf-8")
    monkeypatch.setattr(launcher, "ENV_FILE", env_file, raising=False)
    monkeypatch.setenv("FEISHU_APP_ID", "explicit-app-id")

    launcher.load_repository_env()

    assert launcher.get_required_env("FEISHU_APP_ID") == "explicit-app-id"


@pytest.mark.parametrize(
    ("process_name", "file_name"),
    [
        ("SENTINEL_INTERNAL_TOKEN", "INTERNAL_EXECUTION_TOKEN"),
        ("INTERNAL_EXECUTION_TOKEN", "SENTINEL_INTERNAL_TOKEN"),
    ],
)
def test_repository_env_loader_gives_explicit_token_alias_precedence(
    tmp_path, monkeypatch, process_name, file_name,
):
    launcher = importlib.import_module("飞书长连接启动")
    env_file = tmp_path / ".env"
    env_file.write_text(f"{file_name}=file-token\n", encoding="utf-8")
    monkeypatch.setattr(launcher, "ENV_FILE", env_file, raising=False)
    monkeypatch.delenv("SENTINEL_INTERNAL_TOKEN", raising=False)
    monkeypatch.delenv("INTERNAL_EXECUTION_TOKEN", raising=False)
    monkeypatch.setenv(process_name, "process-token")

    launcher.load_repository_env()

    assert launcher.get_required_env("SENTINEL_INTERNAL_TOKEN") == "process-token"
    assert "INTERNAL_EXECUTION_TOKEN" not in launcher.os.environ


def test_repository_env_loader_rejects_conflicting_file_tokens_without_values(
    tmp_path, monkeypatch,
):
    launcher = importlib.import_module("飞书长连接启动")
    env_file = tmp_path / ".env"
    env_file.write_text(
        "SENTINEL_INTERNAL_TOKEN=canonical-file-secret\n"
        "INTERNAL_EXECUTION_TOKEN=legacy-file-secret\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(launcher, "ENV_FILE", env_file, raising=False)
    monkeypatch.delenv("SENTINEL_INTERNAL_TOKEN", raising=False)
    monkeypatch.delenv("INTERNAL_EXECUTION_TOKEN", raising=False)

    with pytest.raises(RuntimeError) as conflict:
        launcher.load_repository_env()

    assert "canonical-file-secret" not in str(conflict.value)
    assert "legacy-file-secret" not in str(conflict.value)


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

        def close(self):
            closed.append(True)

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

    closed = []
    launcher.main()

    assert len(registered) == 1
    assert registered[0].__self__.__class__ is Gateway
    assert started == [True]
    assert closed == [True]
