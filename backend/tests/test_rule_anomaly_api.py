from fastapi.testclient import TestClient
from types import SimpleNamespace

from sqlalchemy import select

from app.anomaly_service import persist_matches
from app.execution_service import RuleExecutionConflict
from app.main import create_app
from app.models import (
    AnomalyPushJob,
    AnomalyRecord,
    AnomalyValidationRequest,
    Dataset,
    NotificationDelivery,
    Rule,
)
from app.rule_engine import EvaluationMatch


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


def test_rule_group_broadcast_config_is_validated_encrypted_and_never_returned():
    """Removing encryption, secret-preserving updates, or field validation must fail this test."""
    webhook = "https://open.feishu.cn/open-apis/bot/v2/hook/11111111-2222-3333-4444-555555555555"
    with TestClient(create_app(testing=True)) as client:
        dataset = create_dependencies(client)
        with client.app.state.session_factory() as session:
            item = session.get(Dataset, dataset["id"])
            item.fields = [
                {"name": "store_id", "type": "VARCHAR"},
                {"name": "owner_user_id", "type": "VARCHAR"},
                {"name": "gmv", "type": "DECIMAL"},
            ]
            session.commit()

        payload = {
            "name": "群聊播报规则",
            "dataset_id": dataset["id"],
            "conditions": [{"field": "gmv", "operator": "gt", "value": 100}],
            "anomaly_key_fields": ["store_id"],
            "schedule": {"frequency": "day", "interval": 1, "time": "09:00", "start_date": "2026-08-23"},
            "notification_targets": [{"receive_id_type": "user_id", "source": "literal", "value": "owner"}],
            "group_broadcast": {
                "enabled": True,
                "webhook_url": webhook,
                "mention_targets": [
                    {"source": "literal", "value": "fixed-user"},
                    {"source": "field", "field": "owner_user_id"},
                ],
            },
        }
        created = client.post("/api/v1/rules", json=payload)

        assert created.status_code == 201
        assert created.json()["group_broadcast"] == {
            "enabled": True,
            "has_webhook": True,
            "mention_targets": payload["group_broadcast"]["mention_targets"],
        }
        with client.app.state.session_factory() as session:
            stored = session.get(Rule, created.json()["id"])
            assert stored.group_webhook_encrypted
            assert stored.group_webhook_encrypted != webhook

        preserved = client.put(
            f"/api/v1/rules/{created.json()['id']}",
            json={
                **payload,
                "group_broadcast": {
                    "enabled": True,
                    "mention_targets": [{"source": "literal", "value": "replacement-user"}],
                },
            },
        )
        assert preserved.status_code == 200
        assert preserved.json()["group_broadcast"]["has_webhook"] is True

        invalid_host = client.post(
            "/api/v1/rules",
            json={
                **payload,
                "name": "非法 webhook",
                "group_broadcast": {
                    **payload["group_broadcast"],
                    "webhook_url": "https://example.com/open-apis/bot/v2/hook/not-feishu",
                },
            },
        )
        invalid_field = client.post(
            "/api/v1/rules",
            json={
                **payload,
                "name": "非法字段",
                "group_broadcast": {
                    **payload["group_broadcast"],
                    "mention_targets": [{"source": "field", "field": "missing_user_id"}],
                },
            },
        )
        invalid_bare_hook = client.post(
            "/api/v1/rules",
            json={
                **payload,
                "name": "缺少 hook 标识",
                "group_broadcast": {
                    **payload["group_broadcast"],
                    "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/",
                },
            },
        )
        assert invalid_host.status_code == 422
        assert invalid_field.status_code == 422
        assert invalid_bare_hook.status_code == 422

        cleared = client.put(
            f"/api/v1/rules/{created.json()['id']}",
            json={
                **payload,
                "group_broadcast": {
                    "enabled": False,
                    "webhook_url": None,
                    "mention_targets": [],
                },
            },
        )
        assert cleared.status_code == 200
        assert cleared.json()["group_broadcast"]["has_webhook"] is False


def test_sql_validation_rule_crud_validates_template_mappings_and_serializes_config():
    """Saving mutating SQL or a mapping to an unknown dataset field must fail this test."""
    with TestClient(create_app(testing=True)) as client:
        dataset = create_dependencies(client)
        with client.app.state.session_factory() as session:
            item = session.get(Dataset, dataset["id"])
            item.fields = [
                {"name": "store_id", "type": "VARCHAR"},
                {"name": "metric_date", "type": "DATE"},
                {"name": "gmv", "type": "DECIMAL"},
            ]
            session.commit()

        payload = {
            "name": "GMV SQL 校验",
            "dataset_id": dataset["id"],
            "conditions": [{"field": "gmv", "operator": "gt", "value": 100000}],
            "anomaly_key_fields": ["store_id", "metric_date"],
            "schedule": {"frequency": "day", "interval": 1, "time": "09:00", "start_date": "2026-08-09"},
            "notification_targets": [{"receive_id_type": "user_id", "source": "literal", "value": "validator-1"}],
            "validation_enabled": True,
            "validation_targets": [{"source": "literal", "value": "validator-1"}],
            "validation_method": "sql",
            "sql_validation_config": {
                "query_template": "SELECT status FROM repair_state WHERE store_id='{门店ID}'",
                "parameters": [{"name": "门店ID", "field": "store_id"}],
                "true_condition": {"field": "status", "operator": "eq", "value": "normal"},
            },
        }

        created = client.post("/api/v1/rules", json=payload)
        assert created.status_code == 201
        assert created.json()["validation_method"] == "sql"
        assert created.json()["sql_validation_config"]["query_template"] == payload["sql_validation_config"]["query_template"]
        assert created.json()["sql_validation_config"]["parameters"] == payload["sql_validation_config"]["parameters"]
        assert created.json()["sql_validation_config"]["true_condition"] == {
            **payload["sql_validation_config"]["true_condition"],
            "upper_value": None,
        }

        mutating = client.post(
            "/api/v1/rules",
            json={
                **payload,
                "name": "mutating SQL",
                "sql_validation_config": {
                    **payload["sql_validation_config"],
                    "query_template": "DELETE FROM repair_state WHERE store_id='{门店ID}'",
                },
            },
        )
        missing_field = client.post(
            "/api/v1/rules",
            json={
                **payload,
                "name": "missing mapping",
                "sql_validation_config": {
                    **payload["sql_validation_config"],
                    "parameters": [{"name": "门店ID", "field": "missing_field"}],
                },
            },
        )
        assert mutating.status_code == 422
        assert "仅允许 SELECT" in mutating.json()["detail"]
        assert missing_field.status_code == 422
        assert "数据集字段不存在" in missing_field.json()["detail"]


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


