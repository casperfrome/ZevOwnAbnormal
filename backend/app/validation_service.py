from __future__ import annotations

import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Iterator

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .config import Settings
from .feishu import FeishuClient, FeishuConfigurationError
from .models import (
    AnomalyEvent,
    AnomalyRecord,
    AnomalyValidationRequest,
    AnomalyValidationSubmission,
    NotificationDelivery,
    Rule,
    utcnow,
)


class ValidationTextError(ValueError):
    pass


class ValidationRecipientError(ValueError):
    pass


class InvalidValidationTransition(ValueError):
    pass


@dataclass(frozen=True)
class SubmissionResult:
    outcome: str
    submission: AnomalyValidationSubmission | None


_sqlite_locks_guard = threading.Lock()
_sqlite_locks: dict[str, threading.Lock] = {}


def resolve_validation_targets(targets: list[dict], row: dict[str, Any]) -> list[str]:
    resolved: list[str] = []
    seen: set[str] = set()
    for target in targets:
        if target.get("source") == "literal":
            value = target.get("value")
        elif target.get("source") == "field":
            value = row.get(target.get("field", ""))
        else:
            continue
        normalized = "" if value is None else str(value).strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            resolved.append(normalized)
    return resolved


def snapshot_validation(
    session: Session,
    rule: Rule,
    anomaly: AnomalyRecord,
    *,
    now: datetime | None = None,
) -> list[str]:
    if not rule.validation_enabled:
        return []
    snapshot_time = now or utcnow()
    recipients = resolve_validation_targets(rule.validation_targets, anomaly.row_details)
    if anomaly.validation_deadline is None:
        anomaly.description = rule.description
        anomaly.validation_deadline = snapshot_time + timedelta(minutes=rule.validation_timeout_minutes)
    existing_recipients = set(session.scalars(select(AnomalyValidationRequest.recipient_user_id).where(
        AnomalyValidationRequest.anomaly_id == anomaly.id
    )))
    new_recipients = [recipient for recipient in recipients if recipient not in existing_recipients]
    for recipient in new_recipients:
        session.add(AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id=recipient))
    session.flush()
    if new_recipients:
        session.add(AnomalyEvent(
            anomaly_id=anomaly.id,
            event_type="validation_requested",
            description=f"已向 {len(new_recipients)} 位验证人发送实时验证请求",
            created_at=snapshot_time,
        ))
        legacy_deliveries = list(session.scalars(select(NotificationDelivery).where(
            NotificationDelivery.anomaly_id == anomaly.id,
            NotificationDelivery.receive_id_type == "user_id",
            NotificationDelivery.recipient.in_(recipients),
        )))
        for delivery in legacy_deliveries:
            session.delete(delivery)
    return recipients


def _format_time(value: datetime | None) -> str:
    return value.strftime("%Y-%m-%d %H:%M:%S") if value else "-"


def build_validation_card(anomaly: AnomalyRecord, public_base_url: str) -> dict:
    link = f"{public_base_url.rstrip('/')}/#records/{anomaly.id}"
    state_names = {
        "pending": "待处理",
        "processing": "处理中",
        "timed_out": "已超时",
        "resolved": "已解决",
    }
    state = state_names.get(anomaly.status, anomaly.status)
    facts = (
        f"**异常描述：** {anomaly.description or '-'}\n"
        f"**规则：** {anomaly.rule_name}\n"
        f"**数据集：** {anomaly.dataset_name}\n"
        f"**严重程度：** {anomaly.severity}\n"
        f"**验证状态：** {state}\n"
        f"**截止时间：** {_format_time(anomaly.validation_deadline)}\n"
        f"[查看异常详情]({link})"
    )
    elements: list[dict] = [{"tag": "markdown", "content": facts}]
    if anomaly.status == "resolved":
        elements.append({
            "tag": "markdown",
            "content": (
                f"**验证人：** {anomaly.resolved_by_user_id or '-'}\n"
                f"**解决时间：** {_format_time(anomaly.resolved_at)}"
            ),
        })
    else:
        elements.append({
            "tag": "form",
            "name": "validation_form",
            "elements": [
                {
                    "tag": "input",
                    "name": "validation_text",
                    "required": True,
                    "placeholder": {"tag": "plain_text", "content": "请输入验证说明（1-1000 字）"},
                    "max_length": 1000,
                },
                {
                    "tag": "button",
                    "text": {"tag": "plain_text", "content": "提交验证"},
                    "type": "primary",
                    "action_type": "form_submit",
                    "value": {"action": "submit_validation", "anomaly_id": anomaly.id},
                },
            ],
        })
    templates = {"pending": "orange", "processing": "blue", "timed_out": "grey", "resolved": "green"}
    return {
        "schema": "2.0",
        "config": {"update_multi": True},
        "header": {
            "title": {"tag": "plain_text", "content": f"异常实时验证 · {state}"},
            "template": templates.get(anomaly.status, "orange"),
        },
        "body": {"elements": elements},
    }


