from datetime import timedelta

from sqlalchemy import select

from app.anomaly_service import persist_matches
from app.config import Settings
from app import push_pipeline
from app.models import (
    AnomalyPushJob,
    AnomalyPushPipelineState,
    AnomalyValidationRequest,
    Dataset,
    Datasource,
    NotificationDelivery,
    Rule,
    utcnow,
)
from app.push_pipeline import (
    abort_pending_pushes,
    consume_one,
    execute_push_job,
    publish_pending_jobs,
    queue_due_notification_push_jobs,
    queue_due_validation_push_jobs,
    recover_failed_push_jobs,
    requeue_stale_push_jobs,
)
from app.rule_engine import EvaluationMatch


def _rule(db_session):
    datasource = Datasource(
        name="push-ads", type="starrocks", host="localhost", port=9030,
        database="ads", username="root", password_encrypted="",
    )
    dataset = Dataset(name="push-daily", datasource=datasource, sql="SELECT 1", fields=[])
    rule = Rule(
        name="push-rule", dataset=dataset, severity="high", logic="AND",
        conditions=[{"field": "gmv", "operator": "gt", "value": 100}],
        anomaly_key_fields=["store_id"], schedule={"frequency": "day"},
        notification_targets=[
            {"receive_id_type": "open_id", "source": "literal", "value": "ou_owner"},
        ],
        validation_enabled=True,
        validation_targets=[{"source": "literal", "value": "validator"}],
        validation_timeout_minutes=30,
    )
    db_session.add(rule)
    db_session.commit()
    return rule


def test_persisting_anomaly_creates_one_push_job_per_delivery_in_current_generation(db_session):
    rule = _rule(db_session)
    db_session.add(AnomalyPushPipelineState(id=1, generation=7))
    db_session.commit()

    persist_matches(
        db_session,
        rule,
        [EvaluationMatch(
            row={"store_id": "S1", "gmv": 500},
            business_key={"store_id": "S1"},
            matched_conditions=[{"field": "gmv", "matched": True}],
        )],
    )

    jobs = list(db_session.scalars(select(AnomalyPushJob).order_by(AnomalyPushJob.kind)))
    assert [(job.kind, job.generation, job.status) for job in jobs] == [
        ("notification", 7, "pending_publish"),
        ("validation", 7, "pending_publish"),
    ]
    assert len({job.delivery_id for job in jobs}) == 2
    assert len({job.anomaly_id for job in jobs}) == 1


def test_repeated_match_does_not_create_duplicate_push_jobs(db_session):
    rule = _rule(db_session)
    match = EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )

    persist_matches(db_session, rule, [match])
    persist_matches(db_session, rule, [match])

    assert len(list(db_session.scalars(select(AnomalyPushJob)))) == 2


class FakeKafka:
    def __init__(self):
        self.messages = []
        self.commits = []
        self.seeks = []
        self.events = []

    def publish(self, event, key):
        self.events.append("publish")
        self.messages.append((event, key))
        return 2, 11

    def poll(self, _timeout):
        return self.messages.pop(0) if self.messages else None

    def commit(self, message):
        self.events.append("commit")
        self.commits.append(message)

    def seek(self, message):
        self.events.append("seek")
        self.seeks.append(message)


class FakeScheduler:
    def __init__(self):
        self.started = []
        self.events = []

    def start_push_job(self, job_id):
        self.events.append("start")
        self.started.append(job_id)


def test_publish_pending_job_writes_minimal_versioned_message_and_records_offset(db_session):
    rule = _rule(db_session)
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500, "secret": "not-for-kafka"},
        business_key={"store_id": "S1"}, matched_conditions=[],
    )])
    kafka = FakeKafka()

    assert publish_pending_jobs(db_session, Settings(), kafka, limit=1) == 1

    event, key = kafka.messages[0]
    job = db_session.get(AnomalyPushJob, key)
    assert event == {
        "version": 1, "job_id": job.id, "generation": job.generation, "kind": job.kind,
    }
    assert key == job.id
    assert "secret" not in str(event)
    assert (job.status, job.kafka_partition, job.kafka_offset) == ("kafka_queued", 2, 11)


def test_external_publish_happens_after_durable_short_claim(db_session):
    rule = _rule(db_session)
    rule.validation_enabled = False
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )])

    class InspectingKafka(FakeKafka):
        def publish(self, event, key):
            assert not db_session.in_transaction()
            assert db_session.get(AnomalyPushJob, key).status == "publishing"
            return super().publish(event, key)

    assert publish_pending_jobs(db_session, Settings(), InspectingKafka(), limit=1) == 1


