from sqlalchemy import select

from app.anomaly_service import persist_matches, resolve_targets
from app.config import Settings
from app.database import Base, make_session_factory
from app.execution_service import deliver_notifications
from app.models import AnomalyRecord, Dataset, Datasource, NotificationDelivery, Rule
from app.rule_engine import EvaluationMatch


def build_session():
    engine, factory = make_session_factory("sqlite+pysqlite:///:memory:", testing=True)
    Base.metadata.create_all(engine)
    session = factory()
    datasource = Datasource(
        name="ADS", type="starrocks", host="localhost", port=9030,
        database="ads", username="root", password_encrypted="",
    )
    dataset = Dataset(name="daily", datasource=datasource, sql="SELECT 1", fields=[])
    rule = Rule(
        name="high gmv", dataset=dataset, severity="high", logic="AND",
        conditions=[{"field": "gmv", "operator": "gt", "value": 100}],
        anomaly_key_fields=["store_id", "metric_date"], schedule={"frequency": "day"},
        notification_targets=[{"receive_id_type": "open_id", "source": "literal", "value": "ou_owner"}],
    )
    session.add(rule)
    session.commit()
    return session, rule


def test_active_anomaly_is_updated_without_duplicate_delivery():
    session, rule = build_session()
    match = EvaluationMatch(
        row={"store_id": "S1", "metric_date": "2026-08-09", "gmv": 500},
        business_key={"store_id": "S1", "metric_date": "2026-08-09"},
        matched_conditions=[{"field": "gmv", "matched": True}],
    )

    first = persist_matches(session, rule, [match])
    second = persist_matches(session, rule, [match])

    records = list(session.scalars(select(AnomalyRecord)))
    assert first.new_count == 1
    assert second.new_count == 0
    assert len(records) == 1
    assert records[0].hit_count == 2
    assert len(first.delivery_ids) == 1
    assert second.delivery_ids == []


def test_resolved_anomaly_releases_active_key_for_realert():
    session, rule = build_session()
    match = EvaluationMatch(
        row={"store_id": "S1", "metric_date": "2026-08-09", "gmv": 500},
        business_key={"store_id": "S1", "metric_date": "2026-08-09"},
        matched_conditions=[{"field": "gmv", "matched": True}],
    )
    persist_matches(session, rule, [match])
    record = session.scalar(select(AnomalyRecord))
    record.status = "resolved"
    record.active_fingerprint = None
    session.commit()

    result = persist_matches(session, rule, [match])

    assert result.new_count == 1
    assert len(list(session.scalars(select(AnomalyRecord)))) == 2


def test_targets_can_come_from_literal_or_dataset_field():
    row = {"manager_open_id": "ou_manager"}
    targets = [
        {"receive_id_type": "open_id", "source": "literal", "value": "ou_fixed"},
        {"receive_id_type": "open_id", "source": "field", "field": "manager_open_id"},
    ]

    assert resolve_targets(targets, row) == [
        ("open_id", "ou_fixed"),
        ("open_id", "ou_manager"),
    ]


def test_failed_delivery_is_retried_on_later_rule_run(monkeypatch):
    session, rule = build_session()
    match = EvaluationMatch(row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"}, matched_conditions=[])
    persist_matches(session, rule, [match])
    delivery = session.scalar(select(NotificationDelivery))
    delivery.status = "failed"
    delivery.attempts = 3
    session.commit()

    class SuccessfulClient:
        def __init__(self, *_): pass
        def send_text(self, *_): return "om_retry"
        def close(self): pass

    monkeypatch.setattr("app.execution_service.FeishuClient", SuccessfulClient)
    failures = deliver_notifications(session, Settings(feishu_app_id="cli", feishu_app_secret="secret"), rule_id=rule.id)

    assert failures == 0
    assert delivery.status == "sent"
    assert delivery.attempts == 4


def test_rule_delivery_uses_shared_configured_sender(monkeypatch):
    session, rule = build_session()
    match = EvaluationMatch(row={"store_id": "S1", "gmv": 500}, business_key={"store_id": "S1"}, matched_conditions=[])
    persist_matches(session, rule, [match])
    delivery = session.scalar(select(NotificationDelivery))
    calls = []

    class DirectClient:
        def __init__(self, *_): pass
        def send_text(self, *_): return "om_direct"
        def close(self): pass

    def shared_sender(app_id, app_secret, receive_id_type, recipient, text, *, client=None):
        calls.append((app_id, app_secret, receive_id_type, recipient, text, client))
        return "om_shared"

    monkeypatch.setattr("app.execution_service.FeishuClient", DirectClient)
    monkeypatch.setattr("app.feishu.send_configured_text", shared_sender)

    failures = deliver_notifications(session, Settings(feishu_app_id="cli", feishu_app_secret="secret"), rule_id=rule.id)

    assert failures == 0
    assert delivery.message_id == "om_shared"
    assert len(calls) == 1
    assert calls[0][:4] == ("cli", "secret", "open_id", "ou_owner")
    assert calls[0][5].__class__ is DirectClient
