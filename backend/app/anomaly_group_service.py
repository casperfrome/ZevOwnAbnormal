from __future__ import annotations

import json
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .models import (
    AnomalyGroupBroadcastDelivery,
    AnomalyPushJob,
    AnomalyPushPipelineState,
    AnomalyRecord,
    AnomalyRecordGroup,
    AnomalyRecordGroupMember,
    Rule,
    RuleRun,
    utcnow,
)


RECORDS_PER_MESSAGE = 20
STATUS_LABELS = {
    "pending": "待处理",
    "processing": "处理中",
    "timed_out": "已超时",
    "resolved": "已解决",
}


class GroupWebhookDeliveryError(RuntimeError):
    pass


class GroupWebhookDeliveryUncertainError(RuntimeError):
    pass


def _text(value: str) -> dict[str, str]:
    return {"tag": "text", "text": value}


def _link(label: str, href: str) -> dict[str, str]:
    return {"tag": "a", "text": label, "href": href}


def _unique_records(records: list[AnomalyRecord]) -> list[AnomalyRecord]:
    result: list[AnomalyRecord] = []
    seen: set[str] = set()
    for record in records:
        if record.id not in seen:
            result.append(record)
            seen.add(record.id)
    return result


def resolve_group_mentions(targets: list[dict], matches: list[Any]) -> list[str]:
    values: list[str] = []
    seen: set[str] = set()
    for target in targets:
        candidates = (
            [target.get("value")]
            if target.get("source") == "literal"
            else [match.row.get(target.get("field", "")) for match in matches]
        )
        for candidate in candidates:
            value = "" if candidate is None else str(candidate).strip()
            if value and value not in seen:
                values.append(value)
                seen.add(value)
    return values


def build_group_messages(
    group: AnomalyRecordGroup,
    records: list[AnomalyRecord],
    mention_user_ids: list[str],
    public_base_url: str,
) -> list[dict[str, Any]]:
    base_url = public_base_url.rstrip("/")
    chunks = [
        records[index:index + RECORDS_PER_MESSAGE]
        for index in range(0, len(records), RECORDS_PER_MESSAGE)
    ] or [[]]
    total_parts = len(chunks)
    group_url = f"{base_url}/#anomaly-groups/{group.run_id}"
    messages: list[dict[str, Any]] = []
    for part_index, chunk in enumerate(chunks, start=1):
        suffix = f"（{part_index}/{total_parts}）" if total_parts > 1 else ""
        lines: list[list[dict[str, str]]] = [
            [_text(
                f"规则：{group.rule_name}\n"
                f"检测时间：{group.detected_at:%Y-%m-%d %H:%M:%S}\n"
                f"扫描 {group.scanned_rows} 条，命中 {group.matched_rows} 条，新增 {group.new_anomalies} 条"
            )],
            [_link("查看异常记录组", group_url)],
        ]
        if chunk:
            for record in chunk:
                status = STATUS_LABELS.get(record.status, record.status or "未知")
                business_key = json.dumps(
                    record.business_key, ensure_ascii=False, sort_keys=True, default=str,
                )
                lines.append([
                    _text(f"[{status}] {business_key} "),
                    _link("查看明细", f"{base_url}/#records/{record.id}"),
                ])
        else:
            lines.append([_text("本次未检测到异常")])
        if part_index == 1 and mention_user_ids:
            lines.append([_text("请关注："), *[
                {"tag": "at", "user_id": user_id, "user_name": "相关成员"}
                for user_id in mention_user_ids
            ]])
        messages.append({
            "msg_type": "post",
            "content": {
                "post": {
                    "zh-CN": {
                        "title": f"【异常检测完成】{group.rule_name}{suffix}",
                        "content": lines,
                    }
                }
            },
        })
    return messages


