from copy import deepcopy

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import String

from app.config import Settings
from app.main import create_app
from app.models import AnomalyRecord, Dataset, Datasource, Rule, utcnow
from app.security import CredentialCipher
from app.validation_service import (
    SqlValidationExecutionError,
    snapshot_validation,
    submit_sql_validation,
)
from test_rule_anomaly_api import create_dependencies
from test_sql_validation import FakeCursor
from test_validation_service import NOW, build_session, make_anomaly


def sql_config(source_id):
    return {
        "datasource_id": source_id,
        "query_template": "SELECT status FROM repairs WHERE store_id='{门店ID}'",
        "parameters": [{"name": "门店ID", "field": "store_id"}],
        "true_condition": {"field": "status", "operator": "eq", "value": "normal"},
    }


@pytest.fixture
def api_context(monkeypatch):
    # Match MySQL's case-insensitive primary-key lookup without changing JSON comparisons.
    original_type = Datasource.__table__.c.id.type
    monkeypatch.setattr(Datasource.__table__.c.id, "type", String(36, collation="NOCASE"))
    with TestClient(create_app(testing=True)) as client:
        monkeypatch.setattr(Datasource.__table__.c.id, "type", original_type)
        dataset = create_dependencies(client)
        source = client.post("/api/v1/datasources", json={
            "name": "独立校验库", "type": "mysql", "host": "validation-db", "port": 3306,
            "database": "repairs", "username": "reader", "password": "secret", "ssl": False,
        }).json()
        with client.app.state.session_factory() as session:
            session.get(Dataset, dataset["id"]).fields = [{"name": "store_id", "type": "VARCHAR"}]
            session.commit()
        payload = {
            "name": "independent validation", "dataset_id": dataset["id"], "enabled": False,
            "conditions": [{"field": "store_id", "operator": "is_not_null"}],
            "anomaly_key_fields": ["store_id"],
            "schedule": {"frequency": "day", "time": "09:00", "start_date": "2026-08-29"},
            "notification_targets": [{"receive_id_type": "user_id", "source": "literal", "value": "user-1"}],
            "validation_enabled": True, "validation_targets": [{"source": "literal", "value": "user-1"}],
            "validation_method": "sql", "sql_validation_config": sql_config(source["id"]),
        }
        yield client, dataset, source, payload


def test_rule_api_roundtrips_independent_offline_source_and_can_change_it(api_context):
    client, dataset, source, payload = api_context
    assert source["status"] == "offline"
    created = client.post("/api/v1/rules", json=payload)
    assert created.status_code == 201, created.text
    rule_id = created.json()["id"]
    assert created.json()["sql_validation_config"]["datasource_id"] == source["id"]
    assert client.get(f"/api/v1/rules/{rule_id}").json()["sql_validation_config"]["datasource_id"] == source["id"]
    assert client.get("/api/v1/rules").json()[0]["sql_validation_config"]["datasource_id"] == source["id"]
    changed = deepcopy(payload)
    changed["sql_validation_config"]["datasource_id"] = dataset["datasource_id"]
    updated = client.put(f"/api/v1/rules/{rule_id}", json=changed)
    assert updated.status_code == 200, updated.text
    assert updated.json()["sql_validation_config"]["datasource_id"] == dataset["datasource_id"]


@pytest.mark.parametrize("source_value,expected", [(None, 422), ("", 422), ("  ", 422), ("missing", 404)])
def test_rule_api_rejects_invalid_source_on_create_and_update(api_context, source_value, expected):
    client, _, _, payload = api_context
    created = client.post("/api/v1/rules", json=payload)
    assert created.status_code == 201, created.text
    invalid = deepcopy(payload)
    invalid["name"] = "invalid source"
    invalid["sql_validation_config"]["datasource_id"] = source_value
    for response in (
        client.post("/api/v1/rules", json=invalid),
        client.put(f"/api/v1/rules/{created.json()['id']}", json=invalid),
    ):
        assert response.status_code == expected, response.text
    del invalid["sql_validation_config"]["datasource_id"]
    assert client.post("/api/v1/rules", json=invalid).status_code == 422
    assert client.put(f"/api/v1/rules/{created.json()['id']}", json=invalid).status_code == 422


