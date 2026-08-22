from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import (
    AnomalyEvent,
    AnomalyPushJob,
    AnomalyPushPipelineState,
    AnomalyRecord,
    AnomalyValidationRequest,
    NotificationDelivery,
    Rule,
    utcnow,
)
from .rule_engine import EvaluationMatch
from .validation_service import snapshot_validation


@dataclass(frozen=True)
class PersistResult:
    new_count: int
    delivery_ids: list[str]
    records: list[AnomalyRecord]


def _json_value(value: Any) -> Any:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    return value


def fingerprint_business_key(business_key: dict[str, Any]) -> str:
    canonical = json.dumps(_json_value(business_key), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def resolve_targets(targets: list[dict], row: dict[str, Any]) -> list[tuple[str, str]]:
    resolved: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for target in targets:
        value = target.get("value") if target.get("source") == "literal" else row.get(target.get("field", ""))
        if value is None or str(value).strip() == "":
            continue
        item = (target["receive_id_type"], str(value).strip())
        if item not in seen:
            resolved.append(item)
            seen.add(item)
    return resolved


def persist_matches(session: Session, rule: Rule, matches: list[EvaluationMatch]) -> PersistResult:
    now = utcnow()
    # Serialize generation assignment with the abort transaction. If an abort
    # already owns the singleton row this waits and observes the new generation;
    # if we own it first, abort waits until the anomaly and its jobs commit.
    pipeline = session.scalar(
        select(AnomalyPushPipelineState)
        .where(AnomalyPushPipelineState.id == 1)
        .with_for_update()
    )
    if pipeline is None:
        pipeline = AnomalyPushPipelineState(id=1, generation=1)
        session.add(pipeline)
        session.flush()
    new_count = 0
    delivery_ids: list[str] = []
    affected: list[AnomalyRecord] = []
    for match in matches:
        fingerprint = fingerprint_business_key(match.business_key)
        existing = session.scalar(
            select(AnomalyRecord).where(
                AnomalyRecord.rule_id == rule.id,
                AnomalyRecord.active_fingerprint == fingerprint,
            )
        )
        if existing:
            existing.hit_count += 1
            existing.last_seen_at = now
            existing.row_details = _json_value(match.row)
            existing.matched_conditions = _json_value(match.matched_conditions)
            affected.append(existing)
            continue
        record = AnomalyRecord(
            rule_id=rule.id,
            rule_name=rule.name,
            dataset_name=rule.dataset.name,
            severity=rule.severity,
            fingerprint=fingerprint,
            active_fingerprint=fingerprint,
            business_key=_json_value(match.business_key),
            row_details=_json_value(match.row),
            matched_conditions=_json_value(match.matched_conditions),
            first_seen_at=now,
            last_seen_at=now,
        )
        session.add(record)
        session.flush()
        session.add(AnomalyEvent(anomaly_id=record.id, event_type="detected", description="规则首次检出异常"))
        validation_recipients = set(snapshot_validation(session, rule, record, now=now))
        validation_requests = list(session.scalars(select(AnomalyValidationRequest).where(
            AnomalyValidationRequest.anomaly_id == record.id,
        )))
        for request in validation_requests:
            session.add(AnomalyPushJob(
                anomaly_id=record.id,
                kind="validation",
                delivery_id=request.id,
                generation=pipeline.generation,
            ))
        for receive_id_type, recipient in resolve_targets(rule.notification_targets, match.row):
            if receive_id_type == "user_id" and recipient in validation_recipients:
                continue
            delivery = NotificationDelivery(
                anomaly_id=record.id,
                receive_id_type=receive_id_type,
                recipient=recipient,
            )
            session.add(delivery)
            session.flush()
            session.add(AnomalyPushJob(
                anomaly_id=record.id,
                kind="notification",
                delivery_id=delivery.id,
                generation=pipeline.generation,
            ))
            delivery_ids.append(delivery.id)
        new_count += 1
        affected.append(record)
    session.commit()
    return PersistResult(new_count=new_count, delivery_ids=delivery_ids, records=affected)
