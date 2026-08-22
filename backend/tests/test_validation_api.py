from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from app.main import create_app
from app.models import (
    AnomalyRecord,
    AnomalyValidationRequest,
    AnomalyValidationSubmission,
    Dataset,
    Datasource,
    Rule,
)


def seed_validation_anomaly(
    client: TestClient,
    *,
    status: str = "pending",
    recipients: tuple[tuple[str, str], ...] = (("validator-1", "om_expected"),),
) -> str:
    with client.app.state.session_factory() as session:
        datasource = Datasource(
            name=f"source-{status}-{len(recipients)}", type="starrocks", host="localhost", port=9030,
            database="ads", username="root", password_encrypted="",
        )
        dataset = Dataset(name=f"dataset-{status}-{len(recipients)}", datasource=datasource, sql="SELECT 1", fields=[])
        rule = Rule(
            name=f"rule-{status}-{len(recipients)}", dataset=dataset,
            conditions=[{"field": "gmv", "operator": "gt", "value": 1}],
            anomaly_key_fields=["store_id"], schedule={"frequency": "day"}, notification_targets=[],
        )
        session.add(rule)
        session.flush()
        anomaly = AnomalyRecord(
            rule_id=rule.id, rule_name=rule.name, dataset_name=dataset.name, severity="high", status=status,
            description="GMV anomaly", fingerprint="f" * 64,
            active_fingerprint=None if status == "resolved" else "f" * 64,
            business_key={"store_id": "S1"}, row_details={"gmv": 999}, matched_conditions=[],
            validation_deadline=datetime(2026, 8, 22, 10, 0, 0),
        )
        session.add(anomaly)
        session.flush()
        for recipient, message_id in recipients:
            session.add(AnomalyValidationRequest(
                anomaly_id=anomaly.id,
                recipient_user_id=recipient,
                delivery_status="sent",
                message_id=message_id,
            ))
        session.commit()
        return anomaly.id


def callback_payload(anomaly_id: str, **changes) -> dict:
    payload = {
        "anomaly_id": anomaly_id,
        "operator_user_id": "validator-1",
        "message_id": "om_expected",
        "action": "submit_validation",
        "validation_text": " confirmed ",
    }
    payload.update(changes)
    return payload


def test_feishu_callback_authenticates_and_resolves_with_updated_card():
    with TestClient(create_app(testing=True)) as client:
        anomaly_id = seed_validation_anomaly(client)

        unauthorized = client.post("/api/internal/feishu/card-actions", json=callback_payload(anomaly_id))
        response = client.post(
            "/api/internal/feishu/card-actions",
            headers={"X-Internal-Token": "change-this-internal-token"},
            json=callback_payload(anomaly_id),
        )

        assert unauthorized.status_code == 401
        assert response.status_code == 200
        assert response.json()["toast"]["type"] == "success"
        assert response.json()["card"]["header"]["template"] == "green"
        with client.app.state.session_factory() as session:
            anomaly = session.get(AnomalyRecord, anomaly_id)
            submission = session.query(AnomalyValidationSubmission).filter_by(anomaly_id=anomaly_id).one()
            assert anomaly.status == "resolved"
            assert anomaly.resolved_by_user_id == "validator-1"
            assert submission.submitted_text == "confirmed"


def test_feishu_callback_returns_safe_transport_errors_for_bad_relationships():
    with TestClient(create_app(testing=True)) as client:
        anomaly_id = seed_validation_anomaly(
            client,
            recipients=(("validator-1", "om_expected"), ("validator-2", "om_other")),
        )
        headers = {"X-Internal-Token": "change-this-internal-token"}

        unknown_anomaly = client.post(
            "/api/internal/feishu/card-actions", headers=headers, json=callback_payload("missing")
        )
        unknown_message = client.post(
            "/api/internal/feishu/card-actions", headers=headers,
            json=callback_payload(anomaly_id, message_id="om_missing"),
        )
        wrong_recipient = client.post(
            "/api/internal/feishu/card-actions", headers=headers,
            json=callback_payload(anomaly_id, message_id="om_other"),
        )
        wrong_action = client.post(
            "/api/internal/feishu/card-actions", headers=headers,
            json=callback_payload(anomaly_id, action="open_link"),
        )

        assert unknown_anomaly.status_code == 404
        assert unknown_message.status_code == 404
        assert wrong_recipient.status_code == 403
        assert wrong_action.status_code == 400
        assert "validator-2" not in wrong_recipient.text