def test_publish_failure_keeps_job_pending_for_retry(db_session):
    rule = _rule(db_session)
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )])

    class BrokenKafka(FakeKafka):
        def publish(self, event, key):
            raise RuntimeError("broker unavailable")

    assert publish_pending_jobs(db_session, Settings(), BrokenKafka(), limit=1) == 0
    job = db_session.scalar(select(AnomalyPushJob).where(AnomalyPushJob.publish_attempts == 1))
    assert job.status == "pending_publish"
    assert job.publish_attempts == 1
    assert job.last_error == "broker unavailable"


def test_consumer_starts_scheduler_before_committing_and_deduplicates(db_session):
    rule = _rule(db_session)
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )])
    job = db_session.scalar(select(AnomalyPushJob).order_by(AnomalyPushJob.kind))
    job.status = "kafka_queued"
    db_session.commit()
    kafka = FakeKafka()
    event = {"version": 1, "job_id": job.id, "generation": job.generation, "kind": job.kind}
    kafka.messages = [(event, job.id), (event, job.id)]
    scheduler = FakeScheduler()

    assert consume_one(db_session, Settings(), kafka, scheduler) == "scheduled"
    assert scheduler.started == [job.id]
    assert job.status == "ds_scheduled"
    assert scheduler.events + kafka.events == ["start", "commit"]

    assert consume_one(db_session, Settings(), kafka, scheduler) == "duplicate"
    assert scheduler.started == [job.id]
    assert len(kafka.commits) == 2


def test_consumer_seeks_record_seen_before_publish_finalization(db_session):
    rule = _rule(db_session)
    rule.validation_enabled = False
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )])
    job = db_session.scalar(select(AnomalyPushJob))
    job.status = "publishing"
    db_session.commit()
    event = {"version": 1, "job_id": job.id, "generation": job.generation, "kind": job.kind}
    kafka = FakeKafka()
    kafka.messages = [(event, job.id)]

    assert consume_one(db_session, Settings(), kafka, FakeScheduler()) == "in_progress"
    assert len(kafka.seeks) == 1
    assert kafka.commits == []
    assert job.status == "publishing"


def test_dispatch_failure_commits_old_record_and_returns_job_to_outbox(db_session):
    rule = _rule(db_session)
    rule.validation_enabled = False
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )])
    job = db_session.scalar(select(AnomalyPushJob))
    job.status = "kafka_queued"
    db_session.commit()
    event = {"version": 1, "job_id": job.id, "generation": job.generation, "kind": job.kind}
    kafka = FakeKafka()
    kafka.messages = [(event, job.id)]

    class BrokenScheduler:
        def start_push_job(self, _job_id):
            raise RuntimeError("DS unavailable")

    assert consume_one(db_session, Settings(), kafka, BrokenScheduler()) == "dispatch_failed"
    assert job.status == "failed"
    assert job.next_attempt_at > utcnow()
    assert len(kafka.commits) == 1
    assert publish_pending_jobs(db_session, Settings(), kafka, limit=1) == 0

    job.next_attempt_at = utcnow() - timedelta(seconds=1)
    db_session.commit()
    assert queue_due_notification_push_jobs(db_session) == 1
    assert job.status == "pending_publish"


def test_validation_dispatch_failure_waits_for_backoff_before_requeue(db_session):
    rule = _rule(db_session)
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )])
    job = db_session.scalar(select(AnomalyPushJob).where(AnomalyPushJob.kind == "validation"))
    job.status = "kafka_queued"
    db_session.commit()
    event = {"version": 1, "job_id": job.id, "generation": job.generation, "kind": job.kind}
    kafka = FakeKafka()
    kafka.messages = [(event, job.id)]

    class BrokenScheduler:
        def start_push_job(self, _job_id):
            raise RuntimeError("DS unavailable")

    assert consume_one(db_session, Settings(), kafka, BrokenScheduler()) == "dispatch_failed"
    assert job.status == "failed"
    assert queue_due_validation_push_jobs(db_session) == 0

    job.next_attempt_at = utcnow() - timedelta(seconds=1)
    db_session.commit()
    assert queue_due_validation_push_jobs(db_session) == 1
    assert job.status == "pending_publish"


