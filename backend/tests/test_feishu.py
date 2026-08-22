import json

import httpx
import pytest

from app.feishu import FeishuClient, FeishuError


def test_feishu_obtains_token_and_sends_message():
    requests = []

    def handler(request: httpx.Request):
        requests.append(request)
        if request.url.path.endswith("tenant_access_token/internal/"):
            return httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
        return httpx.Response(200, json={"code": 0, "data": {"message_id": "om_123"}})

    client = FeishuClient("cli_app", "secret", transport=httpx.MockTransport(handler))

    message_id = client.send_text("open_id", "ou_user", "检测到异常")

    assert message_id == "om_123"
    assert len(requests) == 2
    assert requests[1].headers["Authorization"] == "Bearer token"
    assert requests[1].url.params["receive_id_type"] == "open_id"


def test_feishu_sends_and_patches_interactive_cards_with_shared_token():
    """Using the wrong message type, content encoding, or patch endpoint must fail."""
    requests = []

    def handler(request: httpx.Request):
        requests.append(request)
        if request.url.path.endswith("tenant_access_token/internal/"):
            return httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
        if request.method == "POST":
            return httpx.Response(200, json={"code": 0, "data": {"message_id": "om_card"}})
        return httpx.Response(200, json={"code": 0})

    client = FeishuClient("cli_app", "secret", transport=httpx.MockTransport(handler))
    card = {"schema": "2.0", "body": {"elements": [{"tag": "markdown", "content": "hello"}]}}

    assert client.send_interactive("user_id", "user-1", card, idempotency_key="request-1") == "om_card"
    client.patch_interactive("om_card", card)

    assert len(requests) == 3
    send_payload = json.loads(requests[1].content)
    patch_payload = json.loads(requests[2].content)
    assert requests[1].url.params["receive_id_type"] == "user_id"
    assert send_payload == {
        "receive_id": "user-1", "msg_type": "interactive",
        "content": json.dumps(card, ensure_ascii=False), "uuid": "request-1",
    }
    assert requests[2].method == "PATCH"
    assert requests[2].url.path == "/open-apis/im/v1/messages/om_card"
    assert patch_payload == {"content": json.dumps(card, ensure_ascii=False)}
    assert requests[2].headers["Authorization"] == "Bearer token"


@pytest.mark.parametrize(
    "send_response",
    [
        httpx.Response(200, text="not-json"),
        httpx.Response(200, json={"code": 0, "data": {}}),
    ],
)
def test_feishu_wraps_malformed_send_response_as_feishu_error(send_response):
    def handler(request: httpx.Request):
        if request.url.path.endswith("tenant_access_token/internal/"):
            return httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
        return send_response

    client = FeishuClient("cli_app", "secret", transport=httpx.MockTransport(handler))

    with pytest.raises(FeishuError, match="发送飞书消息失败"):
        client.send_text("open_id", "ou_user", "检测到异常")


def test_feishu_wraps_invalid_token_expiry_as_feishu_error():
    def handler(_: httpx.Request):
        return httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": "tomorrow"})

    client = FeishuClient("cli_app", "secret", transport=httpx.MockTransport(handler))

    with pytest.raises(FeishuError, match="获取 tenant_access_token 失败"):
        client.send_text("open_id", "ou_user", "检测到异常")


def test_feishu_rejects_non_string_message_id():
    def handler(request: httpx.Request):
        if request.url.path.endswith("tenant_access_token/internal/"):
            return httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
        return httpx.Response(200, json={"code": 0, "data": {"message_id": 123}})

    client = FeishuClient("cli_app", "secret", transport=httpx.MockTransport(handler))

    with pytest.raises(FeishuError, match="发送飞书消息失败"):
        client.send_text("open_id", "ou_user", "检测到异常")


def test_feishu_surfaces_business_message_from_http_error_response():
    def handler(request: httpx.Request):
        if request.url.path.endswith("tenant_access_token/internal/"):
            return httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
        return httpx.Response(400, json={"code": 230002, "msg": "user_id 不存在或不可用"})

    client = FeishuClient("cli_app", "secret", transport=httpx.MockTransport(handler))

    with pytest.raises(FeishuError, match="user_id 不存在或不可用"):
        client.send_text("user_id", "NO000001", "检测到异常")
