from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def new_id() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    """Return naive UTC for MySQL DATETIME without deprecated datetime.utcnow()."""
    return datetime.now(UTC).replace(tzinfo=None)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class User(Base, TimestampMixin):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    username: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    is_superuser: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class Datasource(Base, TimestampMixin):
    __tablename__ = "datasources"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(150), unique=True, nullable=False)
    type: Mapped[str] = mapped_column(String(30), nullable=False)
    host: Mapped[str] = mapped_column(String(255), nullable=False)
    port: Mapped[int] = mapped_column(Integer, nullable=False)
    database: Mapped[str] = mapped_column(String(150), nullable=False)
    username: Mapped[str] = mapped_column(String(150), nullable=False)
    password_encrypted: Mapped[str] = mapped_column(Text, default="", nullable=False)
    ssl: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[str] = mapped_column(String(30), default="offline", nullable=False)
    last_checked: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    datasets: Mapped[list[Dataset]] = relationship(back_populates="datasource")


class Dataset(Base, TimestampMixin):
    __tablename__ = "datasets"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(150), unique=True, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    datasource_id: Mapped[str] = mapped_column(ForeignKey("datasources.id"), nullable=False)
    sql: Mapped[str] = mapped_column(Text, nullable=False)
    fields: Mapped[list[dict]] = mapped_column(JSON, default=list, nullable=False)
    row_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    datasource: Mapped[Datasource] = relationship(back_populates="datasets")
    rules: Mapped[list[Rule]] = relationship(back_populates="dataset")


class Rule(Base, TimestampMixin):
    __tablename__ = "rules"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(150), unique=True, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), nullable=False)
    severity: Mapped[str] = mapped_column(String(20), default="medium", nullable=False)
    logic: Mapped[str] = mapped_column(String(3), default="AND", nullable=False)
    conditions: Mapped[list[dict]] = mapped_column(JSON, nullable=False)
    anomaly_key_fields: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    schedule: Mapped[dict] = mapped_column(JSON, nullable=False)
    notification_targets: Mapped[list[dict]] = mapped_column(JSON, nullable=False)
    validation_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    validation_targets: Mapped[list[dict]] = mapped_column(
        JSON,
        default=list,
        nullable=False,
        server_default=text("('[]')"),
    )
    validation_timeout_minutes: Mapped[int] = mapped_column(Integer, default=1440, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sync_status: Mapped[str] = mapped_column(String(30), default="pending", nullable=False)
    sync_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    ds_workflow_code: Mapped[str | None] = mapped_column(String(50), nullable=True)
    ds_schedule_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    dataset: Mapped[Dataset] = relationship(back_populates="rules")


class RuleRun(Base):
    __tablename__ = "rule_runs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    rule_id: Mapped[str] = mapped_column(ForeignKey("rules.id"), nullable=False)
    trigger_source: Mapped[str] = mapped_column(String(30), nullable=False)
    status: Mapped[str] = mapped_column(String(30), default="running", nullable=False)
    scanned_rows: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    matched_rows: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    new_anomalies: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class AnomalyRecord(Base):
    __tablename__ = "anomaly_records"
    __table_args__ = (
        UniqueConstraint("rule_id", "active_fingerprint", name="uq_active_anomaly"),
        Index("ix_anomaly_records_status_deadline", "status", "validation_deadline"),
        Index("ix_anomaly_records_first_seen_id", "first_seen_at", "id"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    rule_id: Mapped[str] = mapped_column(ForeignKey("rules.id"), nullable=False)
    rule_name: Mapped[str] = mapped_column(String(150), nullable=False)
    dataset_name: Mapped[str] = mapped_column(String(150), nullable=False)
    severity: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    active_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)
    business_key: Mapped[dict] = mapped_column(JSON, nullable=False)
    row_details: Mapped[dict] = mapped_column(JSON, nullable=False)
    matched_conditions: Mapped[list[dict]] = mapped_column(JSON, nullable=False)
    hit_count: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    validation_deadline: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    timed_out_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    resolution_source: Mapped[str | None] = mapped_column(String(30), nullable=True)
    resolved_by_user_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    assignee: Mapped[str | None] = mapped_column(String(100), nullable=True)


class AnomalyEvent(Base):
    __tablename__ = "anomaly_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    anomaly_id: Mapped[str] = mapped_column(ForeignKey("anomaly_records.id"), nullable=False)
    event_type: Mapped[str] = mapped_column(String(30), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class NotificationDelivery(Base):
    __tablename__ = "notification_deliveries"
    __table_args__ = (UniqueConstraint("anomaly_id", "receive_id_type", "recipient", name="uq_delivery_target"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    anomaly_id: Mapped[str] = mapped_column(ForeignKey("anomaly_records.id"), nullable=False)
    receive_id_type: Mapped[str] = mapped_column(String(20), nullable=False)
    recipient: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    message_id: Mapped[str | None] = mapped_column(String(150), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class AnomalyValidationRequest(Base, TimestampMixin):
    __tablename__ = "anomaly_validation_requests"
    __table_args__ = (
        UniqueConstraint("anomaly_id", "recipient_user_id", name="uq_validation_request_recipient"),
        Index("ix_validation_requests_delivery_status_updated", "delivery_status", "updated_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    anomaly_id: Mapped[str] = mapped_column(ForeignKey("anomaly_records.id"), nullable=False)
    recipient_user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    delivery_status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    delivery_attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    message_id: Mapped[str | None] = mapped_column(String(150), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    send_started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class AnomalyValidationSubmission(Base):
    __tablename__ = "anomaly_validation_submissions"
    __table_args__ = (UniqueConstraint("anomaly_id", name="uq_validation_submission_anomaly"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    anomaly_id: Mapped[str] = mapped_column(ForeignKey("anomaly_records.id"), nullable=False)
    request_id: Mapped[str] = mapped_column(ForeignKey("anomaly_validation_requests.id"), nullable=False)
    submitted_by_user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    submitted_text: Mapped[str] = mapped_column(Text, nullable=False)
    validator_type: Mapped[str] = mapped_column(String(30), default="pseudo", nullable=False)
    result: Mapped[str] = mapped_column(String(30), default="passed", nullable=False)
    submitted_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
