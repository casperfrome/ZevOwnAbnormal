from __future__ import annotations

import time

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from . import feishu as feishu_gateway
from .anomaly_service import persist_matches
from .config import Settings
from .feishu import FeishuClient
from .models import AnomalyRecord, NotificationDelivery, Rule, RuleRun, utcnow
from .query_service import connect_to_datasource, fetch_rule_rows
from .rule_engine import evaluate_rows
from .security import CredentialCipher


class RuleExecutionConflict(ValueError):
    pass


def _acquire_rule_lock(session: Session, rule_id: str):
    bind = session.get_bind()
    if bind.dialect.name != "mysql":
        return None
    connection = bind.connect()
    try:
        acquired = connection.scalar(
            text("SELECT GET_LOCK(:lock_name, 0)"),
            {"lock_name": f"sentinel:rule:{rule_id}"},
        )
    except Exception:
        connection.close()
        raise
    if acquired != 1:
        connection.close()
        return False
    return connection


def _release_rule_lock(lock, rule_id: str) -> None:
    if lock is None or lock is False:
        return
    try:
        lock.execute(
            text("SELECT RELEASE_LOCK(:lock_name)"),
            {"lock_name": f"sentinel:rule:{rule_id}"},
        )
    finally:
        lock.close()


def _password(rule: Rule, settings: Settings) -> str:
    encrypted = rule.dataset.datasource.password_encrypted
    return CredentialCipher(settings.datasource_encryption_key).decrypt(encrypted) if encrypted else ""


def _message(record: AnomalyRecord) -> str:
    return (
        f"【Sentinel 数据异常】{record.rule_name}\n"
        f"严重程度：{record.severity}\n"
        f"数据集：{record.dataset_name}\n"
        f"异常主键：{record.business_key}\n"
        f"检出时间：{record.first_seen_at:%Y-%m-%d %H:%M:%S}\n"
        f"异常明细：{record.row_details}"
    )


def deliver_notifications(session: Session, settings: Settings, delivery_ids: list[str] | None = None, rule_id: str | None = None) -> int:
    query = select(NotificationDelivery, AnomalyRecord).join(
        AnomalyRecord, NotificationDelivery.anomaly_id == AnomalyRecord.id
    ).where(
        NotificationDelivery.status.in_(["pending", "failed"]),
        AnomalyRecord.status.in_(["pending", "processing"]),
    )
    if delivery_ids is not None:
        if not delivery_ids:
            return 0
        query = query.where(NotificationDelivery.id.in_(delivery_ids))
    if rule_id is not None:
        query = query.where(AnomalyRecord.rule_id == rule_id)
    deliveries = list(session.execute(query))
    if not deliveries:
        return 0
    client = FeishuClient(
        settings.feishu_app_id,
        settings.feishu_app_secret,
        timeout=settings.feishu_http_timeout_seconds,
    )
    failures = 0
    try:
        for delivery, record in deliveries:
            for attempt in range(3):
                delivery.attempts += 1
                try:
                    delivery.message_id = feishu_gateway.send_configured_text(
                        settings.feishu_app_id,
                        settings.feishu_app_secret,
                        delivery.receive_id_type,
                        delivery.recipient,
                        _message(record),
                        client=client,
                        idempotency_key=delivery.id,
                    )
                    delivery.status = "sent"
                    delivery.last_error = None
                    break
                except Exception as exc:
                    delivery.status = "failed"
                    delivery.last_error = str(exc)[:2000]
                    if attempt < 2:
                        time.sleep((0.2, 0.5)[attempt])
            if delivery.status != "sent":
                failures += 1
        session.commit()
    finally:
        client.close()
    return failures


def execute_rule(session: Session, settings: Settings, rule_id: str, trigger_source: str) -> RuleRun:
    rule = session.get(Rule, rule_id)
    if not rule or rule.deleted_at:
        raise ValueError("规则不存在")
    lock = _acquire_rule_lock(session, rule_id)
    if lock is False:
        raise RuleExecutionConflict("该规则正在执行，请等待本次执行完成")
    try:
        run = RuleRun(rule_id=rule.id, trigger_source=trigger_source, status="running")
        session.add(run)
        session.commit()
        connection = None
        try:
            connection = connect_to_datasource(rule.dataset.datasource, _password(rule, settings))
            fields, rows = fetch_rule_rows(connection, rule.dataset.sql)
            field_types = {field["name"]: field["type"] for field in fields}
            matches = evaluate_rows(rows, rule.conditions, rule.logic, rule.anomaly_key_fields, field_types)
            persisted = persist_matches(session, rule, matches)
            run.status = "success"
            run.scanned_rows = len(rows)
            run.matched_rows = len(matches)
            run.new_anomalies = persisted.new_count
        except Exception as exc:
            session.rollback()
            run = session.get(RuleRun, run.id)
            run.status = "failed"
            run.error_message = str(exc)[:2000]
        finally:
            if connection:
                connection.close()
            run.finished_at = utcnow()
            session.commit()
        return run
    finally:
        _release_rule_lock(lock, rule_id)
