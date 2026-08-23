from fastapi.testclient import TestClient

from app.api import get_current_user
from app.main import create_app
from app.models import User


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
