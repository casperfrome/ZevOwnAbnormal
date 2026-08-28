"""Start a snapshotted deadline only after a confirmed individual delivery."""
from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .models import AnomalyRecord


def start_deadline(session: Session, anomaly_id: str, delivered_at: datetime) -> bool:
    seconds = session.scalar(select(AnomalyRecord.deadline_seconds_snapshot).where(
        AnomalyRecord.id == anomaly_id))
    if seconds is None:
        return False  # Historical records must never acquire a new deadline.
    result = session.execute(update(AnomalyRecord).where(
        AnomalyRecord.id == anomaly_id,
        AnomalyRecord.first_delivered_at.is_(None),
        AnomalyRecord.validation_deadline.is_(None),
        AnomalyRecord.status.in_(["pending", "processing"]),
    ).values(
        first_delivered_at=delivered_at,
        validation_deadline=delivered_at + timedelta(seconds=seconds),
        validation_result_version=AnomalyRecord.validation_result_version + 1,
    ).execution_options(synchronize_session="fetch"))
    return result.rowcount == 1