def test_feishu_callback_returns_200_toasts_for_empty_and_repeat_submissions():
    with TestClient(create_app(testing=True)) as client:
        anomaly_id = seed_validation_anomaly(client)
        headers = {"X-Internal-Token": "change-this-internal-token"}

        empty = client.post(
            "/api/internal/feishu/card-actions", headers=headers,
            json=callback_payload(anomaly_id, validation_text="   "),
        )
        accepted = client.post(
            "/api/internal/feishu/card-actions", headers=headers, json=callback_payload(anomaly_id)
        )
        repeated = client.post(
            "/api/internal/feishu/card-actions", headers=headers, json=callback_payload(anomaly_id)
        )

        assert empty.status_code == 200
        assert empty.json()["toast"]["type"] == "error"
        assert accepted.json()["toast"]["type"] == "success"
        assert repeated.status_code == 200
        assert repeated.json()["toast"]["type"] == "warning"
        assert repeated.json()["card"]["header"]["template"] == "green"


def test_feishu_callback_hides_unexpected_internal_failures(monkeypatch):
    app = create_app(testing=True)
    with TestClient(app, raise_server_exceptions=False) as client:
        anomaly_id = seed_validation_anomaly(client)
        monkeypatch.setattr(
            "app.api.submit_validation",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("database password leaked")),
        )

        response = client.post(
            "/api/internal/feishu/card-actions",
            headers={"X-Internal-Token": "change-this-internal-token"},
            json=callback_payload(anomaly_id),
        )

        assert response.status_code == 500
        assert response.json() == {"detail": "处理飞书回调失败"}
        assert "database password leaked" not in response.text


def test_manual_status_routes_enforce_state_machine_and_identify_resolver():
    with TestClient(create_app(testing=True)) as client:
        anomaly_id = seed_validation_anomaly(client)

        processing = client.patch(
            f"/api/v1/anomalies/{anomaly_id}/status",
            json={"status": "processing", "assignee": " owner-1 "},
        )
        pending = client.patch(
            f"/api/v1/anomalies/{anomaly_id}/status", json={"status": "pending"}
        )
        resolved = client.patch(
            f"/api/v1/anomalies/{anomaly_id}/status", json={"status": "resolved", "assignee": "admin-2"}
        )
        reopened = client.patch(
            f"/api/v1/anomalies/{anomaly_id}/status", json={"status": "pending"}
        )
        manual_timeout = client.patch(
            f"/api/v1/anomalies/{anomaly_id}/status", json={"status": "timed_out"}
        )

        assert processing.status_code == 200
        assert pending.status_code == 200
        assert resolved.status_code == 200
        assert resolved.json()["resolution_source"] == "manual"
        assert resolved.json()["resolved_by_user_id"] == "admin-2"
        assert reopened.status_code == 409
        assert manual_timeout.status_code == 422


def test_manual_resolution_falls_back_to_configured_superadmin():
    with TestClient(create_app(testing=True)) as client:
        anomaly_id = seed_validation_anomaly(client, status="timed_out")

        response = client.patch(
            f"/api/v1/anomalies/{anomaly_id}/status",
            json={"status": "resolved", "assignee": "   "},
        )

        assert response.status_code == 200
        assert response.json()["resolved_by_user_id"] == "admin"


def test_bulk_status_is_atomic_and_reports_every_missing_or_invalid_record():
    with TestClient(create_app(testing=True)) as client:
        pending_id = seed_validation_anomaly(client, status="pending")
        resolved_id = seed_validation_anomaly(client, status="resolved")

        missing = client.post(
            "/api/v1/anomalies/bulk-status",
            json={"ids": [pending_id, "missing"], "status": "processing"},
        )
        invalid = client.post(
            "/api/v1/anomalies/bulk-status",
            json={"ids": [pending_id, resolved_id], "status": "processing"},
        )

        assert missing.status_code == 404
        assert "missing" in missing.json()["detail"]
        assert invalid.status_code == 409
        with client.app.state.session_factory() as session:
            assert session.get(AnomalyRecord, pending_id).status == "pending"


def test_anomaly_detail_and_overview_expose_validation_data_and_timeout_count():
    with TestClient(create_app(testing=True)) as client:
        pending_id = seed_validation_anomaly(client, status="pending")
        timed_out_id = seed_validation_anomaly(client, status="timed_out")
        with client.app.state.session_factory() as session:
            pending = session.get(AnomalyRecord, pending_id)
            pending.validation_deadline = datetime.now() + timedelta(hours=1)
            session.commit()

        detail = client.get(f"/api/v1/anomalies/{pending_id}")
        overview = client.get("/api/v1/overview")

        assert detail.status_code == 200
        assert detail.json()["validation_requests"] == [{
            "recipient_user_id": "validator-1",
            "delivery_status": "sent",
            "delivery_attempts": 0,
            "message_id": "om_expected",
            "last_error": None,
            "delivered_at": None,
        }]
        assert detail.json()["validation_submission"] is None
        assert overview.json()["stats"]["timed_out_records"] == 1
        assert any(item["id"] == timed_out_id for item in overview.json()["recent_anomalies"])