def _active_client(settings: Settings, client: FeishuClient | None) -> tuple[FeishuClient, bool]:
    if client is not None:
        return client, False
    if not settings.feishu_app_id or not settings.feishu_app_secret:
        raise FeishuConfigurationError("未配置飞书 App ID/App Secret")
    return FeishuClient(settings.feishu_app_id, settings.feishu_app_secret), True


def deliver_validation_requests(
    session: Session,
    settings: Settings,
    *,
    request_ids: list[str] | None = None,
    rule_id: str | None = None,
    client: FeishuClient | None = None,
) -> int:
    query = select(AnomalyValidationRequest, AnomalyRecord).join(
        AnomalyRecord, AnomalyValidationRequest.anomaly_id == AnomalyRecord.id
    ).where(AnomalyValidationRequest.delivery_status.in_(["pending", "failed"]))
    if request_ids is not None:
        if not request_ids:
            return 0
        query = query.where(AnomalyValidationRequest.id.in_(request_ids))
    if rule_id is not None:
        query = query.where(AnomalyRecord.rule_id == rule_id)
    pending = list(session.execute(query))
    if not pending:
        return 0
    failures = 0
    active_client = None
    owns_client = False
    try:
        active_client, owns_client = _active_client(settings, client)
        for request, anomaly in pending:
            for attempt in range(3):
                request.delivery_attempts += 1
                try:
                    request.message_id = active_client.send_interactive(
                        "user_id",
                        request.recipient_user_id,
                        build_validation_card(anomaly, settings.sentinel_public_base_url),
                    )
                    request.delivery_status = anomaly.status if anomaly.status in {"timed_out", "resolved"} else "sent"
                    request.last_error = None
                    request.delivered_at = utcnow()
                    break
                except Exception as exc:
                    request.delivery_status = "failed"
                    request.last_error = str(exc)[:2000]
                    if attempt < 2:
                        time.sleep((0.2, 0.5)[attempt])
            if request.delivery_status == "failed":
                failures += 1
        session.commit()
    except Exception as exc:
        for request, _ in pending:
            request.delivery_attempts += 1
            request.delivery_status = "failed"
            request.last_error = str(exc)[:2000]
        session.commit()
        failures = len(pending)
    finally:
        if owns_client and active_client is not None:
            active_client.close()
    return failures


def transition_anomaly(
    session: Session,
    anomaly: AnomalyRecord,
    target_status: str,
    *,
    now: datetime | None = None,
    source: str | None = None,
    user_id: str | None = None,
    allow_timeout: bool = False,
) -> bool:
    if target_status not in {"pending", "processing", "timed_out", "resolved"}:
        raise InvalidValidationTransition("未知异常状态")
    if anomaly.status == "resolved":
        if target_status == "resolved":
            return False
        raise InvalidValidationTransition("已解决异常不能重新打开")
    if anomaly.status == "timed_out" and target_status in {"pending", "processing"}:
        raise InvalidValidationTransition("已超时异常只能被解决")
    if target_status == "timed_out" and not allow_timeout:
        raise InvalidValidationTransition("超时状态只能由系统设置")
    if anomaly.status == target_status:
        return False
    changed_at = now or utcnow()
    anomaly.status = target_status
    if target_status == "timed_out":
        anomaly.timed_out_at = changed_at
    if target_status == "resolved":
        anomaly.resolved_at = changed_at
        anomaly.active_fingerprint = None
        anomaly.resolution_source = source
        anomaly.resolved_by_user_id = user_id
    return True


def expire_due_anomalies(session: Session, *, now: datetime | None = None) -> int:
    timeout_time = now or utcnow()
    due = list(session.scalars(
        select(AnomalyRecord).where(
            AnomalyRecord.status.in_(["pending", "processing"]),
            AnomalyRecord.validation_deadline.is_not(None),
            AnomalyRecord.validation_deadline <= timeout_time,
        ).with_for_update()
    ))
    for anomaly in due:
        transition_anomaly(session, anomaly, "timed_out", now=timeout_time, allow_timeout=True)
        session.add(AnomalyEvent(
            anomaly_id=anomaly.id,
            event_type="validation_timed_out",
            description="实时验证已超过截止时间，仍可补充提交",
            created_at=timeout_time,
        ))
    session.commit()
    return len(due)