def test_manual_recovery_requeues_only_safe_current_generation_failures(db_session):
    rule = _rule(db_session)
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )])
    jobs = list(db_session.scalars(select(AnomalyPushJob).order_by(AnomalyPushJob.kind)))
    notification = next(job for job in jobs if job.kind == "notification")
    validation = next(job for job in jobs if job.kind == "validation")
    notification.status = "failed"
    notification.last_error = "401 Unauthorized"
    notification.next_attempt_at = utcnow() - timedelta(seconds=1)
    validation.status = "failed"
    validation.last_error = "ambiguous send"
    request = db_session.get(AnomalyValidationRequest, validation.delivery_id)
    request.delivery_status = "uncertain"
    db_session.commit()

    summary = recover_failed_push_jobs(db_session)

    assert summary == {
        "requeued_jobs": 1,
        "requeued_by_kind": {"notification": 1, "validation": 0, "group_broadcast": 0},
        "skipped_jobs": 1,
    }
    assert notification.status == "pending_publish"
    assert validation.status == "failed"


def test_manual_recovery_respects_future_backoff(db_session):
    rule = _rule(db_session)
    rule.validation_enabled = False
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )])
    job = db_session.scalar(select(AnomalyPushJob))
    job.status = "failed"
    job.next_attempt_at = utcnow() + timedelta(minutes=5)
    db_session.commit()

    summary = recover_failed_push_jobs(db_session)

    assert summary["requeued_jobs"] == 0
    assert summary["skipped_jobs"] == 1
    assert job.status == "failed"


def test_manual_recovery_skips_validation_for_resolved_anomaly(db_session):
    rule = _rule(db_session)
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )])
    job = db_session.scalar(select(AnomalyPushJob).where(
        AnomalyPushJob.kind == "validation"
    ))
    anomaly = db_session.get(
        __import__("app.models", fromlist=["AnomalyRecord"]).AnomalyRecord,
        job.anomaly_id,
    )
    job.status = "failed"
    job.next_attempt_at = utcnow() - timedelta(seconds=1)
    anomaly.status = "resolved"
    anomaly.active_fingerprint = None
    db_session.commit()

    summary = recover_failed_push_jobs(db_session)

    assert summary["requeued_jobs"] == 0
    assert summary["skipped_jobs"] == 1
    assert job.status == "failed"


def test_consumer_reconciles_already_delivered_job_without_starting_scheduler(db_session):
    rule = _rule(db_session)
    rule.validation_enabled = False
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )])
    job = db_session.scalar(select(AnomalyPushJob))
    job.status = "kafka_queued"
    db_session.get(NotificationDelivery, job.delivery_id).status = "sent"
    db_session.commit()
    event = {"version": 1, "job_id": job.id, "generation": job.generation, "kind": job.kind}
    kafka = FakeKafka()
    kafka.messages = [(event, job.id)]
    scheduler = FakeScheduler()

    assert consume_one(db_session, Settings(), kafka, scheduler) == "reconciled"
    assert job.status == "sent"
    assert scheduler.started == []
    assert len(kafka.commits) == 1


def test_reconcile_completed_push_jobs_closes_nonterminal_jobs_without_resending(db_session):
    rule = _rule(db_session)
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )])
    jobs = list(db_session.scalars(select(AnomalyPushJob)))
    for job in jobs:
        job.status = "kafka_queued"
        if job.kind == "notification":
            db_session.get(NotificationDelivery, job.delivery_id).status = "sent"
        else:
            db_session.get(AnomalyValidationRequest, job.delivery_id).delivery_status = "update_failed"
    db_session.commit()

    assert push_pipeline.reconcile_completed_push_jobs(db_session, limit=50) == 2
    assert {job.status for job in jobs} == {"sent"}


def test_internal_execution_sends_one_notification_and_is_idempotent(db_session, monkeypatch):
    rule = _rule(db_session)
    rule.validation_enabled = False
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )])
    job = db_session.scalar(select(AnomalyPushJob))
    job.status = "ds_scheduled"
    db_session.commit()
    calls = []

    def deliver(session, settings, delivery_ids=None, **_kwargs):
        calls.append(delivery_ids)
        delivery = session.get(__import__("app.models", fromlist=["NotificationDelivery"]).NotificationDelivery, delivery_ids[0])
        delivery.status = "sent"
        delivery.message_id = "om_sent"
        session.commit()
        return 0

    monkeypatch.setattr("app.push_pipeline.deliver_notifications", deliver)

    assert execute_push_job(db_session, Settings(), job.id) == "sent"
    assert execute_push_job(db_session, Settings(), job.id) == "already_terminal"
    assert calls == [[job.delivery_id]]


def test_old_generation_job_is_aborted_without_sending(db_session, monkeypatch):
    rule = _rule(db_session)
    rule.validation_enabled = False
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )])
    job = db_session.scalar(select(AnomalyPushJob))
    pipeline = db_session.get(AnomalyPushPipelineState, 1)
    pipeline.generation += 1
    db_session.commit()
    monkeypatch.setattr(
        "app.push_pipeline.deliver_notifications",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("must not send")),
    )

    assert execute_push_job(db_session, Settings(), job.id) == "aborted"
    assert job.status == "aborted"