def test_source_id_whitespace_is_normalized(api_context):
    client, _, source, payload = api_context
    payload["sql_validation_config"]["datasource_id"] = f"  {source['id']}  "
    response = client.post("/api/v1/rules", json=payload)
    assert response.status_code == 201, response.text
    assert response.json()["sql_validation_config"]["datasource_id"] == source["id"]


def test_source_id_alias_is_saved_as_canonical_id_on_create_and_update(api_context):
    client, dataset, source, payload = api_context
    payload["sql_validation_config"]["datasource_id"] = source["id"].upper()
    response = client.post("/api/v1/rules", json=payload)
    assert response.status_code == 201, response.text
    assert response.json()["sql_validation_config"]["datasource_id"] == source["id"]
    payload["sql_validation_config"]["datasource_id"] = dataset["datasource_id"].upper()
    updated = client.put(f"/api/v1/rules/{response.json()['id']}", json=payload)
    assert updated.status_code == 200, updated.text
    assert updated.json()["sql_validation_config"]["datasource_id"] == dataset["datasource_id"]


@pytest.mark.parametrize("reference", ["rule", "snapshot"])
def test_source_id_alias_cannot_bypass_deletion_protection(api_context, reference):
    client, dataset, source, payload = api_context
    created = client.post("/api/v1/rules", json=payload).json()
    if reference == "snapshot":
        with client.app.state.session_factory() as session:
            rule = session.get(Rule, created["id"])
            rule.sql_validation_config = sql_config(dataset["datasource_id"])
            anomaly = make_anomaly(rule)
            anomaly.validation_method_snapshot = "sql"
            anomaly.validation_config_snapshot = sql_config(source["id"])
            session.add(anomaly)
            session.commit()
    assert client.get(f"/api/v1/datasources/{source['id'].upper()}").status_code == 200
    assert client.delete(f"/api/v1/datasources/{source['id'].upper()}").status_code == 409


def test_deletion_protects_legacy_snapshot_with_dataset_source_alias(api_context):
    client, dataset, source, payload = api_context
    created = client.post("/api/v1/rules", json=payload).json()
    with client.app.state.session_factory() as session:
        rule = session.get(Rule, created["id"])
        legacy_config = sql_config(source["id"])
        del legacy_config["datasource_id"]
        rule.sql_validation_config = legacy_config
        rule.dataset.datasource_id = source["id"].upper()
        anomaly = make_anomaly(rule)
        session.add(anomaly)
        session.flush()
        snapshot_validation(session, rule, anomaly, now=NOW)
        assert anomaly.validation_config_snapshot["datasource_id"] == source["id"].upper()
        # The historical snapshot outlives the dataset's original reference.
        rule.dataset.datasource_id = dataset["datasource_id"]
        session.commit()
    assert client.delete(f"/api/v1/datasources/{source['id']}").status_code == 409


@pytest.fixture
def sql_session():
    engine, _, session, rule = build_session()
    try:
        source = Datasource(name="validation", type="mysql", host="validation-db", port=3306,
                            database="repairs", username="reader",
                            password_encrypted=CredentialCipher(Settings().datasource_encryption_key).encrypt("secret"))
        session.add(source)
        session.flush()
        rule.validation_enabled = True
        rule.validation_targets = [{"source": "literal", "value": "user-1"}]
        rule.validation_method = "sql"
        rule.dataset.fields = [{"name": "store_id", "type": "VARCHAR"}]
        rule.sql_validation_config = sql_config(source.id)
        anomaly = make_anomaly(rule)
        anomaly.row_details = {"store_id": "S'1"}
        session.add(anomaly)
        session.flush()
        yield session, rule, source, anomaly
    finally:
        session.close()
        engine.dispose()


