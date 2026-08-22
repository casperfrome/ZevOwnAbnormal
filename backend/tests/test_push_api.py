from fastapi.testclient import TestClient

from app.main import create_app


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