def test_send_failure_after_abort_request_becomes_aborted_not_retryable(db_session, monkeypatch):
    rule = _rule(db_session)
    rule.validation_enabled = False
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )])
    job = db_session.scalar(select(AnomalyPushJob))
    job.status = "ds_scheduled"
    db_session.commit()

    def fail_after_cancel(session, settings, delivery_ids=None, **_kwargs):
        current = session.get(AnomalyPushJob, job.id)
        current.cancel_requested = True
        delivery = session.get(__import__("app.models", fromlist=["NotificationDelivery"]).NotificationDelivery, delivery_ids[0])
        delivery.status = "failed"
        session.commit()
        return 1

    monkeypatch.setattr("app.push_pipeline.deliver_notifications", fail_after_cancel)

    assert execute_push_job(db_session, Settings(), job.id) == "aborted"
    assert job.status == "aborted"


def test_send_exception_after_abort_request_becomes_aborted_not_retryable(db_session, monkeypatch):
    rule = _rule(db_session)
    rule.validation_enabled = False
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )])
    job = db_session.scalar(select(AnomalyPushJob))
    job.status = "ds_scheduled"
    db_session.commit()

    def raise_after_cancel(session, settings, delivery_ids=None, **_kwargs):
        current = session.get(AnomalyPushJob, job.id)
        current.cancel_requested = True
        session.commit()
        raise RuntimeError("HTTP disconnected")

    monkeypatch.setattr("app.push_pipeline.deliver_notifications", raise_after_cancel)

    import pytest
    with pytest.raises(RuntimeError, match="HTTP disconnected"):
        execute_push_job(db_session, Settings(), job.id)
    assert job.status == "aborted"


def test_duplicate_callback_while_send_is_in_progress_is_a_noop(db_session, monkeypatch):
    rule = _rule(db_session)
    rule.validation_enabled = False
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )])
    job = db_session.scalar(select(AnomalyPushJob))
    job.status = "sending"
    db_session.commit()
    monkeypatch.setattr(
        "app.push_pipeline.deliver_notifications",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("duplicate send")),
    )

    assert execute_push_job(db_session, Settings(), job.id) == "already_in_progress"


def test_abort_marks_both_delivery_kinds_and_clears_external_queues(db_session):
    rule = _rule(db_session)
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )])

    class Admin:
        def clear_pending(self):
            return 3

    class Scheduler:
        def clear_push_instances(self):
            return 2, 2

    result = abort_pending_pushes(db_session, Settings(), Admin(), Scheduler(), wait_seconds=0)

    assert result == {
        "status": "completed",
        "aborted_jobs": 2,
        "aborted_notifications": 1,
        "aborted_validations": 1,
        "aborted_group_broadcasts": 0,
        "stopped_ds_instances": 2,
        "deleted_ds_instances": 2,
        "cleared_kafka_partitions": 3,
        "errors": [],
    }
    assert db_session.get(AnomalyPushPipelineState, 1).generation == 2
    assert {job.status for job in db_session.scalars(select(AnomalyPushJob))} == {"aborted"}


def test_abort_includes_retryable_failed_jobs(db_session):
    rule = _rule(db_session)
    rule.validation_enabled = False
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )])
    job = db_session.scalar(select(AnomalyPushJob))
    job.status = "failed"
    delivery = db_session.get(
        __import__("app.models", fromlist=["NotificationDelivery"]).NotificationDelivery,
        job.delivery_id,
    )
    delivery.status = "failed"
    db_session.commit()

    result = abort_pending_pushes(
        db_session, Settings(),
        type("Admin", (), {"clear_pending": lambda self: 1})(),
        type("Scheduler", (), {"clear_push_instances": lambda self: (0, 0)})(),
        wait_seconds=0,
    )

    assert result["aborted_jobs"] == 1
    assert (job.status, delivery.status, job.cancel_requested) == ("aborted", "aborted", True)


def test_stale_sending_job_is_requeued_but_sent_delivery_is_reconciled(db_session):
    from app.models import NotificationDelivery, utcnow

    rule = _rule(db_session)
    rule.validation_enabled = False
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )])
    job = db_session.scalar(select(AnomalyPushJob))
    job.status = "sending"
    job.updated_at = utcnow() - timedelta(minutes=10)
    db_session.commit()

    assert requeue_stale_push_jobs(db_session, Settings(), now=utcnow()) == 1
    assert job.status == "pending_publish"

    job.status = "sending"
    job.updated_at = utcnow() - timedelta(minutes=10)
    db_session.get(NotificationDelivery, job.delivery_id).status = "sent"
    db_session.commit()

    assert requeue_stale_push_jobs(db_session, Settings(), now=utcnow()) == 1
    assert job.status == "sent"


