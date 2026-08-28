from sqlalchemy import select

from app.anomaly_service import persist_matches, resolve_targets
from app.config import Settings
from app.database import Base, make_session_factory
from app.execution_service import deliver_notifications
from app.models import AnomalyRecord, Dataset, Datasource, NotificationDelivery, Rule
from app.rule_engine import EvaluationMatch


def test_repeat_push_creates_unique_occurrences_even_with_frozen_time(monkeypatch):
    from datetime import datetime
    from app.models import AnomalyPushJob, AnomalyValidationRequest
    session, rule = build_session()
    rule.repeat_push_enabled = True
    rule.validation_enabled = True
    rule.validation_targets = [{"source": "literal", "value": "handler"}]
    session.commit()
    monkeypatch.setattr("app.anomaly_service.utcnow", lambda: datetime(2026, 8, 28, 10))
    match = EvaluationMatch(row={"store_id": "S1"}, business_key={"store_id": "S1"}, matched_conditions=[])
    first = persist_matches(session, rule, [match, match])
    second = persist_matches(session, rule, [match])
    assert (first.new_count, second.new_count) == (2, 1)
    records = list(session.scalars(select(AnomalyRecord)))
    assert len({record.fingerprint for record in records}) == 3
    assert all(record.business_key["store_id"] == "S1" for record in records)
    assert all(record.business_key["__detected_at"] == "2026-08-28T10:00:00.000000Z" for record in records)
    assert len(list(session.scalars(select(AnomalyValidationRequest)))) == 3
    assert len(list(session.scalars(select(AnomalyPushJob)))) == 6
    assert len(first.new_record_ids) == 2
    rule.repeat_push_enabled = False
    session.commit()
    assert persist_matches(session, rule, [match]).new_count == 1
    assert persist_matches(session, rule, [match]).new_count == 0


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
        def __init__(self, *_, **__): pass
        def send_text(self, *_, **__): return "om_retry"
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
        def __init__(self, *_, **__): pass
        def send_text(self, *_, **__): return "om_direct"
        def close(self): pass

    def shared_sender(app_id, app_secret, receive_id_type, recipient, text, *, client=None, idempotency_key=None):
        calls.append((app_id, app_secret, receive_id_type, recipient, text, client, idempotency_key))
        return "om_shared"

    monkeypatch.setattr("app.execution_service.FeishuClient", DirectClient)
    monkeypatch.setattr("app.feishu.send_configured_text", shared_sender)

    failures = deliver_notifications(session, Settings(feishu_app_id="cli", feishu_app_secret="secret"), rule_id=rule.id)

    assert failures == 0
    assert delivery.message_id == "om_shared"
    assert len(calls) == 1
    assert calls[0][:4] == ("cli", "secret", "open_id", "ou_owner")
    assert calls[0][5].__class__ is DirectClient
    assert calls[0][6] == delivery.id


def test_custom_private_template_sends_an_interactive_card_with_the_delivery_idempotency_key(monkeypatch):
    """Falling back to text or dropping the rendered record link must fail this delivery test."""
    session, rule = build_session()
    rule.private_message_template = "异常记录：{store_id}\nGMV：{gmv}\n[查看明细]({异常记录链接})"
    session.commit()
    match = EvaluationMatch(
        row={"store_id": "S1", "gmv": 500},
        business_key={"store_id": "S1"},
        matched_conditions=[],
    )
    persist_matches(session, rule, [match])
    delivery = session.scalar(select(NotificationDelivery))
    cards = []

    class CardClient:
        def __init__(self, *_, **__): pass
        def send_interactive(self, receive_id_type, recipient, card, *, idempotency_key=None):
            cards.append((receive_id_type, recipient, card, idempotency_key))
            return "om_card"
        def close(self): pass

    monkeypatch.setattr("app.execution_service.FeishuClient", CardClient)

    failures = deliver_notifications(
        session,
        Settings(
            _env_file=None,
            feishu_app_id="cli",
            feishu_app_secret="secret",
            sentinel_public_base_url="https://sentinel.example/base/",
        ),
        rule_id=rule.id,
    )

    assert failures == 0
    assert delivery.message_id == "om_card"
    assert cards[0][0:2] == ("open_id", "ou_owner")
    assert cards[0][3] == delivery.id
    markdown = cards[0][2]["body"]["elements"][0]["content"]
    assert markdown == (
        f"异常记录：S1\nGMV：500\n"
        f"[查看明细](https://sentinel.example/base/#records/{delivery.anomaly_id})"
    )
