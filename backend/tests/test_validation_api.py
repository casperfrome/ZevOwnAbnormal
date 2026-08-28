from datetime import datetime, timedelta

import bcrypt
from fastapi.testclient import TestClient

from app.main import create_app
from app.models import (
    AnomalyRecord,
    AnomalyValidationRequest,
    AnomalyValidationSubmission,
    Dataset,
    Datasource,
    Rule,
    User,
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


def test_sql_callbacks_use_versioned_refresh_including_unauthorized_responses(monkeypatch):
    from app.validation_service import submit_sql_validation
    from test_validation_service import FakeConnection
    from sqlalchemy import select
    patches = []
    class Client:
        def patch_interactive(self, message_id, card):
            patches.append((message_id, card))
    monkeypatch.setattr("app.validation_service._active_client", lambda *_: (Client(), False))
    monkeypatch.setattr("app.api.submit_sql_validation", lambda session, settings, anomaly_id, operator:
        submit_sql_validation(session, settings, anomaly_id, operator,
            connection_factory=lambda *_: FakeConnection([{"actual": "bad"}])))
    with TestClient(create_app(testing=True)) as client:
        anomaly_id = seed_validation_anomaly(client)
        with client.app.state.session_factory() as session:
            anomaly = session.get(AnomalyRecord, anomaly_id)
            rule = session.get(Rule, anomaly.rule_id)
            anomaly.validation_method_snapshot = "sql"
            anomaly.validation_config_snapshot = {"datasource_id": rule.dataset.datasource_id,
                "query_template": "SELECT actual FROM t", "parameters": [], "dataset_fields": [],
                "true_condition": {"field": "actual", "operator": "eq", "value": "ok"}}
            session.commit()
        headers = {"X-Internal-Token": "change-this-internal-token"}
        denied = client.post("/api/internal/feishu/card-actions", headers=headers,
            json=callback_payload(anomaly_id, action="run_sql_validation", operator_user_id="intruder"))
        assert denied.json()["card_update_mode"] == "versioned"
        response = client.post("/api/internal/feishu/card-actions", headers=headers,
            json=callback_payload(anomaly_id, action="run_sql_validation"))
        assert response.json()["card_update_mode"] == "versioned"
        assert response.json()["toast"]["type"] == "warning"
        assert len(patches) == 1
        assert patches[0][0] == "om_expected"
        assert "False" in str(patches[0][1])
        with client.app.state.session_factory() as session:
            request = session.scalar(select(AnomalyValidationRequest))
            assert request.synced_result_version == 1


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
        assert wrong_recipient.status_code == 200
        assert wrong_recipient.json()["toast"]["type"] == "error"
        assert wrong_recipient.json()["card"]["header"]["template"] == "orange"
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


def test_sql_card_action_dispatches_without_text_and_returns_retryable_failure(monkeypatch):
    """Sending SQL actions through pseudo validation or closing a failed card must fail this test."""
    from app.validation_service import SubmissionResult

    with TestClient(create_app(testing=True)) as client:
        anomaly_id = seed_validation_anomaly(client)
        with client.app.state.session_factory() as session:
            anomaly = session.get(AnomalyRecord, anomaly_id)
            anomaly.validation_method_snapshot = "sql"
            anomaly.validation_config_snapshot = {
                "query_template": "SELECT status FROM repair_state WHERE id='{目标ID}'",
                "parameters": [{"name": "目标ID", "field": "gmv"}],
                "true_condition": {"field": "status", "operator": "eq", "value": "normal"},
            }
            session.commit()

        monkeypatch.setattr(
            "app.api.submit_sql_validation",
            lambda *_args, **_kwargs: SubmissionResult(
                "failed", None, reason="condition_failed",
                result_detail={
                    "field": "status", "operator": "eq", "value": "normal",
                    "upper_value": None, "actual": "repairing",
                },
            ),
        )
        payload = callback_payload(
            anomaly_id,
            action="run_sql_validation",
        )
        payload.pop("validation_text")
        response = client.post(
            "/api/internal/feishu/card-actions",
            headers={"X-Internal-Token": "change-this-internal-token"},
            json=payload,
        )

        assert response.status_code == 200
        assert response.json()["toast"]["type"] == "warning"
        assert "repairing" in response.json()["toast"]["content"]
        assert response.json()["card"]["header"]["template"] == "orange"
        assert "已处理" in response.text
        assert "validation_text" not in response.text


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


def test_feishu_callback_maps_service_recipient_rejection_to_safe_card(monkeypatch):
    from app.validation_service import ValidationRecipientError

    app = create_app(testing=True)
    with TestClient(app) as client:
        anomaly_id = seed_validation_anomaly(client)
        monkeypatch.setattr(
            "app.api.submit_validation",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(
                ValidationRecipientError("recipient validator-2 is forbidden")
            ),
        )

        response = client.post(
            "/api/internal/feishu/card-actions",
            headers={"X-Internal-Token": "change-this-internal-token"},
            json=callback_payload(anomaly_id),
        )

        assert response.status_code == 200
        assert response.json()["toast"] == {"type": "error", "content": "当前用户无权提交该异常验证"}
        assert response.json()["card"]["header"]["template"] == "orange"
        assert "validator-2" not in response.text


def test_empty_callback_renders_state_committed_after_relationship_check(monkeypatch):
    from app.validation_service import submit_validation as real_submit_validation
    from app.validation_service import transition_anomaly

    app = create_app(testing=True)
    with TestClient(app) as client:
        anomaly_id = seed_validation_anomaly(client)

        def resolve_then_validate_empty(session, target_id, operator_user_id, text):
            with app.state.session_factory() as concurrent_session:
                concurrent = concurrent_session.get(AnomalyRecord, target_id)
                transition_anomaly(
                    concurrent_session,
                    concurrent,
                    "resolved",
                    source="manual",
                    user_id="admin",
                )
                concurrent_session.commit()
            return real_submit_validation(session, target_id, operator_user_id, text)

        monkeypatch.setattr("app.api.submit_validation", resolve_then_validate_empty)
        response = client.post(
            "/api/internal/feishu/card-actions",
            headers={"X-Internal-Token": "change-this-internal-token"},
            json=callback_payload(anomaly_id, validation_text="   "),
        )

        assert response.status_code == 200
        assert response.json()["toast"]["type"] == "error"
        assert response.json()["card"]["header"]["template"] == "green"
        assert response.json()["card"]["body"]["elements"][-1]["content"].startswith("**验证人：** admin")


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
        assert resolved.json()["resolved_by_user_id"] == "admin"
        assert resolved.json()["assignee"] == "admin-2"
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


def test_manual_status_routes_require_superadmin_when_auto_login_is_disabled():
    app = create_app(testing=True)
    app.state.settings.auto_login = False
    with TestClient(app) as client:
        anomaly_id = seed_validation_anomaly(client)
        with app.state.session_factory() as session:
            session.add(User(
                username="analyst",
                password_hash=bcrypt.hashpw(b"Analyst@123", bcrypt.gensalt()).decode(),
                is_superuser=False,
            ))
            session.commit()

        unauthenticated = client.patch(
            f"/api/v1/anomalies/{anomaly_id}/status", json={"status": "processing"}
        )
        assert unauthenticated.status_code == 401

        assert client.post(
            "/api/v1/auth/login", json={"username": "analyst", "password": "Analyst@123"}
        ).status_code == 200
        non_admin = client.patch(
            f"/api/v1/anomalies/{anomaly_id}/status", json={"status": "processing"}
        )
        assert non_admin.status_code == 403
        with app.state.session_factory() as session:
            assert session.get(AnomalyRecord, anomaly_id).status == "pending"


def test_manual_resolution_uses_authenticated_admin_not_forged_assignee():
    app = create_app(testing=True)
    app.state.settings.auto_login = False
    with TestClient(app) as client:
        anomaly_id = seed_validation_anomaly(client)
        assert client.post(
            "/api/v1/auth/login", json={"username": "admin", "password": "Admin@123456"}
        ).status_code == 200

        response = client.patch(
            f"/api/v1/anomalies/{anomaly_id}/status",
            json={"status": "resolved", "assignee": "forged-resolver"},
        )

        assert response.status_code == 200
        assert response.json()["assignee"] == "forged-resolver"
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
