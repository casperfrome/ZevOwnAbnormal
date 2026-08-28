from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import and_, or_, select, tuple_
from sqlalchemy.orm import Session

from .anomaly_group_service import (
    GroupWebhookDeliveryUncertainError,
    deliver_group_broadcasts,
)
from .config import Settings
from .execution_service import deliver_notifications
from .models import (
    AnomalyEvent,
    AnomalyGroupBroadcastDelivery,
    AnomalyPushJob,
    AnomalyPushPipelineState,
    AnomalyRecord,
    AnomalyRecordGroupMember,
    AnomalyValidationRequest,
    NotificationDelivery,
    utcnow,
)
from .validation_service import _eligible_delivery_predicate, deliver_validation_requests


logger = logging.getLogger(__name__)
MESSAGE_VERSION = 1
TERMINAL_JOB_STATUSES = {"sent", "failed", "uncertain", "aborted"}
MAX_NOTIFICATION_DELIVERY_ATTEMPTS = 6
MAX_GROUP_BROADCAST_DELIVERY_ATTEMPTS = 6
DISPATCH_LEASE = timedelta(seconds=30)
DS_CALLBACK_LEASE = timedelta(minutes=10)
DELIVERED_VALIDATION_STATUSES = {"sent", "resolved", "timed_out", "update_failed"}


def in_transit_anomaly_ids(session: Session):
    """Shared by the overview, list/export and administrative clear operation."""
    pipeline = session.get(AnomalyPushPipelineState, 1)
    query = select(AnomalyPushJob.anomaly_id).outerjoin(
        NotificationDelivery, and_(AnomalyPushJob.kind == "notification",
                                    NotificationDelivery.id == AnomalyPushJob.delivery_id),
    ).outerjoin(
        AnomalyValidationRequest, and_(AnomalyPushJob.kind == "validation",
                                       AnomalyValidationRequest.id == AnomalyPushJob.delivery_id),
    )
    if pipeline is None:
        return query.where(AnomalyPushJob.id.is_(None))
    return query.where(
        AnomalyPushJob.generation == pipeline.generation,
        AnomalyPushJob.cancel_requested.is_(False),
        AnomalyPushJob.status.not_in(["sent", "aborted"]),
        or_(
            and_(AnomalyPushJob.kind == "notification",
                 NotificationDelivery.status.in_(["pending", "failed", "sending", "uncertain"])),
            and_(AnomalyPushJob.kind == "validation",
                 AnomalyValidationRequest.delivery_status.in_(["pending", "failed", "sending", "uncertain"])),
        ),
    ).distinct()


def cancel_record_pushes(session: Session, anomaly_ids: list[str]) -> int:
    """Cancel this snapshot only; the caller owns the resolution transaction."""
    if not anomaly_ids:
        return 0
    groups = select(AnomalyRecordGroupMember.rule_id, AnomalyRecordGroupMember.detected_at).where(
        AnomalyRecordGroupMember.anomaly_id.in_(anomaly_ids),
    )
    broadcasts = list(session.scalars(select(AnomalyGroupBroadcastDelivery).where(
        tuple_(AnomalyGroupBroadcastDelivery.rule_id, AnomalyGroupBroadcastDelivery.detected_at).in_(groups),
    )))
    jobs = list(session.scalars(select(AnomalyPushJob).where(
        or_(AnomalyPushJob.anomaly_id.in_(anomaly_ids), and_(
            AnomalyPushJob.kind == "group_broadcast",
            AnomalyPushJob.delivery_id.in_([item.id for item in broadcasts]),
        )),
        AnomalyPushJob.status.not_in(["sent", "aborted"]),
    ).order_by(AnomalyPushJob.id).with_for_update().execution_options(populate_existing=True)))
    cancelled = 0
    for job in jobs:
        if job.cancel_requested:
            continue
        if _completed_job_status(session, job) == "sent":
            continue
        job.cancel_requested = True
        job.next_attempt_at = None
        job.last_error = "管理员清除在途推送，已取消后续发送及重试"
        # Allow an already running HTTP request to report its actual outcome.
        if job.status not in {"executing", "sending"}:
            _cancel_job_if_requested(session, job)
        cancelled += 1
    deliveries = list(session.scalars(select(NotificationDelivery).where(
        NotificationDelivery.anomaly_id.in_(anomaly_ids),
    ).with_for_update().execution_options(populate_existing=True)))
    requests = list(session.scalars(select(AnomalyValidationRequest).where(
        AnomalyValidationRequest.anomaly_id.in_(anomaly_ids),
    ).with_for_update().execution_options(populate_existing=True)))
    # Lock/reload after jobs: send callbacks use the same job -> delivery order.
    broadcasts = list(session.scalars(select(AnomalyGroupBroadcastDelivery).where(
        AnomalyGroupBroadcastDelivery.id.in_([item.id for item in broadcasts]),
    ).with_for_update().execution_options(populate_existing=True)))
    for delivery in [*deliveries, *requests, *broadcasts]:
        status_attr = "delivery_status" if isinstance(delivery, AnomalyValidationRequest) else "status"
        if getattr(delivery, status_attr) in {"pending", "failed"}:
            setattr(delivery, status_attr, "aborted")
            delivery.last_error = "管理员清除在途推送，已取消后续发送及重试"
        if getattr(delivery, status_attr) in {"aborted", "sending", "uncertain"} and hasattr(delivery, "next_attempt_at"):
            delivery.next_attempt_at = None
    for anomaly_id in anomaly_ids:
        session.add(AnomalyEvent(anomaly_id=anomaly_id, event_type="push_aborted",
                                description="管理员清除在途推送，已取消记录及所在组的待发送推送"))
    return cancelled


