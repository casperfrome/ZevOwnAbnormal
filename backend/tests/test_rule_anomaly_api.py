from fastapi.testclient import TestClient
from types import SimpleNamespace

from app.execution_service import RuleExecutionConflict
from app.main import create_app


def create_dependencies(client):
    datasource = client.post(
        "/api/v1/datasources",
        json={
            "name": "ADS", "type": "starrocks", "host": "localhost", "port": 9030,
            "database": "tastien_ads", "username": "root", "password": "", "ssl": False,
        },
    ).json()
    return client.post(
        "/api/v1/datasets",
        json={
            "name": "门店日报", "datasource_id": datasource["id"],
            "sql": "SELECT store_id, metric_date, gmv FROM ads_store_daily_operation",
        },
    ).json()


def test_rule_crud_exposes_key_fields_and_targets():
    with TestClient(create_app(testing=True)) as client:
        dataset = create_dependencies(client)
        response = client.post(
            "/api/v1/rules",
            json={
                "name": "GMV 异常",
                "dataset_id": dataset["id"],
                "severity": "high",
                "logic": "AND",
                "conditions": [{"field": "gmv", "operator": "gt", "value": 100000}],
                "anomaly_key_fields": ["store_id", "metric_date"],
                "schedule": {"frequency": "day", "interval": 1, "time": "09:00", "start_date": "2026-08-09"},
                "notification_targets": [{"receive_id_type": "open_id", "source": "literal", "value": "ou_user"}],
                "enabled": False,
            },
        )

        assert response.status_code == 201
        body = response.json()
        assert body["anomaly_key_fields"] == ["store_id", "metric_date"]
        assert body["notification_targets"][0]["receive_id_type"] == "open_id"
        assert body["sync_status"] == "pending"
        assert len(client.get("/api/v1/rules").json()) == 1


def test_numeric_comparison_threshold_is_stored_as_a_number():
    with TestClient(create_app(testing=True)) as client:
        dataset = create_dependencies(client)
        response = client.post(
            "/api/v1/rules",
            json={
                "name": "GMV3500", "dataset_id": dataset["id"],
                "conditions": [{"field": "gmv", "operator": "lt", "value": "3500"}],
                "anomaly_key_fields": ["store_id"],
                "schedule": {"frequency": "day", "interval": 1, "time": "09:00", "start_date": "2026-08-09"},
                "notification_targets": [{"receive_id_type": "user_id", "source": "literal", "value": "owner"}],
            },
        )

    assert response.status_code == 201
    value = response.json()["conditions"][0]["value"]
    assert value == 3500.0
    assert not isinstance(value, str)


def test_daily_schedule_rejects_interval_greater_than_one():
    with TestClient(create_app(testing=True)) as client:
        dataset = create_dependencies(client)
        response = client.post(
            "/api/v1/rules",
            json={
                "name": "bad schedule", "dataset_id": dataset["id"], "conditions": [{"field": "gmv", "operator": "gt", "value": 1}],
                "anomaly_key_fields": ["store_id"],
                "schedule": {"frequency": "day", "interval": 2, "time": "09:00", "start_date": "2026-08-09"},
                "notification_targets": [{"receive_id_type": "open_id", "source": "literal", "value": "ou_user"}],
            },
        )

        assert response.status_code == 422


def test_manual_execution_reports_failed_run_as_http_error(monkeypatch):
    failed_run = SimpleNamespace(status="failed", error_message="invalid numeric threshold")
    monkeypatch.setattr("app.api.execute_rule", lambda *_args, **_kwargs: failed_run)

    with TestClient(create_app(testing=True)) as client:
        response = client.post("/api/v1/rules/rule-1/execute")

    assert response.status_code == 502
    assert response.json() == {"detail": "invalid numeric threshold"}


def test_manual_execution_reports_concurrent_run_as_conflict(monkeypatch):
    def reject_concurrent_run(*_args, **_kwargs):
        raise RuleExecutionConflict("该规则正在执行，请等待本次执行完成")

    monkeypatch.setattr("app.api.execute_rule", reject_concurrent_run)

    with TestClient(create_app(testing=True)) as client:
        response = client.post("/api/v1/rules/rule-1/execute")

    assert response.status_code == 409
    assert response.json()["detail"] == "该规则正在执行，请等待本次执行完成"
