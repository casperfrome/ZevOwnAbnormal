import pytest
from fastapi.testclient import TestClient

from app.feishu import FeishuClient, FeishuError
from app.main import create_app


def test_feishu_message_test_sends_fixed_text_and_returns_message_id(monkeypatch):
    sent = []

    def fake_send_text(self, receive_id_type, recipient, text):
        sent.append((receive_id_type, recipient, text))
        return "om_test_123"

    monkeypatch.setattr(FeishuClient, "send_text", fake_send_text)
    app = create_app(testing=True)
    app.state.settings.feishu_app_id = "cli_app"
    app.state.settings.feishu_app_secret = "secret"

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/tests/feishu-message",
            json={"receive_id_type": "open_id", "receive_id": "  ou_user  "},
        )

    assert response.status_code == 200
    assert response.json() == {"ok": True, "message_id": "om_test_123"}
    assert sent == [("open_id", "ou_user", "【Sentinel 测试消息】飞书消息发送测试成功。")]


@pytest.mark.parametrize("receive_id_type", ["open_id", "union_id", "user_id", "email", "chat_id"])
def test_feishu_message_test_accepts_each_supported_receive_id_type(monkeypatch, receive_id_type):
    monkeypatch.setattr(FeishuClient, "send_text", lambda *_: "om_supported")
    app = create_app(testing=True)
    app.state.settings.feishu_app_id = "cli_app"
    app.state.settings.feishu_app_secret = "secret"

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/tests/feishu-message",
            json={"receive_id_type": receive_id_type, "receive_id": "target"},
        )

    assert response.status_code == 200


@pytest.mark.parametrize(
    "payload",
    [
        {"receive_id_type": "department_id", "receive_id": "target"},
        {"receive_id_type": "open_id", "receive_id": "   "},
    ],
)
def test_feishu_message_test_rejects_invalid_target(payload):
    with TestClient(create_app(testing=True)) as client:
        response = client.post("/api/v1/tests/feishu-message", json=payload)

    assert response.status_code == 422


def test_feishu_message_test_reports_missing_credentials():
    app = create_app(testing=True)
    app.state.settings.feishu_app_id = ""
    app.state.settings.feishu_app_secret = ""

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/tests/feishu-message",
            json={"receive_id_type": "open_id", "receive_id": "ou_user"},
        )

    assert response.status_code == 503
    assert response.json()["detail"] == "未配置飞书 App ID/App Secret"


def test_feishu_message_test_maps_feishu_failure_to_bad_gateway(monkeypatch):
    def fail_send(*_):
        raise FeishuError("发送飞书消息失败: recipient invalid")

    monkeypatch.setattr(FeishuClient, "send_text", fail_send)
    app = create_app(testing=True)
    app.state.settings.feishu_app_id = "cli_app"
    app.state.settings.feishu_app_secret = "secret"

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/tests/feishu-message",
            json={"receive_id_type": "open_id", "receive_id": "ou_invalid"},
        )

    assert response.status_code == 502
    assert "recipient invalid" in response.json()["detail"]


def test_feishu_message_test_trims_before_enforcing_maximum_length(monkeypatch):
    recipients = []

    def capture_recipient(self, receive_id_type, recipient, text):
        recipients.append(recipient)
        return "om_max_length"

    monkeypatch.setattr(FeishuClient, "send_text", capture_recipient)
    app = create_app(testing=True)
    app.state.settings.feishu_app_id = "cli_app"
    app.state.settings.feishu_app_secret = "secret"

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/tests/feishu-message",
            json={"receive_id_type": "open_id", "receive_id": f"  {'x' * 255}  "},
        )

    assert response.status_code == 200
    assert recipients == ["x" * 255]