def _message(job: AnomalyPushJob) -> dict[str, Any]:
    return {
        "version": MESSAGE_VERSION,
        "job_id": job.id,
        "generation": job.generation,
        "kind": job.kind,
    }


def publish_pending_jobs(
    session: Session,
    settings: Settings,
    kafka,
    *,
    limit: int = 50,
) -> int:
    job_ids = list(session.scalars(
        select(AnomalyPushJob.id)
        .where(AnomalyPushJob.status == "pending_publish")
        .order_by(AnomalyPushJob.created_at, AnomalyPushJob.id)
        .limit(limit)
    ))
    session.commit()
    published = 0
    for job_id in job_ids:
        pipeline = session.scalar(
            select(AnomalyPushPipelineState)
            .where(AnomalyPushPipelineState.id == 1)
            .with_for_update()
        )
        job = session.scalar(
            select(AnomalyPushJob).where(AnomalyPushJob.id == job_id).with_for_update()
        )
        if (
            pipeline is None
            or pipeline.abort_in_progress
            or job is None
            or job.status != "pending_publish"
            or job.generation != pipeline.generation
            or job.cancel_requested
        ):
            session.commit()
            continue
        job.publish_attempts += 1
        job.status = "publishing"
        event = _message(job)
        key = job.id
        session.commit()
        try:
            partition, offset = kafka.publish(event, key)
        except Exception as exc:
            job = session.scalar(
                select(AnomalyPushJob).where(AnomalyPushJob.id == job_id).with_for_update().execution_options(populate_existing=True)
            )
            if _cancel_job_if_requested(session, job):
                session.commit()
                continue
            job.status = "pending_publish"
            job.last_error = str(exc)[:2000]
            session.commit()
            continue
        job = session.scalar(
            select(AnomalyPushJob).where(AnomalyPushJob.id == job_id).with_for_update().execution_options(populate_existing=True)
        )
        if _cancel_job_if_requested(session, job):
            session.commit()
            continue
        job.status = "kafka_queued"
        job.kafka_partition = partition
        job.kafka_offset = offset
        job.last_error = None
        job.next_attempt_at = None
        session.commit()
        published += 1
    return published


def queue_due_validation_push_jobs(
    session: Session,
    *,
    limit: int = 50,
    now: datetime | None = None,
) -> int:
    scan_time = now or utcnow()
    pipeline = session.scalar(
        select(AnomalyPushPipelineState)
        .where(AnomalyPushPipelineState.id == 1)
        .with_for_update()
    )
    if pipeline is None:
        pipeline = AnomalyPushPipelineState(id=1, generation=1)
        session.add(pipeline)
        session.flush()
    if pipeline.abort_in_progress:
        session.commit()
        return 0
    requests = list(session.scalars(
        select(AnomalyValidationRequest)
        .where(_eligible_delivery_predicate(scan_time))
        .order_by(AnomalyValidationRequest.updated_at, AnomalyValidationRequest.id)
        .limit(limit)
    ))
    queued = 0
    for request in requests:
        job = session.scalar(select(AnomalyPushJob).where(
            AnomalyPushJob.kind == "validation",
            AnomalyPushJob.delivery_id == request.id,
        ))
        if job is None:
            session.add(AnomalyPushJob(
                anomaly_id=request.anomaly_id,
                kind="validation",
                delivery_id=request.id,
                generation=pipeline.generation,
            ))
            queued += 1
        elif (
            job.status == "failed"
            and not job.cancel_requested
            and (job.next_attempt_at is None or job.next_attempt_at <= scan_time)
        ):
            job.status = "pending_publish"
            job.generation = pipeline.generation
            job.last_error = None
            queued += 1
    session.commit()
    return queued


