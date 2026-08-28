from __future__ import annotations

import json
from copy import deepcopy
from datetime import datetime, timedelta
from types import SimpleNamespace
from typing import Any

import httpx
from sqlalchemy import select, func, update, text
from sqlalchemy.orm import Session

from .config import Settings
from .models import (
    AnomalyGroupBroadcastDelivery,
    AnomalyEvent,
    AnomalyPushJob,
    AnomalyPushPipelineState,
    AnomalyRecord,
    AnomalyRecordGroup,
    AnomalyRecordGroupMember,
    AnomalyValidationRequest,
    Rule,
    RuleRun,
    utcnow,
)
from .message_templates import render_group_post_lines


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
    message_template: str | None = None,
    field_names: set[str] | None = None,
    broadcast_kind: str = "situation",
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
        if message_template:
            lines = render_group_post_lines(
                message_template,
                [record.row_details for record in chunk],
                group_url,
                field_names,
            )
        else:
            lines = [
                [_text(
                    f"规则：{group.rule_name}\n"
                    f"检测时间：{group.detected_at:%Y-%m-%d %H:%M:%S}\n"
                    f"扫描 {group.scanned_rows} 条，命中 {group.matched_rows} 条，新增 {group.new_anomalies} 条"
                )],
                [_link("查看异常记录组", group_url)],
            ]
            if broadcast_kind == "timeout":
                lines.insert(0, [_text(f"已超时未解决：{len(records)} 条，请相关处理人尽快处理。")])
        if chunk and not message_template:
            for record in chunk:
                status = STATUS_LABELS.get(record.status, record.status or "未知")
                business_key = json.dumps(
                    record.business_key, ensure_ascii=False, sort_keys=True, default=str,
                )
                lines.append([
                    _text(f"[{status}] {business_key} "),
                    _link("查看明细", f"{base_url}/#records/{record.id}"),
                ])
        elif not chunk and not message_template:
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
                        "title": f"【{'超时播报' if broadcast_kind == 'timeout' else '情况播报'}】{group.rule_name}{suffix}",
                        "content": lines,
                    }
                }
            },
        })
    return messages


def _available_group_time(session: Session, rule_id: str, detected_at: datetime) -> datetime:
    # The caller holds the rule execution lock and the persistence transaction's
    # pipeline lock. Preserve the existing composite FK without dropping a new
    # detection when clocks repeat the exact same microsecond.
    while session.scalar(select(AnomalyRecordGroup.run_id).where(
        AnomalyRecordGroup.rule_id == rule_id, AnomalyRecordGroup.detected_at == detected_at,
    )) is not None:
        detected_at += timedelta(microseconds=1)
    return detected_at


def create_anomaly_group(
    session: Session,
    settings: Settings,
    rule: Rule,
    run: RuleRun,
    records: list[AnomalyRecord],
    matches: list[Any],
    *,
    new_record_ids: list[str] | None = None,
) -> AnomalyRecordGroup:
    unique_records = _unique_records(records)
    if new_record_ids is None:
        # Compatibility for direct callers: an anomaly can originate in only
        # one group. Execution passes the exact IDs from its persistence step.
        prior_ids = set(session.scalars(select(AnomalyRecordGroupMember.anomaly_id).where(
            AnomalyRecordGroupMember.anomaly_id.in_([record.id for record in unique_records]),
        )))
        new_record_ids = [record.id for record in unique_records if record.id not in prior_ids]
    new_ids = set(new_record_ids)
    new_records = [record for record in unique_records if record.id in new_ids]
    fields = {str(field["name"]) for field in (rule.dataset.fields or []) if field.get("name") is not None}
    timeout_enabled = bool(rule.timeout_broadcast_enabled)
    deadlines = [record.validation_deadline for record in new_records if record.validation_deadline is not None]
    group = AnomalyRecordGroup(
        rule_id=rule.id,
        detected_at=_available_group_time(session, rule.id, run.started_at),
        run_id=run.id,
        rule_name=rule.name,
        scanned_rows=run.scanned_rows,
        matched_rows=run.matched_rows,
        new_anomalies=run.new_anomalies,
        broadcast_enabled=bool(rule.group_broadcast_enabled),
        timeout_broadcast_snapshot={
            "enabled": timeout_enabled,
            "webhook_url": rule.group_webhook_url if timeout_enabled else None,
            "message_template": rule.timeout_message_template,
            "mention_targets": deepcopy(rule.timeout_mention_targets or []),
            "field_names": sorted(fields),
        },
        timeout_deadline=max(deadlines) if timeout_enabled and deadlines else None,
    )
    session.add(group)
    session.flush()
    for position, record in enumerate(unique_records):
        session.add(AnomalyRecordGroupMember(
            rule_id=group.rule_id,
            detected_at=group.detected_at,
            anomaly_id=record.id,
            position=position,
            is_new=record.id in new_ids,
        ))

    if not rule.group_broadcast_enabled or not rule.group_webhook_url or not new_records:
        return group

    mentions = resolve_group_mentions(rule.group_mention_targets or [], [
        SimpleNamespace(row=record.row_details) for record in new_records
    ])
    _queue_group_messages(session, settings, group, new_records, mentions, rule.group_webhook_url,
                          rule.group_message_template, fields, "situation")
    return group


