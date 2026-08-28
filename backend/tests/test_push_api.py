from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api import get_current_user
from app.main import create_app
from app.models import User
from app.models import (
    AnomalyEvent, AnomalyRecord, AnomalyPushJob, AnomalyPushPipelineState,
    AnomalyValidationRequest, NotificationDelivery, AnomalyRecordGroup,
    AnomalyRecordGroupMember, AnomalyGroupBroadcastDelivery, RuleRun, utcnow,
)
from app.anomaly_service import persist_matches
from app.rule_engine import EvaluationMatch
from test_push_pipeline import _rule


SUMMARY = {
    "status": "completed",
    "aborted_jobs": 2,
    "aborted_notifications": 1,
    "aborted_validations": 1,
    "stopped_ds_instances": 2,
    "deleted_ds_instances": 2,
    "cleared_kafka_partitions": 1,
    "errors": [],
}


def test_abort_endpoint_returns_structured_summary_from_pipeline_dependencies(monkeypatch):
    app = create_app(testing=True)
    kafka = object()
    scheduler = object()
    app.state.kafka_gateway = kafka
    app.state.push_scheduler = scheduler
    seen = []

    def abort(session, settings, actual_kafka, actual_scheduler):
        seen.append((actual_kafka, actual_scheduler))
        return SUMMARY

    monkeypatch.setattr("app.api.abort_pending_pushes", abort)
    with TestClient(app) as client:
        response = client.post("/api/v1/anomaly-pushes/abort")

    assert response.status_code == 200
    assert response.json() == SUMMARY
    assert seen == [(kafka, scheduler)]


def test_abort_endpoint_returns_502_with_partial_failure_body(monkeypatch):
    app = create_app(testing=True)
    app.state.kafka_gateway = object()
    app.state.push_scheduler = object()
    partial = {**SUMMARY, "status": "partial_failed", "errors": [
        {"stage": "kafka", "message": "unavailable"},
    ]}
    monkeypatch.setattr("app.api.abort_pending_pushes", lambda *_args: partial)

    with TestClient(app) as client:
        response = client.post("/api/v1/anomaly-pushes/abort")

    assert response.status_code == 502
    assert response.json() == partial


def test_internal_push_execution_requires_internal_token():
    with TestClient(create_app(testing=True)) as client:
        missing = client.post("/api/internal/anomaly-pushes/missing/execute")
        authorized = client.post(
            "/api/internal/anomaly-pushes/missing/execute",
            headers={"X-Internal-Token": "change-this-internal-token"},
        )

    assert missing.status_code == 401
    assert authorized.status_code == 404


def test_recover_endpoint_checks_dependencies_before_requeueing(monkeypatch):
    app = create_app(testing=True)
    kafka = type("Kafka", (), {"check_health": lambda self: None})()
    scheduler = type("Scheduler", (), {"recover": lambda self: None})()
    app.state.kafka_gateway = kafka
    app.state.push_scheduler = scheduler
    seen = []

    def recover(session):
        seen.append(session)
        return {
            "requeued_jobs": 3,
            "requeued_by_kind": {"notification": 1, "validation": 1, "group_broadcast": 1},
            "skipped_jobs": 2,
        }

    monkeypatch.setattr("app.api.recover_failed_push_jobs", recover)
    with TestClient(app) as client:
        response = client.post("/api/v1/anomaly-pushes/recover")

    assert response.status_code == 200
    assert response.json() == {
        "status": "completed",
        "checks": {"kafka": "healthy", "dolphinscheduler": "healthy"},
        "requeued_jobs": 3,
        "requeued_by_kind": {"notification": 1, "validation": 1, "group_broadcast": 1},
        "skipped_jobs": 2,
        "errors": [],
    }
    assert len(seen) == 1