def queue_due_notification_push_jobs(
    session: Session,
    *,
    limit: int = 50,
) -> int:
    pipeline = session.scalar(
        select(AnomalyPushPipelineState)
        .where(AnomalyPushPipelineState.id == 1)
        .with_for_update()
    )
    if pipeline is None:
        pipeline = AnomalyPushPipelineState(id=1, generation=1)
        session.add(pipeline)
        session.flush()
    if pipeline.abort_in_progress:
        session.commit()
        return 0
    deliveries = list(session.scalars(
        select(NotificationDelivery)
        .join(AnomalyRecord, NotificationDelivery.anomaly_id == AnomalyRecord.id)
        .where(
            NotificationDelivery.status.in_(["pending", "failed"]),
            NotificationDelivery.attempts < MAX_NOTIFICATION_DELIVERY_ATTEMPTS,
            AnomalyRecord.status.in_(["pending", "processing", "timed_out"]),
        )
        .order_by(NotificationDelivery.updated_at, NotificationDelivery.id)
        .limit(limit)
    ))
    queued = 0
    for delivery in deliveries:
        job = session.scalar(select(AnomalyPushJob).where(
            AnomalyPushJob.kind == "notification",
            AnomalyPushJob.delivery_id == delivery.id,
        ))
        if job is None:
            session.add(AnomalyPushJob(
                anomaly_id=delivery.anomaly_id,
                kind="notification",
                delivery_id=delivery.id,
                generation=pipeline.generation,
            ))
            queued += 1
        elif (
            job.status == "failed"
            and not job.cancel_requested
            and (job.next_attempt_at is None or job.next_attempt_at <= utcnow())
        ):
            job.status = "pending_publish"
            job.generation = pipeline.generation
            job.last_error = None
            queued += 1
    session.commit()
    return queued


def queue_due_group_broadcast_push_jobs(
    session: Session,
    *,
    limit: int = 50,
    now: datetime | None = None,
) -> int:
    scan_time = now or utcnow()
    pipeline = session.scalar(
        select(AnomalyPushPipelineState)
        .where(AnomalyPushPipelineState.id == 1)
        .with_for_update()
    )
    if pipeline is None:
        pipeline = AnomalyPushPipelineState(id=1, generation=1)
        session.add(pipeline)
        session.flush()
    if pipeline.abort_in_progress:
        session.commit()
        return 0
    deliveries = list(session.scalars(
        select(AnomalyGroupBroadcastDelivery)
        .where(
            AnomalyGroupBroadcastDelivery.status.in_(["pending", "failed"]),
            AnomalyGroupBroadcastDelivery.attempts < MAX_GROUP_BROADCAST_DELIVERY_ATTEMPTS,
        )
        .order_by(AnomalyGroupBroadcastDelivery.updated_at, AnomalyGroupBroadcastDelivery.id)
        .limit(limit)
    ))
    queued = 0
    for delivery in deliveries:
        job = session.scalar(select(AnomalyPushJob).where(
            AnomalyPushJob.kind == "group_broadcast",
            AnomalyPushJob.delivery_id == delivery.id,
        ))
        if job is None:
            session.add(AnomalyPushJob(
                anomaly_id=None,
                kind="group_broadcast",
                delivery_id=delivery.id,
                generation=pipeline.generation,
            ))
            queued += 1
        elif (
            job.status == "failed"
            and not job.cancel_requested
            and (job.next_attempt_at is None or job.next_attempt_at <= scan_time)
        ):
            job.status = "pending_publish"
            job.generation = pipeline.generation
            job.last_error = None
            queued += 1
    session.commit()
    return queued


