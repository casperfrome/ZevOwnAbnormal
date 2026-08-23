import pytest
from types import SimpleNamespace
from sqlalchemy import select

from app.config import Settings
from app.execution_service import execute_rule
from app.models import AnomalyRecord, AnomalyRecordGroup, Dataset, Datasource, Rule, RuleRun


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
    monkeypatch.setattr(
        "app.execution_service.persist_matches",
        lambda *_args, **_kwargs: SimpleNamespace(new_count=1, records=[]),
    )
    monkeypatch.setattr("app.execution_service.deliver_notifications", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("direct send")))

    run = execute_rule(db_session, Settings(), rule.id, "manual")

    assert run.status == "success"
    assert run.new_anomalies == 1


@pytest.mark.parametrize("trigger_source", ["manual", "dolphinscheduler"])
def test_every_successful_rule_execution_creates_a_group_even_without_matches(
    db_session, monkeypatch, trigger_source,
):
    """Skipping empty runs or one trigger source must fail this test."""
    datasource = Datasource(
        name=f"source-{trigger_source}", type="starrocks", host="localhost", port=9030,
        database="ads", username="root", password_encrypted="",
    )
    dataset = Dataset(name=f"dataset-{trigger_source}", datasource=datasource, sql="SELECT 1", fields=[])
    rule = Rule(
        name=f"rule-{trigger_source}", dataset=dataset, severity="medium", logic="AND",
        conditions=[{"field": "gmv", "operator": "gt", "value": 10}],
        anomaly_key_fields=["store_id"], schedule={"frequency": "day"},
        notification_targets=[{"receive_id_type": "user_id", "source": "literal", "value": "owner"}],
    )
    db_session.add(rule)
    db_session.commit()
    connection = SimpleNamespace(close=lambda: None)
    monkeypatch.setattr("app.execution_service.connect_to_datasource", lambda *_args: connection)
    monkeypatch.setattr(
        "app.execution_service.fetch_rule_rows",
        lambda *_args: ([{"name": "store_id", "type": "int"}, {"name": "gmv", "type": "int"}], []),
    )

    run = execute_rule(db_session, Settings(_env_file=None), rule.id, trigger_source)
    group = db_session.scalar(select(AnomalyRecordGroup).where(AnomalyRecordGroup.run_id == run.id))

    assert run.status == "success"
    assert group is not None
    assert group.rule_id == rule.id
    assert group.detected_at == run.started_at
    assert group.matched_rows == 0


def test_group_persistence_failure_rolls_back_anomalies_and_marks_run_failed(db_session, monkeypatch):
    """Committing anomalies before their group would leave an ungrouped successful detection."""
    datasource = Datasource(
        name="atomic-source", type="starrocks", host="localhost", port=9030,
        database="ads", username="root", password_encrypted="",
    )
    dataset = Dataset(name="atomic-dataset", datasource=datasource, sql="SELECT 1", fields=[])
    rule = Rule(
        name="atomic-rule", dataset=dataset, severity="high", logic="AND",
        conditions=[{"field": "gmv", "operator": "gt", "value": 10}],
        anomaly_key_fields=["store_id"], schedule={"frequency": "day"},
        notification_targets=[{"receive_id_type": "user_id", "source": "literal", "value": "owner"}],
    )
    db_session.add(rule)
    db_session.commit()
    monkeypatch.setattr(
        "app.execution_service.connect_to_datasource",
        lambda *_args: SimpleNamespace(close=lambda: None),
    )
    monkeypatch.setattr(
        "app.execution_service.fetch_rule_rows",
        lambda *_args: (
            [{"name": "store_id", "type": "int"}, {"name": "gmv", "type": "int"}],
            [{"store_id": 1, "gmv": 99}],
        ),
    )
    monkeypatch.setattr(
        "app.execution_service.create_anomaly_group",
        lambda *_args: (_ for _ in ()).throw(RuntimeError("group insert failed")),
    )

    run = execute_rule(db_session, Settings(_env_file=None), rule.id, "manual")

    assert run.status == "failed"
    assert run.error_message == "group insert failed"
    assert list(db_session.scalars(select(AnomalyRecord))) == []