def test_stale_dolphinscheduler_callback_is_requeued(db_session):
    from app.models import utcnow

    rule = _rule(db_session)
    rule.validation_enabled = False
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )])
    job = db_session.scalar(select(AnomalyPushJob))
    job.status = "ds_scheduled"
    job.updated_at = utcnow() - timedelta(minutes=11)
    db_session.commit()

    assert requeue_stale_push_jobs(db_session, Settings(), now=utcnow()) == 1
    assert job.status == "pending_publish"
    assert "回调租约过期" in job.last_error


def test_failed_notification_uses_bounded_backoff_before_requeue(db_session, monkeypatch):
    from app.models import NotificationDelivery, utcnow

    rule = _rule(db_session)
    rule.validation_enabled = False
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )])
    job = db_session.scalar(select(AnomalyPushJob))
    job.status = "ds_scheduled"
    db_session.commit()

    def fail(session, settings, delivery_ids=None, **_kwargs):
        delivery = session.get(NotificationDelivery, delivery_ids[0])
        delivery.status = "failed"
        delivery.attempts = 3
        session.commit()
        return 1

    monkeypatch.setattr("app.push_pipeline.deliver_notifications", fail)
    assert execute_push_job(db_session, Settings(), job.id) == "failed"
    retry_at = job.next_attempt_at
    assert retry_at > utcnow()
    assert queue_due_notification_push_jobs(db_session) == 0

    job.next_attempt_at = utcnow() - timedelta(seconds=1)
    db_session.commit()
    assert queue_due_notification_push_jobs(db_session) == 1
    assert job.status == "pending_publish"


def test_abort_preserves_ambiguous_validation_as_uncertain(db_session):
    from app.models import AnomalyValidationRequest

    rule = _rule(db_session)
    persist_matches(db_session, rule, [EvaluationMatch(
        row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"},
        matched_conditions=[],
    )])
    job = db_session.scalar(select(AnomalyPushJob).where(AnomalyPushJob.kind == "validation"))
    request = db_session.get(AnomalyValidationRequest, job.delivery_id)
    job.status = "failed"
    request.delivery_status = "sending"
    request.next_attempt_at = request.updated_at + timedelta(minutes=5)
    db_session.commit()

    abort_pending_pushes(
        db_session, Settings(),
        type("Admin", (), {"clear_pending": lambda self: 1})(),
        type("Scheduler", (), {"clear_push_instances": lambda self: (0, 0)})(),
        wait_seconds=0,
    )

    assert job.status == "aborted"
    assert request.delivery_status == "uncertain"
    assert request.next_attempt_at is None


def test_maintenance_queues_legacy_pending_validation_instead_of_sending(db_session):
    from app.models import AnomalyRecord, AnomalyValidationRequest

    anomaly = AnomalyRecord(
        rule_id="rule", rule_name="rule", dataset_name="data", severity="high",
        fingerprint="f" * 64, active_fingerprint="f" * 64,
        business_key={"id": 1}, row_details={}, matched_conditions=[],
    )
    db_session.add(anomaly)
    db_session.flush()
    request = AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user")
    db_session.add(request)
    db_session.commit()

    assert queue_due_validation_push_jobs(db_session, limit=50) == 1
    job = db_session.scalar(select(AnomalyPushJob))
    assert (job.kind, job.delivery_id, job.status) == (
        "validation", request.id, "pending_publish",
    )


def test_maintenance_queues_legacy_pending_notification(db_session):
    from app.models import AnomalyRecord, NotificationDelivery

    anomaly = AnomalyRecord(
        rule_id="rule", rule_name="rule", dataset_name="data", severity="high",
        fingerprint="n" * 64, active_fingerprint="n" * 64,
        business_key={"id": 2}, row_details={}, matched_conditions=[],
    )
    db_session.add(anomaly)
    db_session.flush()
    delivery = NotificationDelivery(
        anomaly_id=anomaly.id, receive_id_type="open_id", recipient="ou_legacy",
    )
    db_session.add(delivery)
    db_session.commit()

    assert queue_due_notification_push_jobs(db_session, limit=50) == 1
    job = db_session.scalar(select(AnomalyPushJob))
    assert (job.kind, job.delivery_id, job.status) == (
        "notification", delivery.id, "pending_publish",
    )