def recover_failed_push_jobs(
    session: Session,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    scan_time = now or utcnow()
    pipeline = session.get(AnomalyPushPipelineState, 1)
    failed_jobs = list(session.scalars(
        select(AnomalyPushJob)
        .where(AnomalyPushJob.status == "failed")
        .order_by(AnomalyPushJob.updated_at, AnomalyPushJob.id)
        .with_for_update()
    ))
    counts = {"notification": 0, "validation": 0, "group_broadcast": 0}
    if pipeline is None or pipeline.abort_in_progress:
        session.commit()
        return {
            "requeued_jobs": 0,
            "requeued_by_kind": counts,
            "skipped_jobs": len(failed_jobs),
        }

    for job in failed_jobs:
        if (
            job.generation != pipeline.generation
            or job.cancel_requested
            or (job.next_attempt_at is not None and job.next_attempt_at > scan_time)
        ):
            continue
        retryable = False
        if job.kind == "notification":
            delivery = session.get(NotificationDelivery, job.delivery_id)
            anomaly = session.get(AnomalyRecord, job.anomaly_id) if job.anomaly_id else None
            retryable = bool(
                delivery is not None
                and delivery.status in {"pending", "failed"}
                and delivery.attempts < MAX_NOTIFICATION_DELIVERY_ATTEMPTS
                and anomaly is not None
                and anomaly.status in {"pending", "processing", "timed_out"}
            )
        elif job.kind == "validation":
            request = session.get(AnomalyValidationRequest, job.delivery_id)
            anomaly = session.get(AnomalyRecord, job.anomaly_id) if job.anomaly_id else None
            retryable = bool(
                request is not None
                and request.delivery_status in {"pending", "failed"}
                and (request.next_attempt_at is None or request.next_attempt_at <= scan_time)
                and anomaly is not None
                and anomaly.status in {"pending", "processing", "timed_out"}
            )
        elif job.kind == "group_broadcast":
            delivery = session.get(AnomalyGroupBroadcastDelivery, job.delivery_id)
            retryable = bool(
                delivery is not None
                and delivery.status in {"pending", "failed"}
                and delivery.attempts < MAX_GROUP_BROADCAST_DELIVERY_ATTEMPTS
                and (delivery.next_attempt_at is None or delivery.next_attempt_at <= scan_time)
            )
        if not retryable:
            continue
        job.status = "pending_publish"
        job.last_error = None
        job.next_attempt_at = None
        counts[job.kind] += 1

    requeued = sum(counts.values())
    session.commit()
    return {
        "requeued_jobs": requeued,
        "requeued_by_kind": counts,
        "skipped_jobs": len(failed_jobs) - requeued,
    }


def _unpack_message(message):
    if isinstance(message, tuple):
        return message[0]
    return message.event


def _job_delivery_status(session: Session, job: AnomalyPushJob) -> str | None:
    if job.kind == "notification":
        delivery = session.get(NotificationDelivery, job.delivery_id, populate_existing=True, with_for_update=True)
        return delivery.status if delivery is not None else None
    if job.kind == "validation":
        request = session.get(AnomalyValidationRequest, job.delivery_id, populate_existing=True, with_for_update=True)
        return request.delivery_status if request is not None else None
    if job.kind == "group_broadcast":
        delivery = session.get(AnomalyGroupBroadcastDelivery, job.delivery_id, populate_existing=True, with_for_update=True)
        return delivery.status if delivery is not None else None
    return None


def _completed_job_status(session: Session, job: AnomalyPushJob) -> str | None:
    delivery_status = _job_delivery_status(session, job)
    if delivery_status == "uncertain":
        return "uncertain"
    if job.kind == "notification" and delivery_status == "sent":
        return "sent"
    if job.kind == "validation" and delivery_status in DELIVERED_VALIDATION_STATUSES:
        return "sent"
    if job.kind == "group_broadcast" and delivery_status in {"sent", "uncertain"}:
        return delivery_status
    return "aborted" if delivery_status == "aborted" else None


def _reconcile_job(session: Session, job: AnomalyPushJob) -> bool:
    completed_status = _completed_job_status(session, job)
    if completed_status is None:
        return False
    job.status = completed_status
    if completed_status == "sent":
        job.last_error = None
    elif completed_status == "aborted":
        job.last_error = "投递已中止"
    job.next_attempt_at = None
    return True


def _cancel_job_if_requested(session: Session, job: AnomalyPushJob) -> bool:
    if not job.cancel_requested:
        return False
    _abort_delivery(session, job)
    session.flush()
    delivery_status = _job_delivery_status(session, job)
    job.status = (_completed_job_status(session, job) or
                  ("uncertain" if delivery_status == "uncertain" else "aborted"))
    job.next_attempt_at = None
    if job.status == "sent":
        job.last_error = None
    else:
        job.last_error = "推送已取消，不再发送或重试"
    return True


def reconcile_completed_push_jobs(session: Session, *, limit: int = 50) -> int:
    pipeline = session.get(AnomalyPushPipelineState, 1)
    if pipeline is None:
        return 0
    jobs = list(session.scalars(
        select(AnomalyPushJob).where(
            AnomalyPushJob.generation == pipeline.generation,
            AnomalyPushJob.cancel_requested.is_(False),
            AnomalyPushJob.status.not_in(["sent", "uncertain", "aborted"]),
        ).order_by(AnomalyPushJob.updated_at, AnomalyPushJob.id).limit(limit)
        .with_for_update().execution_options(populate_existing=True)
    ))
    reconciled = sum(_reconcile_job(session, job) for job in jobs)
    session.commit()
    return reconciled


def _schedule_dispatch_retry(job: AnomalyPushJob) -> None:
    delay = min(2 ** max(job.dispatch_attempts, 1), 300)
    job.next_attempt_at = utcnow() + timedelta(seconds=delay)


def consume_one(
    session: Session,
    settings: Settings,
    kafka,
    scheduler,
    *,
    timeout: float = 1.0,
) -> str:
    message = kafka.poll(timeout)
    if message is None:
        return "empty"
    event = _unpack_message(message)
    job_id = event.get("job_id") if isinstance(event, dict) else None
    pipeline = session.scalar(
        select(AnomalyPushPipelineState)
        .where(AnomalyPushPipelineState.id == 1)
        .with_for_update()
    )
    job = session.scalar(
        select(AnomalyPushJob).where(AnomalyPushJob.id == job_id).with_for_update()
    ) if job_id else None
    if not isinstance(event, dict) or event.get("version") != MESSAGE_VERSION or job is None:
        if job is not None:
            job.status = "failed"
            job.last_error = "不支持的 Kafka 异常推送消息"
            session.commit()
        session.commit()
        kafka.commit(message)
        return "invalid"
    if (
        job.generation != event.get("generation")
        or job.cancel_requested
        or job.kind != event.get("kind")
        or job.status in {"ds_scheduled", "executing", "sending", "sent", "failed", "aborted"}
        or (pipeline is not None and job.generation != pipeline.generation)
    ):
        session.commit()
        kafka.commit(message)
        return "duplicate"
    if pipeline is not None and pipeline.abort_in_progress:
        session.commit()
        return "paused"
    if job.status in {"publishing", "dispatching"}:
        session.commit()
        kafka.seek(message)
        return "in_progress"
    if job.status != "kafka_queued":
        session.commit()
        kafka.commit(message)
        return "duplicate"
    if _reconcile_job(session, job):
        session.commit()
        kafka.commit(message)
        return "reconciled"
    job.dispatch_attempts += 1
    job.status = "dispatching"
    session.commit()
    try:
        scheduler.start_push_job(job.id)
    except Exception as exc:
        job = session.scalar(
            select(AnomalyPushJob).where(AnomalyPushJob.id == job_id).with_for_update().execution_options(populate_existing=True)
        )
        if _cancel_job_if_requested(session, job):
            session.commit()
            kafka.commit(message)
            return "aborted"
        # Commit the consumed record and let the durable outbox retry after a
        # bounded delay, preventing a failing scheduler from amplifying Kafka lag.
        job.status = "failed"
        job.last_error = str(exc)[:2000]
        _schedule_dispatch_retry(job)
        session.commit()
        kafka.commit(message)
        return "dispatch_failed"
    job = session.scalar(
        select(AnomalyPushJob).where(AnomalyPushJob.id == job_id).with_for_update().execution_options(populate_existing=True)
    )
    if _cancel_job_if_requested(session, job):
        session.commit()
        kafka.commit(message)
        return "aborted"
    job.status = "ds_scheduled"
    job.last_error = None
    session.commit()
    kafka.commit(message)
    return "scheduled"


def requeue_stale_push_jobs(
    session: Session,
    settings: Settings,
    *,
    now: datetime | None = None,
    limit: int = 50,
) -> int:
    """Recover callbacks whose process died after durably claiming a send."""
    scan_time = now or utcnow()
    send_stale_before = scan_time - timedelta(
        seconds=settings.feishu_http_timeout_seconds * 3 + 2,
    )
    dispatch_stale_before = scan_time - DISPATCH_LEASE
    scheduled_stale_before = scan_time - DS_CALLBACK_LEASE
    pipeline = session.scalar(
        select(AnomalyPushPipelineState)
        .where(AnomalyPushPipelineState.id == 1)
        .with_for_update()
    )
    if pipeline is None or pipeline.abort_in_progress:
        session.commit()
        return 0
    jobs = list(session.scalars(
        select(AnomalyPushJob)
        .where(
            or_(
                and_(
                    AnomalyPushJob.status.in_(["executing", "sending"]),
                    AnomalyPushJob.updated_at <= send_stale_before,
                ),
                and_(
                    AnomalyPushJob.status.in_(["publishing", "dispatching"]),
                    AnomalyPushJob.updated_at <= dispatch_stale_before,
                ),
                and_(
                    AnomalyPushJob.status == "ds_scheduled",
                    AnomalyPushJob.updated_at <= scheduled_stale_before,
                ),
            ),
        )
        .order_by(AnomalyPushJob.updated_at, AnomalyPushJob.id)
        .limit(limit)
        .with_for_update()
    ))
    recovered = 0
    for job in jobs:
        if job.cancel_requested:
            _cancel_job_if_requested(session, job)
        elif job.generation != pipeline.generation:
            job.status = "aborted"
            job.last_error = "过期的推送执行属于已中止批次"
            _abort_delivery(session, job)
        elif job.status == "publishing":
            job.status = "pending_publish"
            job.last_error = "检测到过期 Kafka 发布认领，已重新排队"
        elif job.status == "dispatching":
            job.status = "kafka_queued"
            job.last_error = "检测到过期 DolphinScheduler 启动认领，等待 Kafka 重投"
        elif job.status == "ds_scheduled":
            job.status = "pending_publish"
            job.last_error = "DolphinScheduler 回调租约过期，已重新排队"
        else:
            delivery_status = _job_delivery_status(session, job)
            completed_status = _completed_job_status(session, job)
            if completed_status is not None:
                job.status = completed_status
                job.last_error = None
            elif delivery_status == "aborted":
                job.status = "aborted"
                job.last_error = "投递已中止"
            elif job.kind == "validation" and delivery_status == "sending":
                # Validation delivery has its own long uncertainty/dedupe lease.
                # Leave the job retryable; the due-job scanner will only queue it
                # after that delivery becomes safe to claim again.
                job.status = "failed"
                job.last_error = "等待互动卡片发送结果确认后重试"
            elif job.kind in {"notification", "group_broadcast"} and delivery_status == "sending":
                model = NotificationDelivery if job.kind == "notification" else AnomalyGroupBroadcastDelivery
                delivery = session.get(model, job.delivery_id)
                if delivery is not None:
                    delivery.status = "uncertain"
                    if hasattr(delivery, "next_attempt_at"):
                        delivery.next_attempt_at = None
                    delivery.last_error = "发送租约过期，发送结果未知，已停止自动重试"
                job.status = "uncertain"
                job.next_attempt_at = None
                job.last_error = "发送结果未知，已停止自动重试"
            else:
                job.status = "pending_publish"
                job.last_error = "检测到过期发送租约，已重新排队"
        recovered += 1
    session.commit()
    return recovered


def _abort_delivery(session: Session, job: AnomalyPushJob) -> bool:
    if job.kind == "notification":
        delivery = session.get(NotificationDelivery, job.delivery_id, populate_existing=True, with_for_update=True)
        if delivery is not None and delivery.status in {"pending", "failed"}:
            delivery.status = "aborted"
            delivery.last_error = "推送已由管理员中止"
            return True
        if delivery is not None and delivery.status == "sending":
            delivery.status = "uncertain"
            delivery.last_error = "管理员中止时飞书发送结果未知，已停止自动重试"
    elif job.kind == "validation":
        request = session.get(AnomalyValidationRequest, job.delivery_id, populate_existing=True, with_for_update=True)
        if request is not None and request.delivery_status in {"pending", "failed"}:
            request.delivery_status = "aborted"
            request.next_attempt_at = None
            request.last_error = "推送已由管理员中止"
            return True
        if request is not None and request.delivery_status == "sending":
            request.delivery_status = "uncertain"
            request.next_attempt_at = None
            request.last_error = "管理员中止时飞书发送结果未知，已停止自动重试"
    elif job.kind == "group_broadcast":
        delivery = session.get(AnomalyGroupBroadcastDelivery, job.delivery_id, populate_existing=True, with_for_update=True)
        if delivery is not None and delivery.status in {"pending", "failed"}:
            delivery.status = "aborted"
            delivery.next_attempt_at = None
            delivery.last_error = "推送已由管理员中止"
            return True
        if delivery is not None and delivery.status == "sending":
            delivery.status = "uncertain"
            delivery.next_attempt_at = None
            delivery.last_error = "管理员中止时群机器人发送结果未知，已停止自动重试"
    return False


def _schedule_delivery_retry(session: Session, job: AnomalyPushJob) -> None:
    if job.kind == "notification":
        delivery = session.get(NotificationDelivery, job.delivery_id)
        attempts = delivery.attempts if delivery is not None else job.publish_attempts
    elif job.kind == "group_broadcast":
        delivery = session.get(AnomalyGroupBroadcastDelivery, job.delivery_id)
        attempts = delivery.attempts if delivery is not None else job.publish_attempts
    else:
        return
    delay = min(2 ** max(attempts, 1), 300)
    job.next_attempt_at = utcnow() + timedelta(seconds=delay)


def execute_push_job(session: Session, settings: Settings, job_id: str) -> str:
    job = session.scalar(
        select(AnomalyPushJob).where(AnomalyPushJob.id == job_id).with_for_update().execution_options(populate_existing=True)
    )
    if job is None:
        raise ValueError("异常推送任务不存在")
    if job.status in {"executing", "sending"}:
        return "already_in_progress"
    if job.status in TERMINAL_JOB_STATUSES:
        return "already_terminal" if job.status != "aborted" else "aborted"
    if _cancel_job_if_requested(session, job):
        session.commit()
        return "aborted"
    pipeline = session.get(AnomalyPushPipelineState, 1)
    if pipeline is None or pipeline.abort_in_progress or job.generation != pipeline.generation:
        job.status = "aborted"
        job.last_error = "推送任务所属批次已中止"
        _abort_delivery(session, job)
        session.commit()
        return "aborted"
    job.status = "sending"
    job.last_error = None
    session.commit()

    def should_stop():
        # A separate short read observes cancellation even under MySQL's
        # REPEATABLE READ isolation, without committing the sender's changes.
        with Session(bind=session.get_bind()) as reader:
            return reader.scalar(select(AnomalyPushJob.cancel_requested).where(
                AnomalyPushJob.id == job_id,
            )) is not False

    try:
        if job.kind == "notification":
            failures = deliver_notifications(
                session, settings, delivery_ids=[job.delivery_id], should_stop=should_stop,
            )
        elif job.kind == "validation":
            failures = deliver_validation_requests(
                session, settings, request_ids=[job.delivery_id], should_stop=should_stop,
            )
        elif job.kind == "group_broadcast":
            failures = deliver_group_broadcasts(
                session, settings, delivery_ids=[job.delivery_id], should_stop=should_stop,
            )
        else:
            raise ValueError(f"不支持的异常推送类型：{job.kind}")
    except GroupWebhookDeliveryUncertainError as exc:
        job = session.get(AnomalyPushJob, job_id, populate_existing=True, with_for_update=True)
        job.status = "uncertain"
        job.last_error = str(exc)[:2000]
        job.next_attempt_at = None
        session.commit()
        raise
    except Exception as exc:
        job = session.get(AnomalyPushJob, job_id, populate_existing=True, with_for_update=True)
        if not _cancel_job_if_requested(session, job):
            job.status = "failed"
            job.last_error = str(exc)[:2000]
            _schedule_delivery_retry(session, job)
        session.commit()
        raise
    job = session.get(AnomalyPushJob, job_id, populate_existing=True, with_for_update=True)
    delivery_status = _job_delivery_status(session, job)
    delivered = (
        delivery_status == "sent"
        if job.kind in {"notification", "group_broadcast"}
        else delivery_status in DELIVERED_VALIDATION_STATUSES
    )
    if job.cancel_requested:
        _cancel_job_if_requested(session, job)
        outcome = job.status
    elif not delivered:
        job.status = "failed"
        job.last_error = "飞书推送失败" if failures else "飞书投递尚未完成"
        _schedule_delivery_retry(session, job)
        outcome = "failed"
    else:
        job.status = "sent"
        job.last_error = None
        job.next_attempt_at = None
        outcome = "sent"
    session.commit()
    return outcome


def abort_pending_pushes(
    session: Session,
    settings: Settings,
    kafka_admin,
    scheduler,
    *,
    wait_seconds: float | None = None,
) -> dict[str, Any]:
    pipeline = session.scalar(
        select(AnomalyPushPipelineState).where(AnomalyPushPipelineState.id == 1).with_for_update()
    )
    if pipeline is None:
        pipeline = AnomalyPushPipelineState(id=1, generation=1)
        session.add(pipeline)
        session.flush()
    if pipeline.abort_in_progress:
        session.rollback()
        raise RuntimeError("已有中止推送操作正在执行")
    pipeline.abort_in_progress = True
    pipeline.generation += 1
    aborted_generation = pipeline.generation
    for active_job in session.scalars(select(AnomalyPushJob).where(
        AnomalyPushJob.generation < aborted_generation,
        AnomalyPushJob.status.in_([
            "pending_publish", "publishing", "kafka_queued", "dispatching",
            "ds_scheduled", "executing", "sending", "failed",
        ]),
    )):
        active_job.cancel_requested = True
    session.commit()

    max_wait = wait_seconds
    if max_wait is None:
        max_wait = max(settings.feishu_http_timeout_seconds * 3 + 2, 25)
    deadline = time.monotonic() + max_wait
    while time.monotonic() < deadline:
        session.expire_all()
        sending = session.scalar(select(AnomalyPushJob.id).where(
            AnomalyPushJob.generation < aborted_generation,
            AnomalyPushJob.status.in_(["publishing", "dispatching", "sending"]),
        ).limit(1))
        if sending is None:
            break
        time.sleep(0.1)

    in_flight_left = session.scalar(select(AnomalyPushJob.id).where(
        AnomalyPushJob.generation < aborted_generation,
        AnomalyPushJob.status.in_(["publishing", "dispatching", "sending"]),
    ).limit(1))
    jobs = list(session.scalars(select(AnomalyPushJob).where(
        AnomalyPushJob.generation < aborted_generation,
        AnomalyPushJob.status.in_([
            "pending_publish", "kafka_queued", "ds_scheduled", "executing", "failed",
        ]),
    )))
    notification_count = 0
    validation_count = 0
    group_broadcast_count = 0
    anomaly_ids: set[str] = set()
    for job in jobs:
        job.status = "aborted"
        job.last_error = "推送已由管理员中止"
        if _abort_delivery(session, job):
            if job.kind == "notification":
                notification_count += 1
            elif job.kind == "validation":
                validation_count += 1
            elif job.kind == "group_broadcast":
                group_broadcast_count += 1
        if job.anomaly_id is not None:
            anomaly_ids.add(job.anomaly_id)
    for anomaly_id in anomaly_ids:
        session.add(AnomalyEvent(
            anomaly_id=anomaly_id,
            event_type="push_aborted",
            description="未发送的异常推送已由管理员中止",
        ))
    session.commit()

    errors: list[dict[str, str]] = []
    if in_flight_left is not None:
        errors.append({"stage": "in_flight", "message": "仍有外部推送调用未在限定时间内落定"})
    stopped = deleted = cleared = 0
    try:
        stopped, deleted = scheduler.clear_push_instances()
    except Exception as exc:
        errors.append({"stage": "dolphinscheduler", "message": str(exc)[:500]})
    try:
        cleared = kafka_admin.clear_pending()
    except Exception as exc:
        errors.append({"stage": "kafka", "message": str(exc)[:500]})
    pipeline = session.get(AnomalyPushPipelineState, 1)
    pipeline.abort_in_progress = False
    session.commit()
    return {
        "status": "partial_failed" if errors else "completed",
        "aborted_jobs": len(jobs),
        "aborted_notifications": notification_count,
        "aborted_validations": validation_count,
        "aborted_group_broadcasts": group_broadcast_count,
        "stopped_ds_instances": stopped,
        "deleted_ds_instances": deleted,
        "cleared_kafka_partitions": cleared,
        "errors": errors,
    }


class ConfluentKafkaGateway:
    def __init__(self, settings: Settings):
        from confluent_kafka import Consumer, Producer
        from confluent_kafka.admin import AdminClient

        config = {"bootstrap.servers": settings.kafka_bootstrap_servers}
        self.bootstrap_servers = settings.kafka_bootstrap_servers
        self.topic = settings.kafka_anomaly_push_topic
        self._lock = threading.RLock()
        self.producer = Producer(config)
        self.admin = AdminClient(config)
        self.consumer = Consumer({
            **config,
            "group.id": settings.kafka_anomaly_push_group,
            "enable.auto.commit": False,
            "auto.offset.reset": "earliest",
        })
        self.consumer.subscribe([self.topic])

    def ensure_topic(self) -> None:
        from confluent_kafka.admin import NewTopic

        futures = self.admin.create_topics([
            NewTopic(self.topic, num_partitions=1, replication_factor=1),
        ])
        try:
            futures[self.topic].result()
        except Exception as exc:
            if "TOPIC_ALREADY_EXISTS" not in str(exc) and "already exists" not in str(exc).lower():
                raise

    def check_health(self) -> None:
        with self._lock:
            metadata = self.producer.list_topics(self.topic, timeout=10)
            topic = metadata.topics.get(self.topic)
            if topic is None or topic.error is not None:
                raise RuntimeError(f"Kafka topic 不可用：{self.topic}")

    def publish(self, event: dict, key: str) -> tuple[int, int]:
        outcome: list[Any] = []

        def delivered(error, message):
            outcome.append(error or (message.partition(), message.offset()))

        with self._lock:
            self.producer.produce(
                self.topic,
                key=key.encode("utf-8"),
                value=json.dumps(event, separators=(",", ":")).encode("utf-8"),
                on_delivery=delivered,
            )
            remaining = self.producer.flush(10)
        if remaining or not outcome:
            raise RuntimeError("Kafka 消息发布超时")
        if not isinstance(outcome[0], tuple):
            raise RuntimeError(str(outcome[0]))
        return outcome[0]

    def poll(self, timeout: float):
        with self._lock:
            raw = self.consumer.poll(timeout)
        if raw is None:
            return None
        if raw.error():
            raise RuntimeError(str(raw.error()))
        return _KafkaMessage(raw, json.loads(raw.value().decode("utf-8")))

    def commit(self, message) -> None:
        with self._lock:
            self.consumer.commit(message=message.raw, asynchronous=False)

    def seek(self, message) -> None:
        from confluent_kafka import TopicPartition

        raw = message.raw
        with self._lock:
            self.consumer.seek(TopicPartition(raw.topic(), raw.partition(), raw.offset()))

    def close(self) -> None:
        with self._lock:
            self.producer.flush(5)
            self.consumer.close()

    def clear_pending(self) -> int:
        from confluent_kafka import TopicPartition
        with self._lock:
            metadata = self.producer.list_topics(self.topic, timeout=10)
            partitions = sorted(metadata.topics[self.topic].partitions)
            targets = []
            for partition in partitions:
                topic_partition = TopicPartition(self.topic, partition)
                _low, high = self.consumer.get_watermark_offsets(topic_partition, timeout=10)
                targets.append(TopicPartition(self.topic, partition, high))
            futures = self.admin.delete_records(
                targets, operation_timeout=10, request_timeout=15,
            )
            for future in futures.values():
                future.result()
            self.consumer.commit(offsets=targets, asynchronous=False)
        return len(targets)


class DolphinPushScheduler:
    def __init__(self, settings: Settings):
        from .dolphinscheduler import DolphinSchedulerClient

        self.client = DolphinSchedulerClient(settings)
        self._lock = threading.RLock()

    def initialize(self) -> None:
        with self._lock:
            self.client.initialize_push_workflow()

    def start_push_job(self, job_id: str) -> None:
        with self._lock:
            self.client.start_push_job(job_id)

    def recover(self) -> None:
        with self._lock:
            self.client.initialize_push_workflow()

    def clear_push_instances(self) -> tuple[int, int]:
        with self._lock:
            return self.client.clear_push_instances()

    def close(self) -> None:
        with self._lock:
            self.client.close()


class _KafkaMessage:
    def __init__(self, raw, event):
        self.raw = raw
        self.event = event