def create_anomaly_group(
    session: Session,
    settings: Settings,
    rule: Rule,
    run: RuleRun,
    records: list[AnomalyRecord],
    matches: list[Any],
) -> AnomalyRecordGroup:
    unique_records = _unique_records(records)
    group = AnomalyRecordGroup(
        rule_id=rule.id,
        detected_at=run.started_at,
        run_id=run.id,
        rule_name=rule.name,
        scanned_rows=run.scanned_rows,
        matched_rows=run.matched_rows,
        new_anomalies=run.new_anomalies,
        broadcast_enabled=bool(rule.group_broadcast_enabled),
    )
    session.add(group)
    session.flush()
    for position, record in enumerate(unique_records):
        session.add(AnomalyRecordGroupMember(
            rule_id=group.rule_id,
            detected_at=group.detected_at,
            anomaly_id=record.id,
            position=position,
        ))

    if not rule.group_broadcast_enabled or not rule.group_webhook_url:
        return group

    pipeline = session.scalar(
        select(AnomalyPushPipelineState)
        .where(AnomalyPushPipelineState.id == 1)
        .with_for_update()
    )
    if pipeline is None:
        pipeline = AnomalyPushPipelineState(id=1, generation=1)
        session.add(pipeline)
        session.flush()
    mentions = resolve_group_mentions(rule.group_mention_targets or [], matches)
    messages = build_group_messages(
        group, unique_records, mentions, settings.sentinel_public_base_url,
    )
    for part_index, payload in enumerate(messages, start=1):
        delivery = AnomalyGroupBroadcastDelivery(
            rule_id=group.rule_id,
            detected_at=group.detected_at,
            part_index=part_index,
            total_parts=len(messages),
            webhook_url=rule.group_webhook_url,
            payload=payload,
        )
        session.add(delivery)
        session.flush()
        session.add(AnomalyPushJob(
            anomaly_id=None,
            kind="group_broadcast",
            delivery_id=delivery.id,
            generation=pipeline.generation,
        ))
    return group


def deliver_group_broadcasts(
    session: Session,
    settings: Settings,
    delivery_ids: list[str],
    *,
    transport: httpx.BaseTransport | None = None,
) -> int:
    if not delivery_ids:
        return 0
    deliveries = list(session.scalars(
        select(AnomalyGroupBroadcastDelivery)
        .where(
            AnomalyGroupBroadcastDelivery.id.in_(delivery_ids),
            AnomalyGroupBroadcastDelivery.status.in_(["pending", "failed"]),
        )
        .order_by(AnomalyGroupBroadcastDelivery.created_at, AnomalyGroupBroadcastDelivery.id)
    ))
    with httpx.Client(
        timeout=settings.feishu_http_timeout_seconds,
        transport=transport,
    ) as client:
        for delivery in deliveries:
            delivery.attempts += 1
            delivery.status = "sending"
            delivery.last_error = None
            session.commit()
            try:
                response = client.post(delivery.webhook_url, json=delivery.payload)
                if not response.is_success:
                    raise GroupWebhookDeliveryError(
                        f"飞书 webhook 返回 HTTP {response.status_code}"
                    )
                try:
                    body = response.json()
                except ValueError as exc:
                    raise GroupWebhookDeliveryUncertainError("飞书 webhook 发送结果未知：响应格式无效") from exc
                if not isinstance(body, dict):
                    raise GroupWebhookDeliveryUncertainError("飞书 webhook 发送结果未知：响应格式无效")
                code = body.get("code", body.get("StatusCode"))
                if code != 0:
                    message = body.get("msg") or body.get("StatusMessage") or "未知错误"
                    raise GroupWebhookDeliveryError(f"飞书拒绝群聊播报：{message}")
            except GroupWebhookDeliveryUncertainError as exc:
                delivery.status = "uncertain"
                delivery.last_error = str(exc)[:2000]
                session.commit()
                raise
            except (httpx.ReadTimeout, httpx.ReadError, httpx.RemoteProtocolError) as exc:
                error = GroupWebhookDeliveryUncertainError("飞书 webhook 发送结果未知：响应未确认")
                delivery.status = "uncertain"
                delivery.last_error = str(error)
                session.commit()
                raise error from exc
            except GroupWebhookDeliveryError as exc:
                delivery.status = "failed"
                delivery.last_error = str(exc)[:2000]
                session.commit()
                raise
            except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout) as exc:
                error = GroupWebhookDeliveryError("飞书 webhook 连接失败")
                delivery.status = "failed"
                delivery.last_error = str(error)
                session.commit()
                raise error from exc
            except httpx.HTTPError as exc:
                error = GroupWebhookDeliveryUncertainError("飞书 webhook 发送结果未知：网络异常")
                delivery.status = "uncertain"
                delivery.last_error = str(error)
                session.commit()
                raise error from exc
            delivery.status = "sent"
            delivery.delivered_at = utcnow()
            delivery.last_error = None
            delivery.next_attempt_at = None
            session.commit()
    return 0