@contextmanager
def _serialize_submission(session: Session, anomaly_id: str) -> Iterator[None]:
    if session.get_bind().dialect.name != "sqlite":
        yield
        return
    with _sqlite_locks_guard:
        lock = _sqlite_locks.setdefault(anomaly_id, threading.Lock())
    with lock:
        yield


def _existing_result(submission: AnomalyValidationSubmission, operator_user_id: str) -> SubmissionResult:
    outcome = "duplicate" if submission.submitted_by_user_id == operator_user_id else "already_resolved"
    return SubmissionResult(outcome, submission)


def submit_validation(
    session: Session,
    anomaly_id: str,
    operator_user_id: str,
    validation_text: str,
    *,
    now: datetime | None = None,
) -> SubmissionResult:
    submitted_text = validation_text.strip()
    if not 1 <= len(submitted_text) <= 1000:
        raise ValidationTextError("验证说明长度必须为 1-1000 个字符")

    submitted_at = now or utcnow()
    with _serialize_submission(session, anomaly_id):
        anomaly = session.scalar(
            select(AnomalyRecord).where(AnomalyRecord.id == anomaly_id).with_for_update()
        )
        if anomaly is None:
            raise ValueError("异常不存在")
        request = session.scalar(select(AnomalyValidationRequest).where(
            AnomalyValidationRequest.anomaly_id == anomaly_id,
            AnomalyValidationRequest.recipient_user_id == operator_user_id,
        ))
        if request is None:
            raise ValidationRecipientError("当前用户不是该异常的验证人")
        existing = session.scalar(select(AnomalyValidationSubmission).where(
            AnomalyValidationSubmission.anomaly_id == anomaly_id
        ))
        if existing is not None:
            return _existing_result(existing, operator_user_id)
        if anomaly.status == "resolved":
            return SubmissionResult("already_resolved", None)
        if anomaly.status not in {"pending", "processing", "timed_out"}:
            raise InvalidValidationTransition("当前异常状态不允许实时验证")

        submission = AnomalyValidationSubmission(
            anomaly_id=anomaly.id,
            request_id=request.id,
            submitted_by_user_id=operator_user_id,
            submitted_text=submitted_text,
            validator_type="pseudo",
            result="passed",
            submitted_at=submitted_at,
        )
        session.add(submission)
        transition_anomaly(
            session,
            anomaly,
            "resolved",
            now=submitted_at,
            source="validation",
            user_id=operator_user_id,
        )
        session.add(AnomalyEvent(
            anomaly_id=anomaly.id,
            event_type="validation_resolved",
            description=f"验证人 {operator_user_id} 提交说明并解决异常",
            created_at=submitted_at,
        ))
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            winner = session.scalar(select(AnomalyValidationSubmission).where(
                AnomalyValidationSubmission.anomaly_id == anomaly_id
            ))
            if winner is None:
                raise
            return _existing_result(winner, operator_user_id)
        return SubmissionResult("accepted", submission)


def reconcile_validation_cards(
    session: Session,
    settings: Settings,
    *,
    client: FeishuClient | None = None,
) -> int:
    candidates = list(session.execute(
        select(AnomalyValidationRequest, AnomalyRecord).join(
            AnomalyRecord, AnomalyValidationRequest.anomaly_id == AnomalyRecord.id
        ).where(
            AnomalyValidationRequest.message_id.is_not(None),
            AnomalyRecord.status.in_(["timed_out", "resolved"]),
            AnomalyValidationRequest.delivery_status.in_(["sent", "timed_out", "update_failed"]),
        )
    ))
    if not candidates:
        return 0
    failures = 0
    active_client = None
    owns_client = False
    try:
        active_client, owns_client = _active_client(settings, client)
        for request, anomaly in candidates:
            try:
                active_client.patch_interactive(
                    request.message_id,
                    build_validation_card(anomaly, settings.sentinel_public_base_url),
                )
                request.delivery_status = anomaly.status
                request.last_error = None
            except Exception as exc:
                request.delivery_attempts += 1
                request.delivery_status = "update_failed"
                request.last_error = str(exc)[:2000]
                failures += 1
        session.commit()
    except Exception as exc:
        for request, _ in candidates:
            request.delivery_attempts += 1
            request.delivery_status = "update_failed"
            request.last_error = str(exc)[:2000]
        session.commit()
        failures = len(candidates)
    finally:
        if owns_client and active_client is not None:
            active_client.close()
    return failures