def test_recover_endpoint_does_not_change_jobs_when_dependency_check_fails(monkeypatch):
    app = create_app(testing=True)
    app.state.kafka_gateway = type(
        "Kafka", (), {"check_health": lambda self: (_ for _ in ()).throw(RuntimeError("broker down"))},
    )()
    app.state.push_scheduler = type("Scheduler", (), {"recover": lambda self: None})()
    monkeypatch.setattr(
        "app.api.recover_failed_push_jobs",
        lambda *_args: (_ for _ in ()).throw(AssertionError("must not requeue")),
    )

    with TestClient(app) as client:
        response = client.post("/api/v1/anomaly-pushes/recover")

    assert response.status_code == 502
    assert response.json()["status"] == "partial_failed"
    assert response.json()["checks"] == {"kafka": "unhealthy", "dolphinscheduler": "healthy"}
    assert response.json()["requeued_jobs"] == 0
    assert response.json()["errors"][0]["stage"] == "kafka"


def test_recover_endpoint_requires_superadmin():
    app = create_app(testing=True)
    app.dependency_overrides[get_current_user] = lambda: User(
        id="reader", username="reader", password_hash="", is_superuser=False,
    )

    with TestClient(app) as client:
        response = client.post("/api/v1/anomaly-pushes/recover")

    assert response.status_code == 403


def seed_clear_records(session):
    rule = _rule(session)
    records = persist_matches(session, rule, [EvaluationMatch(
        row={"store_id": str(index), "gmv": 500},
        business_key={"store_id": str(index)}, matched_conditions=[],
    ) for index in range(14)]).records
    # Twelve in transit, including mixed statuses and one already resolved.
    for index, record in enumerate(records):
        record.status = ["pending", "processing", "timed_out"][index % 3]
        if index == 11:
            record.status = "resolved"
            record.resolution_source = "manual"
            record.resolved_by_user_id = "original-admin"
            record.resolved_at = utcnow()
            record.active_fingerprint = None
        if index >= 12:
            for job in session.scalars(select(AnomalyPushJob).where(AnomalyPushJob.anomaly_id == record.id)):
                job.status = "sent"
            for delivery in session.scalars(select(NotificationDelivery).where(NotificationDelivery.anomaly_id == record.id)):
                delivery.status = "sent"
            for request in session.scalars(select(AnomalyValidationRequest).where(AnomalyValidationRequest.anomaly_id == record.id)):
                request.delivery_status = "sent"
    run = RuleRun(rule_id=rule.id, trigger_source="manual", status="success")
    session.add(run)
    session.flush()
    detected_at = utcnow()
    session.add(AnomalyRecordGroup(rule_id=rule.id, detected_at=detected_at,
                                   run_id=run.id, rule_name=rule.name))
    session.flush()
    # A shared group: the unrelated member must not be resolved.
    session.add_all([AnomalyRecordGroupMember(
        rule_id=rule.id, detected_at=detected_at, anomaly_id=record.id, position=index,
    ) for index, record in enumerate([records[0], records[12]])])
    broadcast = AnomalyGroupBroadcastDelivery(
        rule_id=rule.id, detected_at=detected_at, part_index=0, total_parts=1,
        webhook_url="https://example.invalid/hook", payload={},
    )
    session.add(broadcast)
    session.flush()
    session.add(AnomalyPushJob(kind="group_broadcast", delivery_id=broadcast.id, generation=1))
    session.commit()
    return [record.id for record in records], broadcast.id


