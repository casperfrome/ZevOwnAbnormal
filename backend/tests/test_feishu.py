import json

import httpx
import pytest

from app.feishu import FeishuClient, FeishuDeliveryUncertainError, FeishuError


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


def test_feishu_text_uses_stable_idempotency_key():
    requests = []

    def handler(request: httpx.Request):
        requests.append(request)
        if request.url.path.endswith("tenant_access_token/internal/"):
            return httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
        return httpx.Response(200, json={"code": 0, "data": {"message_id": "om_123"}})

    client = FeishuClient("cli_app", "secret", transport=httpx.MockTransport(handler))
    client.send_text("open_id", "ou_user", "检测到异常", idempotency_key="delivery-1")

    assert json.loads(requests[1].content)["uuid"] == "delivery-1"


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


def test_feishu_classifies_transport_loss_and_success_without_message_id_as_uncertain():
    """An ambiguous create result must not be treated as a definitive retryable rejection."""
    responses = iter([
        httpx.ReadTimeout("response lost"),
        httpx.Response(200, json={"code": 0, "data": {}}),
    ])

    def handler(request: httpx.Request):
        if request.url.path.endswith("tenant_access_token/internal/"):
            return httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
        response = next(responses)
        if isinstance(response, Exception):
            raise response
        return response

    client = FeishuClient("cli_app", "secret", transport=httpx.MockTransport(handler))
    card = {"schema": "2.0", "body": {"elements": []}}

    with pytest.raises(FeishuDeliveryUncertainError):
        client.send_interactive("user_id", "user-1", card, idempotency_key="request-1")
    with pytest.raises(FeishuDeliveryUncertainError):
        client.send_interactive("user_id", "user-1", card, idempotency_key="request-1")


@pytest.mark.parametrize(
    "send_response",
    [
        httpx.Response(408, json={"code": 999, "msg": "timeout"}),
        httpx.Response(500, json={"code": 999, "msg": "temporary"}),
        httpx.Response(503, text="truncated upstream response"),
        httpx.Response(200, text='{"code": 0, "data":'),
    ],
)
def test_interactive_post_http_timeout_server_error_or_unparseable_response_is_uncertain(send_response):
    """Once the message POST starts, these responses cannot prove that no card was created."""
    def handler(request: httpx.Request):
        if request.url.path.endswith("tenant_access_token/internal/"):
            return httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
        return send_response

    client = FeishuClient("cli_app", "secret", transport=httpx.MockTransport(handler))

    with pytest.raises(FeishuDeliveryUncertainError):
        client.send_interactive("user_id", "user-1", {"schema": "2.0"}, idempotency_key="request-1")


def test_interactive_token_failure_is_a_safe_pre_post_error_and_valid_4xx_is_definitive():
    """Token acquisition never posts a card; a parsed 4xx explicitly rejects the message create."""
    token_calls = []

    def token_failure(request: httpx.Request):
        token_calls.append(request.url.path)
        return httpx.Response(503, json={"code": 999, "msg": "token unavailable"})

    token_client = FeishuClient("cli_app", "secret", transport=httpx.MockTransport(token_failure))
    with pytest.raises(FeishuError) as token_error:
        token_client.send_interactive("user_id", "user-1", {"schema": "2.0"})
    assert not isinstance(token_error.value, FeishuDeliveryUncertainError)
    assert token_calls == ["/open-apis/auth/v3/tenant_access_token/internal/"]

    network_token_client = FeishuClient(
        "cli_app",
        "secret",
        transport=httpx.MockTransport(lambda request: (_ for _ in ()).throw(
            httpx.ReadTimeout("token response lost", request=request)
        )),
    )
    with pytest.raises(FeishuError) as network_token_error:
        network_token_client.send_interactive("user_id", "user-1", {"schema": "2.0"})
    assert not isinstance(network_token_error.value, FeishuDeliveryUncertainError)

    def rejected_message(request: httpx.Request):
        if request.url.path.endswith("tenant_access_token/internal/"):
            return httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
        return httpx.Response(400, json={"code": 230002, "msg": "user_id rejected"})

    rejected_client = FeishuClient("cli_app", "secret", transport=httpx.MockTransport(rejected_message))
    with pytest.raises(FeishuError) as rejection:
        rejected_client.send_interactive("user_id", "missing", {"schema": "2.0"})
    assert not isinstance(rejection.value, FeishuDeliveryUncertainError)


@pytest.mark.parametrize("kind", ["interactive", "text"])
def test_cancellation_after_token_does_not_start_the_message_post(kind):
    stopped = False
    paths = []

    def handler(request: httpx.Request):
        nonlocal stopped
        paths.append(request.url.path)
        if request.url.path.endswith("tenant_access_token/internal/"):
            stopped = True
            return httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
        raise AssertionError("cancellation between external calls must prevent message POST")

    client = FeishuClient(
        "cli_app",
        "secret",
        transport=httpx.MockTransport(handler),
        cancellation_check=lambda: stopped,
    )

    with pytest.raises(FeishuError, match="已取消") as cancelled:
        if kind == "interactive":
            client.send_interactive("user_id", "user-1", {"schema": "2.0"})
        else:
            client.send_text("user_id", "user-1", "text")

    assert not isinstance(cancelled.value, FeishuDeliveryUncertainError)
    assert paths == ["/open-apis/auth/v3/tenant_access_token/internal/"]


@pytest.mark.parametrize(
    "send_response",
    [
        httpx.Response(200, text="not-json"),
        httpx.Response(200, json={"code": 0, "data": {}}),
    ],
)
def test_text_send_malformed_response_is_a_definitive_feishu_error(send_response):
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
