from __future__ import annotations

from collections.abc import Callable
import json
import time

import httpx


class FeishuError(RuntimeError):
    pass


class FeishuDeliveryUncertainError(FeishuError):
    pass


class FeishuConfigurationError(RuntimeError):
    pass


class FeishuClient:
    def __init__(
        self,
        app_id: str,
        app_secret: str,
        transport=None,
        timeout: float = 10.0,
        cancellation_check: Callable[[], bool] | None = None,
    ):
        self.app_id = app_id
        self.app_secret = app_secret
        self._client = httpx.Client(base_url="https://open.feishu.cn", timeout=timeout, transport=transport)
        self._token = ""
        self._token_expires_at = 0.0
        self._cancellation_check = cancellation_check

    def close(self):
        self._client.close()

    def _ensure_not_cancelled(self) -> None:
        if self._cancellation_check is not None and self._cancellation_check():
            raise FeishuError("飞书操作已取消")

    @staticmethod
    def _response_body(response: httpx.Response, operation: str) -> dict:
        try:
            body = response.json()
        except ValueError as exc:
            raise FeishuError(f"{operation}: 飞书返回了无效 JSON") from exc
        if not isinstance(body, dict):
            raise FeishuError(f"{operation}: 飞书返回格式无效")
        return body

    @classmethod
    def _ensure_success(cls, response: httpx.Response, operation: str) -> None:
        if response.is_success:
            return
        body = cls._response_body(response, operation)
        message = body.get("msg") or f"HTTP {response.status_code}"
        code = body.get("code")
        suffix = f" (code: {code})" if code is not None else ""
        raise FeishuError(f"{operation}: {message}{suffix}")

    def _tenant_token(self) -> str:
        if self._token and time.monotonic() < self._token_expires_at:
            return self._token
        try:
            response = self._client.post(
                "/open-apis/auth/v3/tenant_access_token/internal/",
                json={"app_id": self.app_id, "app_secret": self.app_secret},
            )
        except httpx.TransportError as exc:
            raise FeishuError("获取 tenant_access_token 失败: 网络请求失败") from exc
        self._ensure_success(response, "获取 tenant_access_token 失败")
        body = self._response_body(response, "获取 tenant_access_token 失败")
        token = body.get("tenant_access_token")
        if body.get("code") != 0 or not isinstance(token, str) or not token:
            raise FeishuError(f"获取 tenant_access_token 失败: {body.get('msg', body)}")
        try:
            expire = int(body.get("expire", 7200))
        except (TypeError, ValueError) as exc:
            raise FeishuError("获取 tenant_access_token 失败: expire 格式无效") from exc
        self._token = token
        self._token_expires_at = time.monotonic() + max(expire - 300, 60)
        return self._token

    def send_text(self, receive_id_type: str, recipient: str, text: str) -> str:
        token = self._tenant_token()
        response = self._client.post(
            "/open-apis/im/v1/messages",
            params={"receive_id_type": receive_id_type},
            headers={"Authorization": f"Bearer {token}"},
            json={"receive_id": recipient, "msg_type": "text", "content": json.dumps({"text": text}, ensure_ascii=False)},
        )
        self._ensure_success(response, "发送飞书消息失败")
        body = self._response_body(response, "发送飞书消息失败")
        if body.get("code") != 0:
            raise FeishuError(f"发送飞书消息失败: {body.get('msg', body)}")
        message_id = body.get("data", {}).get("message_id") if isinstance(body.get("data"), dict) else None
        if not isinstance(message_id, str) or not message_id:
            raise FeishuError("发送飞书消息失败: 飞书响应缺少 message_id")
        return message_id

    def send_interactive(
        self,
        receive_id_type: str,
        recipient: str,
        card: dict,
        *,
        idempotency_key: str | None = None,
    ) -> str:
        token = self._tenant_token()
        self._ensure_not_cancelled()
        payload = {
            "receive_id": recipient,
            "msg_type": "interactive",
            "content": json.dumps(card, ensure_ascii=False),
        }
        if idempotency_key:
            payload["uuid"] = idempotency_key
        try:
            response = self._client.post(
                "/open-apis/im/v1/messages",
                params={"receive_id_type": receive_id_type},
                headers={"Authorization": f"Bearer {token}"},
                json=payload,
            )
        except httpx.TransportError as exc:
            raise FeishuDeliveryUncertainError("发送飞书卡片结果未知: 网络响应丢失") from exc
        if response.status_code == 408 or response.status_code >= 500:
            raise FeishuDeliveryUncertainError(
                f"发送飞书卡片结果未知: HTTP {response.status_code}"
            )
        try:
            body = self._response_body(response, "发送飞书卡片失败")
        except FeishuError as exc:
            raise FeishuDeliveryUncertainError("发送飞书卡片结果未知: 响应无法解析") from exc
        if not response.is_success:
            message = body.get("msg") or f"HTTP {response.status_code}"
            code = body.get("code")
            suffix = f" (code: {code})" if code is not None else ""
            raise FeishuError(f"发送飞书卡片失败: {message}{suffix}")
        if not isinstance(body.get("code"), int):
            raise FeishuDeliveryUncertainError("发送飞书卡片结果未知: 成功响应缺少 code")
        if body.get("code") != 0:
            raise FeishuError(f"发送飞书卡片失败: {body.get('msg', body)}")
        message_id = body.get("data", {}).get("message_id") if isinstance(body.get("data"), dict) else None
        if not isinstance(message_id, str) or not message_id:
            raise FeishuDeliveryUncertainError("发送飞书卡片结果未知: 飞书响应缺少 message_id")
        return message_id

    def patch_interactive(self, message_id: str, card: dict) -> None:
        token = self._tenant_token()
        self._ensure_not_cancelled()
        response = self._client.patch(
            f"/open-apis/im/v1/messages/{message_id}",
            headers={"Authorization": f"Bearer {token}"},
            json={"content": json.dumps(card, ensure_ascii=False)},
        )
        self._ensure_success(response, "更新飞书卡片失败")
        body = self._response_body(response, "更新飞书卡片失败")
        if body.get("code") != 0:
            raise FeishuError(f"更新飞书卡片失败: {body.get('msg', body)}")


def send_configured_text(
    app_id: str,
    app_secret: str,
    receive_id_type: str,
    recipient: str,
    text: str,
    *,
    client: FeishuClient | None = None,
) -> str:
    if not app_id or not app_secret:
        raise FeishuConfigurationError("未配置飞书 App ID/App Secret")

    owns_client = client is None
    active_client = client or FeishuClient(app_id, app_secret)
    try:
        return active_client.send_text(receive_id_type, recipient, text)
    finally:
        if owns_client:
            active_client.close()