def test_clear_in_transit_resolves_all_pages_cancels_group_and_preserves_other_records():
    app = create_app(testing=True)
    with TestClient(app) as client:
        with app.state.session_factory() as session:
            ids, broadcast_id = seed_clear_records(session)
        assert client.get("/api/v1/anomalies", params={"push_status": "in_transit"}).json()["total"] == 12
        response = client.post("/api/v1/anomaly-pushes/clear-in-transit")
        assert response.status_code == 200
        assert response.json() == {"resolved_records": 11, "cancelled_jobs": 25}
        assert client.get("/api/v1/overview").json()["stats"]["push_in_transit_anomalies"] == 0
        assert client.post("/api/v1/anomaly-pushes/clear-in-transit").json() == {"resolved_records": 0, "cancelled_jobs": 0}
        with app.state.session_factory() as session:
            for record_id in ids[:11]:
                record = session.get(AnomalyRecord, record_id)
                assert record.status == "resolved"
                assert record.resolved_at is not None
                assert record.resolved_by_user_id == "admin"
                assert record.resolution_source == "manual"
                assert record.active_fingerprint is None
                assert session.scalar(select(AnomalyEvent.id).where(
                    AnomalyEvent.anomaly_id == record_id, AnomalyEvent.event_type == "status_changed"))
            assert session.get(AnomalyRecord, ids[11]).resolved_by_user_id == "original-admin"
            assert session.get(AnomalyRecord, ids[12]).status == "pending"
            assert session.get(AnomalyRecord, ids[13]).status == "processing"
            assert session.get(AnomalyGroupBroadcastDelivery, broadcast_id).status == "aborted"
            jobs = list(session.scalars(select(AnomalyPushJob).where(AnomalyPushJob.cancel_requested.is_(True))))
            assert len(jobs) == 25
            assert all(job.status == "aborted" for job in jobs)
            assert session.get(AnomalyPushPipelineState, 1).generation == 1
            from app.push_pipeline import recover_failed_push_jobs
            assert recover_failed_push_jobs(session)["requeued_jobs"] == 0


def test_clear_in_transit_rolls_back_resolution_and_cancellation(monkeypatch):
    from app import api
    original = api._set_anomaly_status
    def fail_after_change(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("transaction failure")
    app = create_app(testing=True)
    with TestClient(app, raise_server_exceptions=False) as client:
        with app.state.session_factory() as session:
            ids, _ = seed_clear_records(session)
        monkeypatch.setattr(api, "_set_anomaly_status", fail_after_change)
        assert client.post("/api/v1/anomaly-pushes/clear-in-transit").status_code == 500
        with app.state.session_factory() as session:
            assert session.get(AnomalyRecord, ids[0]).status == "pending"
            assert not session.scalar(select(AnomalyPushJob.id).where(AnomalyPushJob.cancel_requested.is_(True)))


def test_clear_in_transit_requires_superadmin_and_handles_empty_pipeline():
    app = create_app(testing=True)
    with TestClient(app) as client:
        response = client.post("/api/v1/anomaly-pushes/clear-in-transit")
        assert response.status_code == 200
        assert response.json() == {"resolved_records": 0, "cancelled_jobs": 0}
        app.dependency_overrides[get_current_user] = lambda: User(
            id="reader", username="reader", password_hash="", is_superuser=False)
        assert client.post("/api/v1/anomaly-pushes/clear-in-transit").status_code == 403
        app.dependency_overrides.clear()
        app.state.settings.auto_login = False
        assert client.post("/api/v1/anomaly-pushes/clear-in-transit").status_code == 401


def test_clear_finalizes_orphaned_sending_requests_as_uncertain():
    app = create_app(testing=True)
    with TestClient(app) as client:
        with app.state.session_factory() as session:
            ids, _ = seed_clear_records(session)
            job = session.scalar(select(AnomalyPushJob).where(
                AnomalyPushJob.anomaly_id == ids[0], AnomalyPushJob.kind == "validation"))
            job.status = "failed"
            request = session.get(AnomalyValidationRequest, job.delivery_id)
            request.delivery_status = "sending"
            request.delivery_attempts = 3
            request_id, job_id = request.id, job.id
            session.commit()
        assert client.post("/api/v1/anomaly-pushes/clear-in-transit").status_code == 200
        with app.state.session_factory() as session:
            assert session.get(AnomalyValidationRequest, request_id).delivery_status == "uncertain"
            assert session.get(AnomalyPushJob, job_id).status == "uncertain"