def test_overview_and_list_filter_share_actual_in_transit_delivery_semantics():
    """Stale job states must not inflate either the overview or filtered list."""
    with TestClient(create_app(testing=True)) as client:
        dataset = create_dependencies(client)
        rule_id = client.post(
            "/api/v1/rules",
            json={
                "name": "推送途中统计",
                "dataset_id": dataset["id"],
                "severity": "high",
                "conditions": [{"field": "gmv", "operator": "gt", "value": 100}],
                "anomaly_key_fields": ["store_id"],
                "schedule": {
                    "frequency": "day", "interval": 1, "time": "09:00",
                    "start_date": "2026-08-09",
                },
                "notification_targets": [
                    {"receive_id_type": "open_id", "source": "literal", "value": "ou_1"},
                    {"receive_id_type": "open_id", "source": "literal", "value": "ou_2"},
                ],
                "validation_enabled": True,
                "validation_targets": [
                    {"source": "literal", "value": "validator-1"},
                ],
            },
        ).json()["id"]

        with client.app.state.session_factory() as session:
            rule = session.get(Rule, rule_id)
            persist_matches(session, rule, [
                EvaluationMatch(
                    row={"store_id": store_id, "gmv": 500},
                    business_key={"store_id": store_id},
                    matched_conditions=[{"field": "gmv", "operator": "gt", "actual": 500}],
                )
                for store_id in (
                    "partial", "sent", "cancelled", "active", "old", "aborted",
                    "resolved", "timed-out", "update-failed",
                )
            ])
            anomaly_ids = {
                anomaly.business_key["store_id"]: anomaly.id
                for anomaly in session.scalars(select(AnomalyRecord))
            }
            session.get(AnomalyRecord, anomaly_ids["active"]).severity = "medium"
            jobs_by_store = {
                store_id: list(session.scalars(
                    select(AnomalyPushJob).where(AnomalyPushJob.anomaly_id == anomaly_id)
                ))
                for store_id, anomaly_id in anomaly_ids.items()
            }

            deliveries = {
                store_id: list(session.scalars(select(NotificationDelivery).where(
                    NotificationDelivery.anomaly_id == anomaly_id,
                )))
                for store_id, anomaly_id in anomaly_ids.items()
            }
            validations = {
                store_id: list(session.scalars(select(AnomalyValidationRequest).where(
                    AnomalyValidationRequest.anomaly_id == anomaly_id,
                )))
                for store_id, anomaly_id in anomaly_ids.items()
            }

            for delivery in deliveries["partial"]:
                delivery.status = "sent"
            validations["partial"][0].delivery_status = "failed"
            for job in jobs_by_store["sent"]:
                job.status = "kafka_queued"
            for delivery in deliveries["sent"]:
                delivery.status = "sent"
            validations["sent"][0].delivery_status = "sent"
            for job in jobs_by_store["cancelled"]:
                job.cancel_requested = True
            deliveries["active"][0].status = "sending"
            deliveries["active"][1].status = "sent"
            validations["active"][0].delivery_status = "pending"
            for job in jobs_by_store["old"]:
                job.generation = 0
            for job in jobs_by_store["aborted"]:
                job.status = "aborted"
            for delivery in deliveries["aborted"]:
                delivery.status = "aborted"
            validations["aborted"][0].delivery_status = "aborted"
            for name, validation_status in (
                ("resolved", "resolved"),
                ("timed-out", "timed_out"),
                ("update-failed", "update_failed"),
            ):
                for delivery in deliveries[name]:
                    delivery.status = "sent"
                validations[name][0].delivery_status = validation_status
            session.commit()

        overview = client.get("/api/v1/overview")
        filtered = client.get("/api/v1/anomalies", params={
            "push_status": "in_transit", "severity": "high",
        })
        exported = client.get("/api/v1/anomalies/export", params={
            "push_status": "in_transit", "severity": "high",
        })

    assert overview.status_code == 200
    assert overview.json()["stats"]["push_in_transit_anomalies"] == 2
    assert filtered.status_code == 200
    assert filtered.json()["total"] == 1
    assert [item["id"] for item in filtered.json()["items"]] == [anomaly_ids["partial"]]
    assert exported.status_code == 200
    assert anomaly_ids["partial"] in exported.text
    assert anomaly_ids["sent"] not in exported.text


def test_anomaly_list_rejects_unknown_push_status():
    with TestClient(create_app(testing=True)) as client:
        response = client.get("/api/v1/anomalies", params={"push_status": "internal-code"})

    assert response.status_code == 422
