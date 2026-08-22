import pytest
from types import SimpleNamespace
from sqlalchemy import select

from app.config import Settings
from app.execution_service import execute_rule
from app.models import Dataset, Datasource, Rule, RuleRun


def test_same_rule_cannot_start_while_database_lock_is_held(db_session, monkeypatch):
    datasource = Datasource(
        name="ADS", type="starrocks", host="localhost", port=9030,
        database="ads", username="root", password_encrypted="",
    )
    dataset = Dataset(name="daily", datasource=datasource, sql="SELECT 1", fields=[])
    rule = Rule(
        name="GMV3500", dataset=dataset, severity="medium", logic="AND",
        conditions=[{"field": "gmv", "operator": "lt", "value": 3500}],
        anomaly_key_fields=["store_id"], schedule={"frequency": "day"},
        notification_targets=[{"receive_id_type": "user_id", "source": "literal", "value": "owner"}],
    )
    db_session.add(rule)
    db_session.commit()
    monkeypatch.setattr("app.execution_service._acquire_rule_lock", lambda *_args: False, raising=False)

    with pytest.raises(ValueError, match="正在执行"):
        execute_rule(db_session, Settings(), rule.id, "manual")

    assert list(db_session.scalars(select(RuleRun))) == []


def test_rule_execution_stops_after_persisting_push_jobs_without_direct_delivery(db_session, monkeypatch):
    datasource = Datasource(
        name="queued-ads", type="starrocks", host="localhost", port=9030,
        database="ads", username="root", password_encrypted="",
    )
    dataset = Dataset(name="queued-daily", datasource=datasource, sql="SELECT 1", fields=[])
    rule = Rule(
        name="queued-rule", dataset=dataset, severity="medium", logic="AND",
        conditions=[{"field": "gmv", "operator": "gt", "value": 1}],
        anomaly_key_fields=["store_id"], schedule={"frequency": "day"},
        notification_targets=[{"receive_id_type": "user_id", "source": "literal", "value": "owner"}],
    )
    db_session.add(rule)
    db_session.commit()
    connection = SimpleNamespace(close=lambda: None)
    monkeypatch.setattr("app.execution_service.connect_to_datasource", lambda *_args: connection)
    monkeypatch.setattr("app.execution_service.fetch_rule_rows", lambda *_args: ([{"name": "gmv", "type": "int"}], [{"gmv": 2}]))
    monkeypatch.setattr("app.execution_service.evaluate_rows", lambda *_args: [object()])
    monkeypatch.setattr("app.execution_service.persist_matches", lambda *_args: SimpleNamespace(new_count=1))
    monkeypatch.setattr("app.execution_service.deliver_notifications", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("direct send")))

    run = execute_rule(db_session, Settings(), rule.id, "manual")

    assert run.status == "success"
    assert run.new_anomalies == 1