def _queue_group_messages(session, settings, group, records, mentions, webhook, template, fields, kind, round_index=0):
    pipeline = session.scalar(
        select(AnomalyPushPipelineState)
        .where(AnomalyPushPipelineState.id == 1)
        .execution_options(populate_existing=True)
        .with_for_update()
    )
    if pipeline is None:
        pipeline = AnomalyPushPipelineState(id=1, generation=1)
        session.add(pipeline)
        session.flush()
    messages = build_group_messages(
        group,
        records,
        mentions,
        settings.sentinel_public_base_url,
        template, fields, kind,
    )
    for part_index, payload in enumerate(messages, start=1):
        delivery = AnomalyGroupBroadcastDelivery(
            rule_id=group.rule_id,
            detected_at=group.detected_at,
            part_index=part_index,
            broadcast_kind=kind,
            round_index=round_index,
            total_parts=len(messages),
            webhook_url=webhook,
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


def queue_due_timeout_broadcasts(session: Session, settings: Settings, *, now: datetime | None = None,
                               limit: int = 50, should_stop=None) -> int:
    """Materialize newly due members once, with independent delivery rounds.

    The limit bounds groups, never members. The pipeline singleton is locked
    before groups/records, matching detection and administrative cancellation.
    """
    scan_time = now or utcnow()
    keys = list(session.execute(select(AnomalyRecordGroup.rule_id, AnomalyRecordGroup.detected_at)
        .join(AnomalyRecordGroupMember).join(AnomalyRecord,
            AnomalyRecord.id == AnomalyRecordGroupMember.anomaly_id).where(
            AnomalyRecordGroup.timeout_processed_at.is_(None),
            AnomalyRecordGroupMember.is_new.is_(True),
            AnomalyRecordGroupMember.timeout_notified_at.is_(None),
            AnomalyRecord.validation_deadline <= scan_time,
            AnomalyRecord.status.in_(["pending", "processing", "timed_out"]),
        ).group_by(AnomalyRecordGroup.rule_id, AnomalyRecordGroup.detected_at)
        .order_by(func.min(AnomalyRecord.validation_deadline), AnomalyRecordGroup.rule_id,
                  AnomalyRecordGroup.detected_at).limit(limit)))
    session.commit()
    queued = 0
    for rule_id, detected_at in keys:
        if should_stop is not None and should_stop():
            break
        if session.get_bind().dialect.name == "sqlite":
            # SQLite ignores FOR UPDATE. Reserve the writer before reading
            # the cohort so concurrent processes cannot materialize it twice.
            session.execute(text("BEGIN IMMEDIATE"))
        pipeline = session.scalar(select(AnomalyPushPipelineState).where(
            AnomalyPushPipelineState.id == 1).execution_options(populate_existing=True).with_for_update())
        if pipeline is not None and pipeline.abort_in_progress:
            session.commit()
            break
        group = session.scalar(select(AnomalyRecordGroup).where(
            AnomalyRecordGroup.rule_id == rule_id, AnomalyRecordGroup.detected_at == detected_at,
        ).execution_options(populate_existing=True).with_for_update())
        if group is None or group.timeout_processed_at is not None:
            session.commit()
            continue
        snapshot = group.timeout_broadcast_snapshot or {}
        records = list(session.scalars(select(AnomalyRecord).join(
            AnomalyRecordGroupMember, AnomalyRecordGroupMember.anomaly_id == AnomalyRecord.id,
        ).where(
            AnomalyRecordGroupMember.rule_id == rule_id,
            AnomalyRecordGroupMember.detected_at == detected_at,
            AnomalyRecordGroupMember.is_new.is_(True),
            AnomalyRecordGroupMember.timeout_notified_at.is_(None),
            AnomalyRecord.validation_deadline <= scan_time,
            AnomalyRecord.status.in_(["pending", "processing", "timed_out"]),
        ).order_by(AnomalyRecordGroupMember.position).execution_options(populate_existing=True).with_for_update()))
        for record in records:
            if record.status != "timed_out":
                record.status = "timed_out"
                record.timed_out_at = scan_time
                session.add(AnomalyEvent(anomaly_id=record.id, event_type="validation_timed_out",
                    description="异常已超过截止时间，仍可继续处理", created_at=scan_time))
        if records and snapshot.get("enabled") and snapshot.get("webhook_url"):
            handlers = list(session.scalars(select(AnomalyValidationRequest.recipient_user_id).where(
                AnomalyValidationRequest.anomaly_id.in_([record.id for record in records]),
            ).order_by(AnomalyValidationRequest.recipient_user_id)))
            extras = resolve_group_mentions(snapshot.get("mention_targets", []), [
                SimpleNamespace(row=record.row_details) for record in records
            ])
            mentions = list(dict.fromkeys([*handlers, *extras]))
            round_index = 1 + (session.scalar(select(func.max(AnomalyGroupBroadcastDelivery.round_index)).where(
                AnomalyGroupBroadcastDelivery.rule_id == rule_id,
                AnomalyGroupBroadcastDelivery.detected_at == detected_at,
                AnomalyGroupBroadcastDelivery.broadcast_kind == "timeout")) or 0)
            _queue_group_messages(session, settings, group, records, mentions, snapshot["webhook_url"],
                                  snapshot.get("message_template"), set(snapshot.get("field_names", [])),
                                  "timeout", round_index)
            session.execute(update(AnomalyRecordGroupMember).where(
                AnomalyRecordGroupMember.rule_id == rule_id,
                AnomalyRecordGroupMember.detected_at == detected_at,
                AnomalyRecordGroupMember.anomaly_id.in_([record.id for record in records]),
            ).values(timeout_notified_at=scan_time))
            queued += 1
        remaining = session.scalar(select(func.count()).select_from(AnomalyRecordGroupMember).join(
            AnomalyRecord, AnomalyRecord.id == AnomalyRecordGroupMember.anomaly_id).where(
            AnomalyRecordGroupMember.rule_id == rule_id,
            AnomalyRecordGroupMember.detected_at == detected_at,
            AnomalyRecordGroupMember.is_new.is_(True),
            AnomalyRecordGroupMember.timeout_notified_at.is_(None),
            AnomalyRecord.status != "resolved"))
        if not remaining or not snapshot.get("enabled"):
            group.timeout_processed_at = scan_time
        session.commit()
    return queued


def deliver_group_broadcasts(
    session: Session,
    settings: Settings,
    delivery_ids: list[str],
    *,
    transport: httpx.BaseTransport | None = None,
    should_stop=None,
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
            if should_stop is not None and should_stop():
                break
            delivery.attempts += 1
            delivery.status = "sending"
            delivery.last_error = None
            session.commit()
            try:
                if should_stop is not None and should_stop():
                    delivery.status = "aborted"
                    delivery.next_attempt_at = None
                    session.commit()
                    break
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