def test_snapshot_executes_selected_source_with_original_anomaly_parameters(sql_session):
    session, rule, source, anomaly = sql_session
    snapshot_validation(session, rule, anomaly, now=NOW)
    assert anomaly.validation_config_snapshot["datasource_id"] == source.id
    assert rule.dataset.datasource_id != source.id
    assert anomaly.validation_config_snapshot["dataset_fields"] == ["store_id"]
    # Later configuration changes must not change the existing anomaly's database or parameter mapping.
    rule.sql_validation_config = sql_config(rule.dataset.datasource_id)
    rule.dataset.fields = [{"name": "other_field", "type": "VARCHAR"}]
    snapshot_validation(session, rule, anomaly, now=NOW)
    session.commit()

    class Connection:
        def __init__(self):
            self.query = FakeCursor([{"status": "normal"}])
            self.closed = False

        def cursor(self):
            return self.query

        def close(self):
            self.closed = True

    connection = Connection()
    connections = []

    def connect(datasource, password):
        connections.append((datasource.id, datasource.host, password))
        return connection

    result = submit_sql_validation(session, Settings(), anomaly.id, "user-1", connection_factory=connect, now=NOW)
    assert result.outcome == "accepted"
    assert connections == [(source.id, "validation-db", "secret")]
    assert connection.query.executed == ("SELECT status FROM repairs WHERE store_id=%s", ("S'1",))
    assert connection.closed


def test_legacy_rule_without_source_still_snapshots_dataset_source(sql_session):
    session, rule, _, anomaly = sql_session
    config = deepcopy(rule.sql_validation_config)
    del config["datasource_id"]
    rule.sql_validation_config = config
    snapshot_validation(session, rule, anomaly, now=NOW)
    assert anomaly.validation_config_snapshot["datasource_id"] == rule.dataset.datasource_id


@pytest.mark.parametrize("missing", [False, True])
def test_failed_or_missing_selected_source_never_falls_back(sql_session, missing):
    session, rule, source, anomaly = sql_session
    selected_id = source.id
    snapshot_validation(session, rule, anomaly, now=NOW)
    if missing:
        session.delete(source)
    session.commit()
    connections = []

    def connect(datasource, _password):
        connections.append(datasource.id)
        raise OSError("connection unavailable")

    with pytest.raises(SqlValidationExecutionError):
        submit_sql_validation(session, Settings(), anomaly.id, "user-1", connection_factory=connect, now=NOW)
    assert connections == ([] if missing else [selected_id])
    assert anomaly.status == "pending"
    assert anomaly.last_sql_validation_result["reason"] == ("configuration_error" if missing else "execution_error")


def test_deletion_is_blocked_by_disabled_rule_sql_config(api_context):
    client, _, source, payload = api_context
    created = client.post("/api/v1/rules", json=payload).json()
    # Seed the saved JSON explicitly so this test exercises deletion independently of the write contract.
    with client.app.state.session_factory() as session:
        rule = session.get(Rule, created["id"])
        rule.sql_validation_config = sql_config(source["id"])
        rule.validation_enabled = False
        session.commit()
    assert client.delete(f"/api/v1/datasources/{source['id']}").status_code == 409
    assert client.get(f"/api/v1/datasources/{source['id']}").status_code == 200
    assert client.delete(f"/api/v1/rules/{created['id']}").status_code == 204
    assert client.delete(f"/api/v1/datasources/{source['id']}").status_code == 204


@pytest.mark.parametrize("status", ["pending", "processing", "timed_out"])
@pytest.mark.parametrize("release", ["resolved", "deleted_rule"])
def test_deletion_protects_retryable_snapshots_after_rule_changes(api_context, status, release):
    client, dataset, source, payload = api_context
    created = client.post("/api/v1/rules", json=payload).json()
    with client.app.state.session_factory() as session:
        rule = session.get(Rule, created["id"])
        rule.sql_validation_config = sql_config(dataset["datasource_id"])
        anomaly = make_anomaly(rule, status=status)
        anomaly.validation_method_snapshot = "sql"
        anomaly.validation_config_snapshot = sql_config(source["id"])
        session.add(anomaly)
        session.commit()
        anomaly_id = anomaly.id
    assert client.delete(f"/api/v1/datasources/{source['id']}").status_code == 409
    with client.app.state.session_factory() as session:
        if release == "resolved":
            session.get(AnomalyRecord, anomaly_id).status = "resolved"
        else:
            session.get(Rule, created["id"]).deleted_at = utcnow()
        session.commit()
    assert client.delete(f"/api/v1/datasources/{source['id']}").status_code == 204
