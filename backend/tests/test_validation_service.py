from __future__ import annotations

import json
import threading
from datetime import datetime, timedelta
from decimal import Decimal

import httpx
import pytest
from sqlalchemy import event, select, update

from app.config import Settings
from app.database import Base, make_session_factory
from app.feishu import FeishuClient, FeishuDeliveryUncertainError, FeishuError
from app.models import (
    AnomalyEvent,
    AnomalyRecord,
    AnomalyValidationRequest,
    AnomalyValidationSubmission,
    Dataset,
    Datasource,
    NotificationDelivery,
    Rule,
    utcnow,
)
from app.rule_engine import EvaluationMatch


NOW = datetime(2026, 8, 22, 4, 0, 0)


class FakeSqlCursor:
    def __init__(self, rows):
        self.rows = list(rows)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, _sql, _values):
        return None

    def fetchmany(self, size):
        return self.rows[:size]


class FakeConnection:
    def __init__(self, rows):
        self.rows = rows
        self.closed = False

    def cursor(self):
        return FakeSqlCursor(self.rows)

    def close(self):
        self.closed = True


def build_session(database_url="sqlite+pysqlite:///:memory:", *, testing=True):
    engine, factory = make_session_factory(database_url, testing=testing)
    Base.metadata.create_all(engine)
    session = factory()
    datasource = Datasource(
        name="source", type="starrocks", host="localhost", port=9030,
        database="ads", username="root", password_encrypted="",
    )
    dataset = Dataset(name="daily sales", datasource=datasource, sql="SELECT 1", fields=[])
    rule = Rule(
        name="high GMV", description="GMV exceeded the expected range", dataset=dataset,
        severity="high", conditions=[], anomaly_key_fields=["store_id"],
        schedule={"frequency": "day"}, notification_targets=[],
    )
    session.add(rule)
    session.commit()
    return engine, factory, session, rule


def make_anomaly(rule: Rule, *, status="pending") -> AnomalyRecord:
    anomaly = AnomalyRecord(
        rule_id=rule.id, rule_name=rule.name, dataset_name=rule.dataset.name,
        severity=rule.severity, status=status, fingerprint="f" * 64,
        active_fingerprint="f" * 64, business_key={"store_id": "S1"},
        row_details={"owner_id": " user-2 ", "backup_id": ""}, matched_conditions=[],
        first_seen_at=NOW, last_seen_at=NOW,
    )
    return anomaly


def test_new_anomaly_waits_for_delivery_and_snapshots_deadline(monkeypatch):
    from app.anomaly_service import persist_matches
    from app.rule_engine import EvaluationMatch
    from app.validation_service import snapshot_validation

    engine, _, session, rule = build_session()
    try:
        rule.validation_enabled = True
        rule.validation_targets = [{"source": "literal", "value": "owner"}]
        rule.deadline_seconds = 61
        session.commit()
        result = persist_matches(session, rule, [EvaluationMatch(
            row={"store_id": "S1"}, business_key={"store_id": "S1"}, matched_conditions=[]
        )])
        anomaly = result.records[0]
        assert anomaly.validation_deadline is None
        assert anomaly.deadline_seconds_snapshot == 61
        rule.deadline_seconds = 900
        snapshot_validation(session, rule, anomaly, now=NOW)
        assert anomaly.deadline_seconds_snapshot == 61
    finally:
        session.close()
        engine.dispose()


def test_delivery_starts_shared_deadline_once_and_refreshes_card():
    from app.validation_service import _finish_validation_delivery, _card_needs_update
    engine, _, session, rule = build_session()
    try:
        anomaly = make_anomaly(rule)
        anomaly.deadline_seconds_snapshot = 61
        session.add(anomaly)
        session.flush()
        requests = [AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id=user,
                    delivery_status="sending") for user in ("a", "b")]
        session.add_all(requests)
        session.commit()
        assert _finish_validation_delivery(session, requests[0].id, "pending", "m-a", NOW)
        session.refresh(anomaly)
        assert anomaly.first_delivered_at == NOW
        assert anomaly.validation_deadline == NOW + timedelta(seconds=61)
        assert _finish_validation_delivery(session, requests[1].id, "pending", "m-b", NOW + timedelta(seconds=20))
        session.refresh(anomaly)
        assert anomaly.validation_deadline == NOW + timedelta(seconds=61)
        assert session.scalar(select(AnomalyValidationRequest.id).join(AnomalyRecord).where(_card_needs_update()))
    finally:
        session.close()
        engine.dispose()


def test_ordinary_delivery_starts_deadline_only_after_success(monkeypatch):
    from types import SimpleNamespace
    from app.anomaly_service import persist_matches
    from app.rule_engine import EvaluationMatch
    from app.execution_service import deliver_notifications
    engine, _, session, rule = build_session()
    try:
        rule.deadline_seconds = 93784
        rule.notification_targets = [{"receive_id_type": "user_id", "source": "literal", "value": "owner"}]
        session.commit()
        record = persist_matches(session, rule, [EvaluationMatch(row={"store_id": "S1"},
            business_key={"store_id": "S1"}, matched_conditions=[])]).records[0]
        monkeypatch.setattr("app.execution_service.FeishuClient", lambda *a, **k: SimpleNamespace(close=lambda: None))
        monkeypatch.setattr("app.execution_service.time.sleep", lambda _: None)
        def fail(*args, **kwargs):
            raise RuntimeError("delivery rejected")
        monkeypatch.setattr("app.execution_service.feishu_gateway.send_configured_text", fail)
        assert deliver_notifications(session, Settings(_env_file=None)) == 1
        session.refresh(record)
        assert record.validation_deadline is None
        rule.deadline_seconds = 10
        session.commit()
        monkeypatch.setattr("app.execution_service.feishu_gateway.send_configured_text", lambda *a, **k: "message")
        monkeypatch.setattr("app.execution_service.utcnow", lambda: NOW)
        assert deliver_notifications(session, Settings(_env_file=None)) == 0
        session.refresh(record)
        assert record.first_delivered_at == NOW
        assert record.validation_deadline == NOW + timedelta(days=1, hours=2, minutes=3, seconds=4)
        assert record.validation_method_snapshot is None
        record.status = "timed_out"
        late = NotificationDelivery(anomaly_id=record.id, receive_id_type="user_id", recipient="late-owner")
        session.add(late)
        session.commit()
        assert deliver_notifications(session, Settings(_env_file=None)) == 0
        session.refresh(late)
        assert late.status == "sent"
        assert record.validation_deadline == NOW + timedelta(days=1, hours=2, minutes=3, seconds=4)
    finally:
        session.close()
        engine.dispose()


@pytest.mark.parametrize("status,snapshot", [("resolved", 1), ("pending", None)])
def test_deadline_does_not_start_for_resolved_or_historical_records(status, snapshot):
    from app.deadline_service import start_deadline
    engine, _, session, rule = build_session()
    try:
        record = make_anomaly(rule, status=status)
        record.deadline_seconds_snapshot = snapshot
        session.add(record)
        session.commit()
        assert start_deadline(session, record.id, NOW) is False
        session.commit()
        assert record.validation_deadline is None
    finally:
        session.close()
        engine.dispose()


def test_concurrent_delivery_confirmations_only_start_one_deadline(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from app.deadline_service import start_deadline
    engine, factory, session, rule = build_session(f"sqlite+pysqlite:///{tmp_path / 'delivery-race.sqlite'}", testing=False)
    try:
        record = make_anomaly(rule)
        record.deadline_seconds_snapshot = 1
        session.add(record)
        session.commit()
        record_id = record.id
        gate = Barrier(2)
        def confirm():
            with factory() as contender:
                gate.wait(timeout=5)
                changed = start_deadline(contender, record_id, NOW)
                contender.commit()
                return changed
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: confirm(), range(2)))
        assert sorted(results) == [False, True]
        session.refresh(record)
        assert record.validation_deadline == NOW + timedelta(seconds=1)
        assert record.validation_result_version == 1
    finally:
        session.close()
        engine.dispose()


def test_snapshot_creates_ordered_unique_requests_and_suppresses_matching_legacy_text():
    """Removing target normalization, snapshots, or same-user suppression must fail."""
    from app.validation_service import snapshot_validation

    engine, _, session, rule = build_session()
    try:
        rule.validation_enabled = True
        rule.validation_timeout_minutes = 30
        rule.validation_targets = [
            {"source": "literal", "value": " user-1 "},
            {"source": "field", "field": "owner_id"},
            {"source": "literal", "value": "user-1"},
            {"source": "field", "field": "backup_id"},
        ]
        anomaly = make_anomaly(rule)
        session.add(anomaly)
        session.flush()
        session.add_all([
            NotificationDelivery(anomaly_id=anomaly.id, receive_id_type="user_id", recipient="user-1"),
            NotificationDelivery(anomaly_id=anomaly.id, receive_id_type="open_id", recipient="user-1"),
            NotificationDelivery(anomaly_id=anomaly.id, receive_id_type="user_id", recipient="user-3"),
        ])

        recipients = snapshot_validation(session, rule, anomaly, now=NOW)
        session.commit()

        assert recipients == ["user-1", "user-2"]
        assert anomaly.description == "GMV exceeded the expected range"
        assert anomaly.validation_deadline is None
        assert anomaly.validation_method_snapshot == "pseudo"
        assert anomaly.validation_config_snapshot == {}
        assert [request.recipient_user_id for request in session.scalars(
            select(AnomalyValidationRequest).order_by(AnomalyValidationRequest.created_at)
        )] == ["user-1", "user-2"]
        assert [(item.receive_id_type, item.recipient) for item in session.scalars(
            select(NotificationDelivery).order_by(NotificationDelivery.recipient, NotificationDelivery.receive_id_type)
        )] == [("open_id", "user-1"), ("user_id", "user-3")]
        events = list(session.scalars(select(AnomalyEvent)))
        assert [event.event_type for event in events] == ["validation_requested"]
        assert events[0].description == "已创建 2 位验证人的实时验证请求，待发送"
    finally:
        session.close()
        engine.dispose()


def test_disabled_validation_does_not_snapshot_or_create_requests():
    """Accidentally applying current rule validation settings to disabled anomalies must fail."""
    from app.validation_service import snapshot_validation

    engine, _, session, rule = build_session()
    try:
        rule.validation_enabled = False
        rule.description = "must not be copied"
        anomaly = make_anomaly(rule)
        session.add(anomaly)
        session.flush()

        assert snapshot_validation(session, rule, anomaly, now=NOW) == []
        session.commit()

        assert anomaly.description == ""
        assert anomaly.validation_deadline is None
        assert list(session.scalars(select(AnomalyValidationRequest))) == []
    finally:
        session.close()
        engine.dispose()


def test_missing_row_field_target_creates_no_validation_request():
    """A configured field absent from the anomaly row must not become a recipient."""
    from app.validation_service import snapshot_validation

    engine, _, session, rule = build_session()
    try:
        rule.validation_enabled = True
        rule.validation_targets = [{"source": "field", "field": "missing_user_id"}]
        anomaly = make_anomaly(rule)
        assert "missing_user_id" not in anomaly.row_details
        session.add(anomaly)
        session.flush()

        assert snapshot_validation(session, rule, anomaly, now=NOW) == []
        session.commit()

        assert list(session.scalars(select(AnomalyValidationRequest))) == []
    finally:
        session.close()
        engine.dispose()


def test_snapshot_is_idempotent_for_anomaly_recipient_pairs():
    """Retrying snapshot creation must not violate the request uniqueness contract."""
    from app.validation_service import snapshot_validation

    engine, _, session, rule = build_session()
    try:
        rule.validation_enabled = True
        rule.validation_targets = [{"source": "literal", "value": "user-1"}]
        anomaly = make_anomaly(rule)
        session.add(anomaly)
        session.flush()

        assert snapshot_validation(session, rule, anomaly, now=NOW) == ["user-1"]
        session.commit()
        session.add(NotificationDelivery(
            anomaly_id=anomaly.id, receive_id_type="user_id", recipient="user-1",
        ))
        session.commit()
        assert snapshot_validation(session, rule, anomaly, now=NOW) == ["user-1"]
        session.commit()

        assert len(list(session.scalars(select(AnomalyValidationRequest)))) == 1
        assert len(list(session.scalars(select(AnomalyEvent)))) == 1
        assert list(session.scalars(select(NotificationDelivery))) == []
    finally:
        session.close()
        engine.dispose()


def test_persisting_a_match_initializes_validation_before_legacy_notifications():
    """Bypassing validation initialization in anomaly persistence must duplicate same-user messages."""
    from app.anomaly_service import persist_matches

    engine, _, session, rule = build_session()
    try:
        rule.validation_enabled = True
        rule.validation_timeout_minutes = 15
        rule.validation_targets = [{"source": "field", "field": "owner_id"}]
        rule.notification_targets = [
            {"receive_id_type": "user_id", "source": "field", "field": "owner_id"},
            {"receive_id_type": "open_id", "source": "literal", "value": "ou_ops"},
        ]
        match = EvaluationMatch(
            row={"store_id": "S1", "owner_id": "user-1"},
            business_key={"store_id": "S1"},
            matched_conditions=[],
        )

        result = persist_matches(session, rule, [match])

        assert result.records[0].description == rule.description
        assert result.records[0].validation_deadline is None
        assert result.records[0].deadline_seconds_snapshot == 86400
        assert [item.recipient_user_id for item in session.scalars(select(AnomalyValidationRequest))] == ["user-1"]
        assert [(item.receive_id_type, item.recipient) for item in session.scalars(select(NotificationDelivery))] == [
            ("open_id", "ou_ops"),
        ]
    finally:
        session.close()
        engine.dispose()


def test_cards_show_active_controls_timeout_and_read_only_resolution():
    """Dropping required card facts, deep link, input, action, or resolution details must fail."""
    from app.validation_service import build_validation_card

    engine, _, session, rule = build_session()
    try:
        anomaly = make_anomaly(rule)
        anomaly.description = rule.description
        anomaly.validation_deadline = NOW + timedelta(minutes=30)
        session.add(anomaly)
        session.commit()

        active = build_validation_card(anomaly, "https://sentinel.example/base/")
        active_text = json.dumps(active, ensure_ascii=False)
        assert all(value in active_text for value in (
            anomaly.description, anomaly.rule_name, anomaly.dataset_name, anomaly.severity,
            "2026-08-22 04:30:00", f"https://sentinel.example/base/#records/{anomaly.id}",
        ))
        form = next(element for element in active["body"]["elements"] if element["tag"] == "form")
        input_element = next(element for element in form["elements"] if element["tag"] == "input")
        button = next(element for element in form["elements"] if element["tag"] == "button")
        assert input_element["name"] == "validation_text"
        assert input_element["required"] is True
        names = [form["name"], *(element["name"] for element in form["elements"])]
        assert len(names) == len(set(names))
        assert button["name"] == "submit_validation"
        assert button["form_action_type"] == "submit"
        assert button["behaviors"] == [{
            "type": "callback",
            "value": {"action": "submit_validation", "anomaly_id": anomaly.id},
        }]
        assert "action_type" not in button
        assert "value" not in button

        anomaly.status = "timed_out"
        timeout_text = json.dumps(build_validation_card(anomaly, "https://sentinel.example"), ensure_ascii=False)
        assert "已超时" in timeout_text
        assert "validation_text" in timeout_text

        anomaly.status = "resolved"
        anomaly.resolved_by_user_id = "user-2"
        anomaly.resolved_at = NOW + timedelta(minutes=10)
        resolved_text = json.dumps(build_validation_card(anomaly, "https://sentinel.example"), ensure_ascii=False)
        assert "user-2" in resolved_text
        assert "2026-08-22 04:10:00" in resolved_text
        assert "validation_text" not in resolved_text
        assert "form_action_type" not in resolved_text
    finally:
        session.close()
        engine.dispose()


def test_sql_snapshot_is_immutable_and_card_only_exposes_processed_action():
    """Reading edited rule SQL or retaining the pseudo text input must fail this test."""
    from app.validation_service import build_validation_card, snapshot_validation

    engine, _, session, rule = build_session()
    try:
        rule.validation_enabled = True
        rule.validation_targets = [{"source": "literal", "value": "user-1"}]
        rule.validation_method = "sql"
        rule.private_message_template = (
            "异常记录：{store_id}\nGMV：{gmv}\n[查看明细]({异常记录链接})"
        )
        rule.sql_validation_config = {
            "query_template": "SELECT status FROM repair_state WHERE store_id='{门店ID}'",
            "parameters": [{"name": "门店ID", "field": "store_id"}],
            "true_condition": {"field": "status", "operator": "eq", "value": "normal"},
        }
        anomaly = make_anomaly(rule)
        anomaly.deadline_seconds_snapshot = 61
        anomaly.row_details["store_id"] = "S1"
        anomaly.row_details["gmv"] = 500
        session.add(anomaly)
        session.flush()

        snapshot_validation(session, rule, anomaly, now=NOW)
        original_query = anomaly.validation_config_snapshot["query_template"]
        rule.sql_validation_config["query_template"] = "SELECT changed FROM elsewhere"

        card = build_validation_card(anomaly, "https://sentinel.example")
        card_text = json.dumps(card, ensure_ascii=False)
        button = next(
            element
            for element in card["body"]["elements"]
            if element["tag"] == "button"
        )
        assert anomaly.validation_method_snapshot == "sql"
        assert original_query.startswith("SELECT status")
        assert anomaly.validation_config_snapshot["query_template"] == original_query
        assert anomaly.validation_config_snapshot["datasource_id"] == rule.dataset.datasource_id
        assert anomaly.validation_config_snapshot["dataset_fields"] == []
        assert anomaly.validation_config_snapshot["private_message_template"] == rule.private_message_template
        assert "异常记录：S1" in card_text
        assert "GMV：500" in card_text
        assert "首次推送成功后 0 天 0 小时 1 分钟 1 秒" in card_text
        assert f"https://sentinel.example/#records/{anomaly.id}" in card_text
        assert "validation_text" not in card_text
        assert button["text"]["content"] == "已处理"
        assert button["behaviors"] == [{
            "type": "callback",
            "value": {"action": "run_sql_validation", "anomaly_id": anomaly.id},
        }]
    finally:
        session.close()
        engine.dispose()


def test_sql_validation_failure_keeps_anomaly_retryable_and_success_records_details():
    """Resolving on a false condition or failing to persist a passing comparison must fail this test."""
    from app.validation_service import build_validation_card, reconcile_validation_cards, snapshot_validation, submit_sql_validation

    engine, _, session, rule = build_session()
    try:
        rule.validation_enabled = True
        rule.validation_targets = [{"source": "literal", "value": "user-1"}]
        rule.validation_method = "sql"
        rule.dataset.fields = [{"name": "store_id", "type": "VARCHAR"}]
        rule.sql_validation_config = {
            "query_template": "SELECT current_temperature FROM repair_state WHERE store_id='{门店ID}'",
            "parameters": [{"name": "门店ID", "field": "store_id"}],
            "true_condition": {"field": "current_temperature", "operator": "lt", "value": -12},
        }
        anomaly = make_anomaly(rule)
        anomaly.row_details["store_id"] = "S1"
        session.add(anomaly)
        session.flush()
        snapshot_validation(session, rule, anomaly, now=NOW)
        session.commit()

        failed_connection = FakeConnection([{"current_temperature": Decimal("2.39")}])
        failed = submit_sql_validation(
            session,
            Settings(),
            anomaly.id,
            "user-1",
            connection_factory=lambda *_args: failed_connection,
            now=NOW,
        )
        session.refresh(anomaly)
        assert failed.outcome == "failed"
        assert failed.reason == "condition_failed"
        assert anomaly.status == "pending"
        assert session.scalar(select(AnomalyValidationSubmission)) is None
        assert anomaly.last_sql_validation_result["outcome"] == "failed"
        assert anomaly.last_sql_validation_result["result_detail"]["actual"] == 2.39
        assert anomaly.validation_result_version == 1
        card_text = json.dumps(build_validation_card(anomaly, "https://sentinel.example"), ensure_ascii=False)
        assert "True 条件" in card_text and "False" in card_text and "2.39" in card_text
        request = session.scalar(select(AnomalyValidationRequest))
        request.message_id = "om_failed_result"
        request.delivery_status = "sent"
        session.commit()
        patches = []
        class CardClient:
            def patch_interactive(self, message_id, card):
                assert not session.in_transaction()
                patches.append((message_id, card))
        assert reconcile_validation_cards(session, Settings(), client=CardClient()) == 0
        assert len(patches) == 1
        session.refresh(request)
        assert request.synced_result_version == 1
        assert request.delivery_status == "sent"
        assert reconcile_validation_cards(session, Settings(), client=CardClient()) == 0
        assert len(patches) == 1

        passed_connection = FakeConnection([{"current_temperature": Decimal("-18.5")}])
        passed = submit_sql_validation(
            session,
            Settings(),
            anomaly.id,
            "user-1",
            connection_factory=lambda *_args: passed_connection,
            now=NOW + timedelta(minutes=1),
        )
        session.refresh(anomaly)
        submission = session.scalar(select(AnomalyValidationSubmission))
        assert passed.outcome == "accepted"
        assert anomaly.status == "resolved"
        assert anomaly.last_sql_validation_result["outcome"] == "passed"
        assert anomaly.validation_result_version == 2
        card_text = json.dumps(build_validation_card(anomaly, "https://sentinel.example"), ensure_ascii=False)
        assert "True" in card_text and "-18.5" in card_text and "run_sql_validation" not in card_text
        assert submission.validator_type == "sql"
        assert submission.submitted_text == ""
        assert submission.result_detail == {
            "field": "current_temperature",
            "operator": "lt",
            "value": -12,
            "upper_value": None,
            "actual": -18.5,
        }
        assert [event.event_type for event in session.scalars(
            select(AnomalyEvent).order_by(AnomalyEvent.created_at)
        )][-2:] == ["sql_validation_failed", "validation_resolved"]
    finally:
        session.close()
        engine.dispose()


@pytest.mark.parametrize("rows,reason", [
    ([], "no_rows"), ([{"actual": 1}, {"actual": 2}], "multiple_rows"),
    ([{"missing": 1}], "missing_field"), ([{"actual": 1, "expected": "bad"}], "invalid_comparison"),
    (None, "execution_error"),
])
def test_sql_failed_attempts_are_persistent_safe_and_do_not_resolve(rows, reason):
    from app.validation_service import SqlValidationExecutionError, build_validation_card, snapshot_validation, submit_sql_validation
    engine, _, session, rule = build_session()
    try:
        rule.validation_enabled = True
        rule.validation_targets = [{"source": "literal", "value": "user-1"}]
        rule.validation_method = "sql"
        rule.sql_validation_config = {"query_template": "SELECT actual, expected FROM t", "parameters": [],
            "true_condition": {"field": "actual", "operator": "gt", "value_source": "field", "value_field": "expected"}}
        anomaly = make_anomaly(rule)
        session.add(anomaly)
        session.flush()
        snapshot_validation(session, rule, anomaly, now=NOW)
        session.commit()
        def connection_factory(*_):
            if rows is None:
                raise RuntimeError("password=TOP_SECRET; SELECT private FROM secrets")
            return FakeConnection(rows)
        if rows is None:
            with pytest.raises(SqlValidationExecutionError) as error:
                submit_sql_validation(session, Settings(), anomaly.id, "user-1", connection_factory=connection_factory)
            assert "TOP_SECRET" not in str(error.value)
        else:
            result = submit_sql_validation(session, Settings(), anomaly.id, "user-1", connection_factory=connection_factory)
            assert result.outcome == "failed"
        session.refresh(anomaly)
        assert anomaly.last_sql_validation_result["reason"] == reason
        assert anomaly.status == "pending"
        assert session.scalar(select(AnomalyValidationSubmission)) is None
        card = json.dumps(build_validation_card(anomaly, "https://sentinel.example"), ensure_ascii=False)
        assert "TOP_SECRET" not in card and "run_sql_validation" in card
        assert "True 条件" in card and "expected" in card
    finally:
        session.close()
        engine.dispose()


def test_late_sql_failure_cannot_replace_another_handlers_success():
    from app.validation_service import snapshot_validation, submit_sql_validation
    engine, _, session, rule = build_session()
    try:
        rule.validation_enabled = True
        rule.validation_targets = [{"source": "literal", "value": value} for value in ("user-1", "user-2")]
        rule.validation_method = "sql"
        rule.sql_validation_config = {"query_template": "SELECT actual FROM t", "parameters": [],
            "true_condition": {"field": "actual", "operator": "eq", "value": "ok"}}
        anomaly = make_anomaly(rule)
        session.add(anomaly)
        session.flush()
        snapshot_validation(session, rule, anomaly, now=NOW)
        session.commit()
        def slow_query(*_):
            accepted = submit_sql_validation(session, Settings(), anomaly.id, "user-2",
                connection_factory=lambda *_: FakeConnection([{"actual": "ok"}]))
            assert accepted.outcome == "accepted"
            return FakeConnection([{"actual": "bad"}])
        late = submit_sql_validation(session, Settings(), anomaly.id, "user-1", connection_factory=slow_query)
        assert late.outcome == "already_resolved"
        session.refresh(anomaly)
        assert anomaly.status == "resolved"
        assert anomaly.last_sql_validation_result["operator_user_id"] == "user-2"
        assert anomaly.last_sql_validation_result["outcome"] == "passed"
        assert anomaly.validation_result_version == 1
    finally:
        session.close()
        engine.dispose()


def test_card_patch_racing_new_result_stays_dirty_until_next_reconciliation():
    from app.validation_service import reconcile_validation_cards
    engine, _, session, rule = build_session()
    try:
        anomaly = make_anomaly(rule)
        anomaly.validation_method_snapshot = "sql"
        anomaly.validation_result_version = 1
        anomaly.last_sql_validation_result = {"outcome": "failed", "condition": {"field": "actual", "operator": "eq", "value": "ok"},
            "result_detail": {"actual": "bad", "value": "ok"}}
        session.add(anomaly)
        session.flush()
        request = AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user-1", message_id="om_race", delivery_status="sent")
        session.add(request)
        session.commit()
        patches = []
        class Client:
            def patch_interactive(self, _, card):
                patches.append(card)
                if len(patches) == 1:
                    anomaly.validation_result_version = 2
                    anomaly.last_sql_validation_result = {**anomaly.last_sql_validation_result, "result_detail": {"actual": "new", "value": "ok"}}
                    session.commit()
        client = Client()
        assert reconcile_validation_cards(session, Settings(), client=client) == 0
        assert request.synced_result_version == 1
        assert reconcile_validation_cards(session, Settings(), client=client) == 0
        assert request.synced_result_version == 2
        assert "new" in json.dumps(patches[-1])
    finally:
        session.close()
        engine.dispose()


def test_delivery_retries_real_feishu_gateway_and_persists_success(monkeypatch):
    """Removing retry accounting, raw-card delivery, or persistence must fail."""
    from app.validation_service import deliver_validation_requests

    engine, _, session, rule = build_session()
    requests = []
    sends = 0
    try:
        anomaly = make_anomaly(rule)
        anomaly.description = rule.description
        anomaly.validation_deadline = NOW + timedelta(minutes=30)
        session.add(anomaly)
        session.flush()
        validation_request = AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user-1")
        session.add(validation_request)
        session.commit()

        def handler(request: httpx.Request):
            nonlocal sends
            requests.append(request)
            if request.url.path.endswith("tenant_access_token/internal/"):
                return httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
            sends += 1
            if sends < 3:
                return httpx.Response(500, json={"code": 1, "msg": "temporary"})
            return httpx.Response(200, json={"code": 0, "data": {"message_id": "om_card"}})

        monkeypatch.setattr("app.validation_service.time.sleep", lambda _: None)
        client = FeishuClient("cli", "secret", transport=httpx.MockTransport(handler))
        failures = deliver_validation_requests(
            session, Settings(feishu_app_id="cli", feishu_app_secret="secret", sentinel_public_base_url="https://sentinel.example"),
            client=client,
        )

        assert failures == 0
        assert validation_request.delivery_status == "sent"
        assert validation_request.delivery_attempts == 3
        assert validation_request.message_id == "om_card"
        assert validation_request.delivered_at is not None
        sent_payload = json.loads(requests[-1].content)
        assert sent_payload["receive_id"] == "user-1"
        assert sent_payload["msg_type"] == "interactive"
        assert anomaly.id in sent_payload["content"]
    finally:
        session.close()
        engine.dispose()


def test_delivery_retry_uses_stable_remote_idempotency_key(monkeypatch):
    """A lost first response must not create a second physical Feishu card."""
    from app.validation_service import deliver_validation_requests

    engine, _, session, rule = build_session()
    physical_messages = {}
    send_attempts = []
    try:
        anomaly = make_anomaly(rule)
        session.add(anomaly)
        session.flush()
        validation_request = AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user-1")
        session.add(validation_request)
        session.commit()

        def handler(request: httpx.Request):
            if request.url.path.endswith("tenant_access_token/internal/"):
                return httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
            payload = json.loads(request.content)
            key = payload.get("uuid")
            send_attempts.append(key)
            physical_key = key if key is not None else f"unkeyed-attempt-{len(send_attempts)}"
            if physical_key not in physical_messages:
                physical_messages[physical_key] = f"om_{len(physical_messages) + 1}"
            if len(send_attempts) == 1:
                raise httpx.ReadTimeout("response lost", request=request)
            return httpx.Response(200, json={"code": 0, "data": {"message_id": physical_messages[physical_key]}})

        monkeypatch.setattr("app.validation_service.time.sleep", lambda _: None)
        client = FeishuClient("cli", "secret", transport=httpx.MockTransport(handler))
        assert deliver_validation_requests(
            session, Settings(feishu_app_id="cli", feishu_app_secret="secret"), client=client,
        ) == 0

        assert send_attempts == [validation_request.id, validation_request.id]
        assert physical_messages == {validation_request.id: "om_1"}
        assert validation_request.message_id == "om_1"
        assert validation_request.delivery_attempts == 2
    finally:
        session.close()
        engine.dispose()


def test_delivery_commits_sending_claim_and_releases_transaction_before_post(tmp_path):
    """Sending without a durable claim, or while holding its DB transaction, must fail."""
    from app.validation_service import deliver_validation_requests

    database_path = tmp_path / "two-phase.sqlite"
    engine, factory, session, rule = build_session(
        f"sqlite+pysqlite:///{database_path}", testing=False,
    )
    anomaly = make_anomaly(rule)
    session.add(anomaly)
    session.flush()
    validation_request = AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user-1")
    session.add(validation_request)
    session.commit()
    request_id = validation_request.id
    observations = []

    def handler(request: httpx.Request):
        if request.url.path.endswith("tenant_access_token/internal/"):
            return httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
        with factory() as observer:
            persisted = observer.get(AnomalyValidationRequest, request_id)
            observations.append((persisted.delivery_status, persisted.send_started_at, session.in_transaction()))
        return httpx.Response(200, json={"code": 0, "data": {"message_id": "om_card"}})

    try:
        client = FeishuClient("cli", "secret", transport=httpx.MockTransport(handler))
        assert deliver_validation_requests(
            session, Settings(feishu_app_id="cli", feishu_app_secret="secret"), client=client, now=NOW,
        ) == 0

        assert observations == [("sending", NOW, False)]
        assert validation_request.delivery_status == "sent"
    finally:
        session.close()
        engine.dispose()


def test_lost_sent_commit_becomes_uncertain_after_dedupe_window_without_resend(tmp_path, monkeypatch):
    """Remote success plus lost local commit must never POST again after Feishu's one-hour window."""
    from app.validation_service import deliver_validation_requests

    database_path = tmp_path / "uncertain.sqlite"
    engine, factory, session, rule = build_session(
        f"sqlite+pysqlite:///{database_path}", testing=False,
    )
    anomaly = make_anomaly(rule)
    session.add(anomaly)
    session.flush()
    validation_request = AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user-1")
    session.add(validation_request)
    session.commit()
    request_id = validation_request.id
    posts = []

    def handler(request: httpx.Request):
        if request.url.path.endswith("tenant_access_token/internal/"):
            return httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
        posts.append(json.loads(request.content))
        return httpx.Response(200, json={"code": 0, "data": {"message_id": "om_remote"}})

    original_commit = session.commit

    def lose_sent_commit():
        if any(
            isinstance(item, AnomalyValidationRequest) and item.delivery_status == "sent"
            for item in session.dirty
        ):
            session.rollback()
            raise RuntimeError("simulated local commit loss")
        original_commit()

    monkeypatch.setattr(session, "commit", lose_sent_commit)
    first_client = FeishuClient("cli", "secret", transport=httpx.MockTransport(handler))
    assert deliver_validation_requests(
        session, Settings(feishu_app_id="cli", feishu_app_secret="secret"), client=first_client, now=NOW,
    ) == 1

    with factory() as verify_sending:
        persisted = verify_sending.get(AnomalyValidationRequest, request_id)
        assert persisted.delivery_status == "sending"
        assert persisted.send_started_at == NOW
        assert persisted.message_id is None

    monkeypatch.setattr(session, "commit", original_commit)
    late_client = FeishuClient("cli", "secret", transport=httpx.MockTransport(handler))
    assert deliver_validation_requests(
        session,
        Settings(feishu_app_id="cli", feishu_app_secret="secret"),
        client=late_client,
        now=NOW + timedelta(hours=1, seconds=1),
    ) == 1

    with factory() as verify_uncertain:
        persisted = verify_uncertain.get(AnomalyValidationRequest, request_id)
        assert persisted.delivery_status == "uncertain"
        assert "人工" in persisted.last_error
    assert len(posts) == 1
    assert posts[0]["uuid"] == request_id
    session.close()
    engine.dispose()


def test_abandoned_sending_claim_recovers_inside_safe_window():
    """An abandoned claim must retry with the same UUID while deduplication is still safe."""
    from app.validation_service import deliver_validation_requests

    engine, _, session, rule = build_session()
    posts = []
    try:
        anomaly = make_anomaly(rule)
        session.add(anomaly)
        session.flush()
        request = AnomalyValidationRequest(
            anomaly_id=anomaly.id,
            recipient_user_id="user-1",
            delivery_status="sending",
            send_started_at=NOW,
            updated_at=NOW,
        )
        session.add(request)
        session.commit()

        client = FeishuClient("cli", "secret", transport=httpx.MockTransport(lambda http_request: (
            httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
            if http_request.url.path.endswith("tenant_access_token/internal/")
            else (posts.append(json.loads(http_request.content)) or httpx.Response(
                200, json={"code": 0, "data": {"message_id": "om_recovered"}},
            ))
        )))
        assert deliver_validation_requests(
            session,
            Settings(feishu_app_id="cli", feishu_app_secret="secret"),
            client=client,
            now=NOW + timedelta(seconds=31),
        ) == 0

        assert len(posts) == 1
        assert posts[0]["uuid"] == request.id
        assert request.delivery_status == "sent"
        assert request.message_id == "om_recovered"
    finally:
        session.close()
        engine.dispose()


def test_missing_configuration_marks_expired_sending_claim_uncertain_without_post():
    """Configuration failure must not strand an expired ambiguous send as retryable."""
    from app.validation_service import deliver_validation_requests

    engine, _, session, rule = build_session()
    try:
        anomaly = make_anomaly(rule)
        session.add(anomaly)
        session.flush()
        request = AnomalyValidationRequest(
            anomaly_id=anomaly.id,
            recipient_user_id="user-1",
            delivery_status="sending",
            send_started_at=NOW,
            updated_at=NOW,
        )
        session.add(request)
        session.commit()

        assert deliver_validation_requests(
            session, Settings(feishu_app_id="", feishu_app_secret=""),
            now=NOW + timedelta(hours=1, seconds=1),
        ) == 1
        assert request.delivery_status == "uncertain"
        assert "人工" in request.last_error
    finally:
        session.close()
        engine.dispose()


def test_ambiguous_attempt_is_not_downgraded_by_later_definitive_errors(monkeypatch):
    """Once any attempt may have created a card, later rejections must not make the request freely retryable."""
    from app.validation_service import deliver_validation_requests

    engine, _, session, rule = build_session()
    send_attempts = 0
    try:
        anomaly = make_anomaly(rule)
        session.add(anomaly)
        session.flush()
        request = AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user-1")
        session.add(request)
        session.commit()

        def handler(http_request: httpx.Request):
            nonlocal send_attempts
            if http_request.url.path.endswith("tenant_access_token/internal/"):
                return httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
            send_attempts += 1
            if send_attempts == 1:
                raise httpx.ReadTimeout("response lost", request=http_request)
            return httpx.Response(500, json={"code": 1, "msg": "definitive rejection"})

        monkeypatch.setattr("app.validation_service.time.sleep", lambda _: None)
        client = FeishuClient("cli", "secret", transport=httpx.MockTransport(handler))
        assert deliver_validation_requests(
            session,
            Settings(feishu_app_id="cli", feishu_app_secret="secret"),
            client=client,
            now=NOW,
        ) == 1

        assert send_attempts == 3
        assert request.delivery_status == "sending"
        assert request.send_started_at == NOW
    finally:
        session.close()
        engine.dispose()


def test_three_server_errors_stay_sending_then_become_uncertain_without_a_fourth_post(monkeypatch):
    """Three ambiguous POST responses must preserve the original one-hour UUID safety boundary."""
    from app.validation_service import deliver_validation_requests

    engine, _, session, rule = build_session()
    post_uuids = []
    attempt_time = utcnow()
    try:
        anomaly = make_anomaly(rule)
        session.add(anomaly)
        session.flush()
        request = AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user-1")
        session.add(request)
        session.commit()

        def handler(http_request: httpx.Request):
            if http_request.url.path.endswith("tenant_access_token/internal/"):
                return httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
            post_uuids.append(json.loads(http_request.content)["uuid"])
            return httpx.Response(500, json={"code": 999, "msg": "temporary"})

        monkeypatch.setattr("app.validation_service.time.sleep", lambda _: None)
        client = FeishuClient("cli", "secret", transport=httpx.MockTransport(handler))
        assert deliver_validation_requests(
            session,
            Settings(feishu_app_id="cli", feishu_app_secret="secret"),
            client=client,
            now=attempt_time,
        ) == 1
        assert post_uuids == [request.id, request.id, request.id]
        assert request.delivery_status == "sending"
        assert request.send_started_at == attempt_time

        assert deliver_validation_requests(
            session,
            Settings(feishu_app_id="cli", feishu_app_secret="secret"),
            client=client,
            now=attempt_time + timedelta(seconds=31),
        ) == 0
        assert post_uuids == [request.id, request.id, request.id]
        assert request.delivery_status == "sending"

        assert deliver_validation_requests(
            session,
            Settings(feishu_app_id="cli", feishu_app_secret="secret"),
            client=client,
            now=attempt_time + timedelta(hours=1, seconds=1),
        ) == 1
        assert post_uuids == [request.id, request.id, request.id]
        assert request.delivery_status == "uncertain"
        assert request.send_started_at == attempt_time
    finally:
        session.close()
        engine.dispose()


def test_restart_after_an_ambiguous_post_never_exceeds_three_total_posts(monkeypatch):
    """A crash before persisting the POST error must not reset the durable retry budget."""
    from app.validation_service import deliver_validation_requests

    class SimulatedProcessCrash(BaseException):
        pass

    engine, _, session, rule = build_session()
    post_uuids = []
    try:
        anomaly = make_anomaly(rule)
        session.add(anomaly)
        session.flush()
        request = AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user-1")
        session.add(request)
        session.commit()

        class CrashAfterPostClient:
            def send_interactive(self, _receive_id_type, _recipient, _card, *, idempotency_key=None):
                post_uuids.append(idempotency_key)
                raise SimulatedProcessCrash()

        with pytest.raises(SimulatedProcessCrash):
            deliver_validation_requests(
                session, Settings(), client=CrashAfterPostClient(), now=NOW,
            )
        session.expire_all()
        persisted = session.get(AnomalyValidationRequest, request.id)
        assert persisted.delivery_status == "sending"
        assert persisted.delivery_attempts == 1
        assert persisted.last_error is None

        class UncertainAfterRestartClient:
            def send_interactive(self, _receive_id_type, _recipient, _card, *, idempotency_key=None):
                post_uuids.append(idempotency_key)
                raise FeishuDeliveryUncertainError("response lost")

        monkeypatch.setattr("app.validation_service.time.sleep", lambda _: None)
        assert deliver_validation_requests(
            session,
            Settings(),
            client=UncertainAfterRestartClient(),
            now=NOW + timedelta(seconds=31),
        ) == 1

        assert post_uuids == [request.id, request.id, request.id]
        assert persisted.delivery_status == "sending"
        assert persisted.delivery_attempts == 3
    finally:
        session.close()
        engine.dispose()


def test_token_fetch_failure_is_safe_to_retry_after_clearing_the_sending_claim(monkeypatch):
    """A failure before message POST must remain recoverable and must not be marked uncertain."""
    from app.validation_service import deliver_validation_requests

    engine, _, session, rule = build_session()
    token_calls = 0
    message_posts = 0
    try:
        anomaly = make_anomaly(rule)
        session.add(anomaly)
        session.flush()
        request = AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user-1")
        session.add(request)
        session.commit()

        def unavailable_token(http_request: httpx.Request):
            nonlocal token_calls, message_posts
            if http_request.url.path.endswith("tenant_access_token/internal/"):
                token_calls += 1
                return httpx.Response(503, json={"code": 999, "msg": "token unavailable"})
            message_posts += 1
            raise AssertionError("message POST must not run without a token")

        monkeypatch.setattr("app.validation_service.time.sleep", lambda _: None)
        failing_client = FeishuClient("cli", "secret", transport=httpx.MockTransport(unavailable_token))
        assert deliver_validation_requests(
            session, Settings(feishu_app_id="cli", feishu_app_secret="secret"), client=failing_client, now=NOW,
        ) == 1
        assert token_calls == 3
        assert message_posts == 0
        assert request.delivery_status == "failed"
        assert request.send_started_at is None

        rejected_posts = 0

        def definitive_rejection(http_request: httpx.Request):
            nonlocal rejected_posts
            if http_request.url.path.endswith("tenant_access_token/internal/"):
                return httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
            rejected_posts += 1
            return httpx.Response(400, json={"code": 230002, "msg": "recipient rejected"})

        rejected_client = FeishuClient(
            "cli", "secret", transport=httpx.MockTransport(definitive_rejection)
        )
        assert deliver_validation_requests(
            session,
            Settings(feishu_app_id="cli", feishu_app_secret="secret"),
            client=rejected_client,
            now=NOW + timedelta(minutes=5),
        ) == 1
        assert rejected_posts == 3
        assert request.delivery_status == "failed"
        assert request.send_started_at is None
        assert request.next_attempt_at is not None

        recovered_client = FeishuClient("cli", "secret", transport=httpx.MockTransport(lambda http_request: (
            httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
            if http_request.url.path.endswith("tenant_access_token/internal/")
            else httpx.Response(200, json={"code": 0, "data": {"message_id": "om_recovered"}})
        )))
        assert deliver_validation_requests(
            session,
            Settings(feishu_app_id="cli", feishu_app_secret="secret"),
            client=recovered_client,
            now=request.next_attempt_at,
        ) == 0
        assert request.delivery_status == "sent"
        assert request.message_id == "om_recovered"
    finally:
        session.close()
        engine.dispose()


def test_resolved_anomaly_closes_a_never_posted_request_without_sending():
    """A resolution committed before initial delivery must make the pending request inert."""
    from app.validation_service import deliver_validation_requests

    engine, _, session, rule = build_session()
    try:
        anomaly = make_anomaly(rule, status="resolved")
        anomaly.active_fingerprint = None
        anomaly.resolved_at = NOW
        session.add(anomaly)
        session.flush()
        request = AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user-1")
        session.add(request)
        session.commit()

        class NoSendClient:
            def send_interactive(self, *_args, **_kwargs):
                raise AssertionError("a resolved never-sent request must not POST")

        assert deliver_validation_requests(session, Settings(), client=NoSendClient(), now=NOW) == 0
        assert request.delivery_status == "resolved"
        assert request.delivery_attempts == 0
        assert request.send_started_at is None
    finally:
        session.close()
        engine.dispose()


def test_resolution_between_candidate_scan_and_claim_prevents_the_first_post(
    tmp_path, monkeypatch,
):
    """The locked claim must refresh anomaly state instead of trusting the pre-scan identity map."""
    from app import validation_service

    database_url = f"sqlite+pysqlite:///{tmp_path / 'resolved-claim-race.sqlite'}"
    engine, factory, session, rule = build_session(database_url, testing=False)
    posts = []
    try:
        anomaly = make_anomaly(rule)
        session.add(anomaly)
        session.flush()
        request = AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user-1")
        session.add(request)
        session.commit()

        original_claim = validation_service._claim_validation_delivery
        transitioned = False

        def resolve_before_claim(active_session, request_id, claim_time):
            nonlocal transitioned
            if not transitioned:
                transitioned = True
                with factory() as resolver:
                    resolver.execute(
                        update(AnomalyRecord).where(AnomalyRecord.id == anomaly.id).values(
                            status="resolved",
                            active_fingerprint=None,
                            resolved_at=claim_time,
                        )
                    )
                    resolver.commit()
            return original_claim(active_session, request_id, claim_time)

        class NoPostClient:
            def send_interactive(self, *_args, **_kwargs):
                posts.append("unexpected")
                return "om_unexpected"

        monkeypatch.setattr(
            validation_service, "_claim_validation_delivery", resolve_before_claim,
        )

        assert validation_service.deliver_validation_requests(
            session, Settings(), client=NoPostClient(), now=NOW,
        ) == 0

        session.expire_all()
        persisted = session.get(AnomalyValidationRequest, request.id)
        assert posts == []
        assert persisted.delivery_status == "resolved"
        assert persisted.delivery_attempts == 0
        assert persisted.send_started_at is None
    finally:
        session.close()
        engine.dispose()


def test_initial_delivery_recovery_honors_the_maintenance_batch_limit():
    """One maintenance scan must not claim or POST more requests than its configured batch."""
    from app.validation_service import deliver_validation_requests

    engine, _, session, rule = build_session()
    sends = []
    try:
        anomaly = make_anomaly(rule)
        session.add(anomaly)
        session.flush()
        requests = [
            AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id=f"user-{index}")
            for index in range(3)
        ]
        session.add_all(requests)
        session.commit()

        class BatchClient:
            def send_interactive(self, _receive_id_type, recipient, _card, *, idempotency_key=None):
                sends.append((recipient, idempotency_key))
                return f"om_{recipient}"

        assert deliver_validation_requests(
            session, Settings(), client=BatchClient(), now=NOW, limit=2,
        ) == 0
        assert len(sends) == 2
        assert [request.delivery_status for request in requests].count("sent") == 2
        assert [request.delivery_status for request in requests].count("pending") == 1
    finally:
        session.close()
        engine.dispose()


def test_blocked_sending_requests_do_not_starve_a_new_pending_request():
    """Lease-held/exhausted rows must be excluded before LIMIT is applied."""
    from app.validation_service import deliver_validation_requests

    engine, _, session, rule = build_session()
    sends = []
    try:
        anomaly = make_anomaly(rule)
        session.add(anomaly)
        session.flush()
        blocked = [
            AnomalyValidationRequest(
                anomaly_id=anomaly.id,
                recipient_user_id=f"blocked-{index}",
                delivery_status="sending",
                delivery_attempts=3,
                send_started_at=NOW,
                next_attempt_at=NOW + timedelta(hours=1),
                updated_at=NOW,
            )
            for index in range(50)
        ]
        pending = AnomalyValidationRequest(
            anomaly_id=anomaly.id,
            recipient_user_id="new-pending",
        )
        session.add_all([*blocked, pending])
        session.commit()

        class RecordingClient:
            def send_interactive(self, _receive_id_type, recipient, _card, *, idempotency_key=None):
                sends.append((recipient, idempotency_key))
                return "om_pending"

        assert deliver_validation_requests(
            session,
            Settings(),
            client=RecordingClient(),
            now=NOW + timedelta(minutes=1),
            limit=1,
        ) == 0

        assert sends == [("new-pending", pending.id)]
        assert pending.delivery_status == "sent"
        assert all(item.delivery_status == "sending" for item in blocked)
    finally:
        session.close()
        engine.dispose()


def test_definitive_failure_backoff_survives_restart_and_retries_when_eligible(
    tmp_path, monkeypatch,
):
    """A permanent rejection must not receive three more POSTs on every maintenance minute."""
    from app.validation_service import deliver_validation_requests

    database_url = f"sqlite+pysqlite:///{tmp_path / 'delivery-backoff.sqlite'}"
    engine, _, session, rule = build_session(database_url, testing=False)
    posts = []
    anomaly = make_anomaly(rule)
    session.add(anomaly)
    session.flush()
    request = AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user-1")
    session.add(request)
    session.commit()
    request_id = request.id

    class RejectedClient:
        def send_interactive(self, *_args, idempotency_key=None, **_kwargs):
            posts.append(idempotency_key)
            raise FeishuError("recipient rejected")

    monkeypatch.setattr("app.validation_service.time.sleep", lambda _: None)
    assert deliver_validation_requests(
        session, Settings(), client=RejectedClient(), now=NOW,
    ) == 1
    assert request.delivery_status == "failed"
    retry_at = request.next_attempt_at
    assert retry_at is not None
    assert retry_at >= NOW + timedelta(minutes=5)
    first_cycle_posts = len(posts)
    session.close()
    engine.dispose()

    restarted_engine, restarted_factory = make_session_factory(database_url, testing=False)
    try:
        with restarted_factory() as restarted:
            class SuccessClient:
                def send_interactive(self, *_args, idempotency_key=None, **_kwargs):
                    posts.append(idempotency_key)
                    return "om_recovered"

            assert deliver_validation_requests(
                restarted,
                Settings(),
                client=SuccessClient(),
                now=NOW + timedelta(minutes=1),
            ) == 0
            assert len(posts) == first_cycle_posts
            assert restarted.get(AnomalyValidationRequest, request_id).delivery_status == "failed"

            assert deliver_validation_requests(
                restarted,
                Settings(),
                client=SuccessClient(),
                now=retry_at,
            ) == 0
            recovered = restarted.get(AnomalyValidationRequest, request_id)
            assert posts[-1] == request_id
            assert recovered.delivery_status == "sent"
            assert recovered.next_attempt_at is None
            assert recovered.consecutive_failures == 0
    finally:
        restarted_engine.dispose()


def test_two_delivery_workers_send_only_one_card_for_a_request(tmp_path):
    """Two workers selecting the same pending request must produce one outbound card."""
    from app.validation_service import deliver_validation_requests

    database_path = tmp_path / "delivery.sqlite"
    engine, factory, setup_session, rule = build_session(
        f"sqlite+pysqlite:///{database_path}", testing=False,
    )
    anomaly = make_anomaly(rule)
    setup_session.add(anomaly)
    setup_session.flush()
    request = AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user-1")
    setup_session.add(request)
    setup_session.commit()
    request_id = request.id
    setup_session.close()

    first_entered = threading.Event()
    second_entered = threading.Event()
    release_first = threading.Event()
    send_count = 0
    errors = []
    send_lock = threading.Lock()

    def handler(request: httpx.Request):
        nonlocal send_count
        if request.url.path.endswith("tenant_access_token/internal/"):
            return httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
        with send_lock:
            send_count += 1
            call_number = send_count
        if call_number == 1:
            first_entered.set()
            assert release_first.wait(5)
        else:
            second_entered.set()
        return httpx.Response(200, json={"code": 0, "data": {"message_id": f"om_{call_number}"}})

    def worker():
        with factory() as worker_session:
            client = FeishuClient("cli", "secret", transport=httpx.MockTransport(handler))
            try:
                deliver_validation_requests(
                    worker_session, Settings(feishu_app_id="cli", feishu_app_secret="secret"), client=client,
                )
            except Exception as exc:  # pragma: no cover - asserted below
                errors.append(exc)
            finally:
                client.close()

    first = threading.Thread(target=worker)
    first.start()
    assert first_entered.wait(5)
    second = threading.Thread(target=worker)
    second.start()
    duplicate_started = second_entered.wait(0.5)
    release_first.set()
    first.join()
    second.join()

    with factory() as verify_session:
        persisted = verify_session.get(AnomalyValidationRequest, request_id)
        assert errors == []
        assert duplicate_started is False
        assert send_count == 1
        assert persisted.delivery_status == "sent"
        assert persisted.message_id == "om_1"
    engine.dispose()


def test_timeout_is_idempotent_and_late_submission_resolves():
    """Repeated scans, rejected late replies, or incomplete resolution state must fail."""
    from app.validation_service import expire_due_anomalies, submit_validation

    engine, _, session, rule = build_session()
    try:
        anomaly = make_anomaly(rule)
        anomaly.validation_deadline = NOW
        session.add(anomaly)
        session.flush()
        request = AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user-1")
        session.add(request)
        session.commit()

        assert expire_due_anomalies(session, now=NOW) == 1
        assert expire_due_anomalies(session, now=NOW + timedelta(minutes=1)) == 0
        assert anomaly.status == "timed_out"
        assert anomaly.timed_out_at == NOW
        assert [event.event_type for event in session.scalars(select(AnomalyEvent))] == ["validation_timed_out"]

        result = submit_validation(session, anomaly.id, "user-1", "  checked and valid  ", now=NOW + timedelta(minutes=2))

        assert result.outcome == "accepted"
        assert anomaly.status == "resolved"
        assert anomaly.active_fingerprint is None
        assert anomaly.resolution_source == "validation"
        assert anomaly.resolved_by_user_id == "user-1"
        assert session.scalar(select(AnomalyValidationSubmission)).submitted_text == "checked and valid"
        assert [event.event_type for event in session.scalars(select(AnomalyEvent).order_by(AnomalyEvent.created_at))] == [
            "validation_timed_out", "validation_resolved",
        ]
    finally:
        session.close()
        engine.dispose()


def test_expiration_is_bounded_and_stops_between_records(caplog):
    from app.validation_service import expire_due_anomalies

    engine, _, session, rule = build_session()
    checks = 0
    try:
        anomalies = []
        for index in range(3):
            anomaly = make_anomaly(rule)
            anomaly.fingerprint = str(index) * 64
            anomaly.active_fingerprint = anomaly.fingerprint
            anomaly.validation_deadline = NOW - timedelta(minutes=index + 1)
            anomalies.append(anomaly)
        session.add_all(anomalies)
        session.commit()

        def should_stop():
            nonlocal checks
            checks += 1
            return checks > 1

        with caplog.at_level("WARNING", logger="app.validation_service"):
            assert expire_due_anomalies(
                session,
                now=NOW,
                limit=2,
                should_stop=should_stop,
            ) == 1

        session.expire_all()
        assert [item.status for item in anomalies].count("timed_out") == 1
        assert [item.status for item in anomalies].count("pending") == 2
        assert len(list(session.scalars(select(AnomalyEvent).where(
            AnomalyEvent.event_type == "validation_timed_out"
        )))) == 1
        assert any("下一轮" in record.getMessage() for record in caplog.records)
    finally:
        session.close()
        engine.dispose()


def test_expiration_cannot_overwrite_a_concurrent_resolution(tmp_path):
    """A due-row snapshot becoming stale must not overwrite a callback resolution."""
    from app.validation_service import expire_due_anomalies, submit_validation

    database_path = tmp_path / "expiration.sqlite"
    engine, factory, setup_session, rule = build_session(
        f"sqlite+pysqlite:///{database_path}", testing=False,
    )
    with engine.begin() as connection:
        connection.exec_driver_sql("PRAGMA journal_mode=WAL")
    anomaly = make_anomaly(rule)
    anomaly.validation_deadline = NOW
    setup_session.add(anomaly)
    setup_session.flush()
    setup_session.add(AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user-1"))
    setup_session.commit()
    anomaly_id = anomaly.id
    setup_session.close()

    expiry_paused = threading.Event()
    callback_done = threading.Event()
    pause_guard = threading.Lock()
    did_pause = False
    results = []
    errors = []

    def pause_once():
        nonlocal did_pause
        with pause_guard:
            if did_pause:
                return
            did_pause = True
        expiry_paused.set()
        assert callback_done.wait(5)

    def before_cursor_execute(_conn, _cursor, statement, _parameters, _context, _executemany):
        if threading.current_thread().name == "expiry-worker" and statement.lstrip().upper().startswith("UPDATE ANOMALY_RECORDS"):
            pause_once()

    event.listen(engine, "before_cursor_execute", before_cursor_execute)

    def expire_worker():
        with factory() as expiry_session:
            def on_load(_session, instance):
                if isinstance(instance, AnomalyRecord) and instance.id == anomaly_id:
                    pause_once()

            event.listen(expiry_session, "loaded_as_persistent", on_load)
            try:
                results.append(expire_due_anomalies(expiry_session, now=NOW))
            except Exception as exc:  # pragma: no cover - asserted below
                errors.append(exc)

    worker = threading.Thread(target=expire_worker, name="expiry-worker")
    worker.start()
    assert expiry_paused.wait(5)
    with factory() as callback_session:
        assert submit_validation(callback_session, anomaly_id, "user-1", "resolved first", now=NOW).outcome == "accepted"
    callback_done.set()
    worker.join()

    with factory() as verify_session:
        persisted = verify_session.get(AnomalyRecord, anomaly_id)
        assert errors == []
        assert results == [0]
        assert persisted.status == "resolved"
        assert persisted.resolution_source == "validation"
        assert len(list(verify_session.scalars(select(AnomalyValidationSubmission)))) == 1
        assert len(list(verify_session.scalars(select(AnomalyEvent).where(
            AnomalyEvent.event_type == "validation_timed_out"
        )))) == 0
    engine.dispose()


@pytest.mark.parametrize("text", ["   ", "x" * 1001])
def test_invalid_submission_text_is_rejected_without_resolving(text):
    """Accepting empty or oversized pseudo-validation text must fail."""
    from app.validation_service import ValidationTextError, submit_validation

    engine, _, session, rule = build_session()
    try:
        anomaly = make_anomaly(rule)
        session.add(anomaly)
        session.flush()
        session.add(AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user-1"))
        session.commit()

        with pytest.raises(ValidationTextError):
            submit_validation(session, anomaly.id, "user-1", text, now=NOW)

        assert anomaly.status == "pending"
        assert list(session.scalars(select(AnomalyValidationSubmission))) == []
    finally:
        session.close()
        engine.dispose()


def test_duplicate_winner_is_idempotent_nonwinner_is_resolved_and_record_cannot_reopen():
    """Overwriting the winner or allowing a terminal record to reopen must fail."""
    from app.validation_service import InvalidValidationTransition, submit_validation, transition_anomaly

    engine, _, session, rule = build_session()
    try:
        anomaly = make_anomaly(rule)
        session.add(anomaly)
        session.flush()
        session.add_all([
            AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user-1"),
            AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user-2"),
        ])
        session.commit()

        first = submit_validation(session, anomaly.id, "user-1", "winner", now=NOW)
        duplicate = submit_validation(session, anomaly.id, "user-1", "different retry text", now=NOW)
        loser = submit_validation(session, anomaly.id, "user-2", "loser", now=NOW)

        assert (first.outcome, duplicate.outcome, loser.outcome) == ("accepted", "duplicate", "already_resolved")
        submissions = list(session.scalars(select(AnomalyValidationSubmission)))
        assert len(submissions) == 1
        assert submissions[0].submitted_text == "winner"
        with pytest.raises(InvalidValidationTransition):
            transition_anomaly(session, anomaly, "processing", now=NOW)
        assert anomaly.status == "resolved"
    finally:
        session.close()
        engine.dispose()


def test_timed_out_record_cannot_return_to_an_active_state():
    """Allowing a timed-out record to move back to pending or processing must fail."""
    from app.validation_service import InvalidValidationTransition, transition_anomaly

    engine, _, session, rule = build_session()
    try:
        anomaly = make_anomaly(rule, status="timed_out")
        session.add(anomaly)
        session.commit()

        for target_status in ("pending", "processing"):
            with pytest.raises(InvalidValidationTransition):
                transition_anomaly(session, anomaly, target_status, now=NOW)
        assert anomaly.status == "timed_out"
    finally:
        session.close()
        engine.dispose()


@pytest.mark.parametrize(
    ("source", "user_id"),
    [(None, None), ("other", "admin-1"), ("manual", None), ("validation", "user-1")],
)
def test_resolution_transition_rejects_missing_or_untrusted_provenance(source, user_id):
    """Only a named administrator may use the public manual resolution transition."""
    from app.validation_service import InvalidValidationTransition, transition_anomaly

    engine, _, session, rule = build_session()
    try:
        anomaly = make_anomaly(rule)
        session.add(anomaly)
        session.commit()

        with pytest.raises(InvalidValidationTransition):
            transition_anomaly(session, anomaly, "resolved", now=NOW, source=source, user_id=user_id)
        assert anomaly.status == "pending"
    finally:
        session.close()
        engine.dispose()


def test_named_admin_can_manually_resolve():
    """Rejecting a valid identified administrator resolution must fail."""
    from app.validation_service import transition_anomaly

    engine, _, session, rule = build_session()
    try:
        anomaly = make_anomaly(rule)
        session.add(anomaly)
        session.commit()

        assert transition_anomaly(
            session, anomaly, "resolved", now=NOW, source="manual", user_id="admin-1",
        ) is True
        assert anomaly.status == "resolved"
        assert anomaly.resolution_source == "manual"
        assert anomaly.resolved_by_user_id == "admin-1"
    finally:
        session.close()
        engine.dispose()


def test_stale_manual_transition_cannot_overwrite_committed_resolution(tmp_path):
    """Trusting the caller's stale ORM instance must not reopen a resolved anomaly."""
    from app.validation_service import InvalidValidationTransition, transition_anomaly

    database_path = tmp_path / "manual-transition.sqlite"
    engine, factory, setup_session, rule = build_session(
        f"sqlite+pysqlite:///{database_path}", testing=False,
    )
    anomaly = make_anomaly(rule)
    setup_session.add(anomaly)
    setup_session.commit()
    anomaly_id = anomaly.id
    setup_session.close()

    with factory() as stale_session:
        stale = stale_session.get(AnomalyRecord, anomaly_id)
        assert stale.status == "pending"
        with factory() as winner_session:
            winner = winner_session.get(AnomalyRecord, anomaly_id)
            assert transition_anomaly(
                winner_session, winner, "resolved", now=NOW, source="manual", user_id="admin-winner",
            ) is True
            winner_session.commit()

        with pytest.raises(InvalidValidationTransition):
            transition_anomaly(stale_session, stale, "processing", now=NOW + timedelta(seconds=1))
        stale_session.rollback()

    with factory() as verify_session:
        persisted = verify_session.get(AnomalyRecord, anomaly_id)
        assert persisted.status == "resolved"
        assert persisted.resolved_by_user_id == "admin-winner"
    engine.dispose()


def test_callback_lock_refreshes_preloaded_anomaly_and_preserves_manual_winner(tmp_path):
    """A preloaded pending identity must not hide a manual resolution from the locked callback read."""
    from app.validation_service import submit_validation, transition_anomaly

    database_path = tmp_path / "callback-identity-map.sqlite"
    engine, factory, setup_session, rule = build_session(
        f"sqlite+pysqlite:///{database_path}", testing=False,
    )
    anomaly = make_anomaly(rule)
    setup_session.add(anomaly)
    setup_session.flush()
    setup_session.add(AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user-1"))
    setup_session.commit()
    anomaly_id = anomaly.id
    setup_session.close()

    with factory() as callback_session:
        preloaded = callback_session.get(AnomalyRecord, anomaly_id)
        assert preloaded.status == "pending"
        with factory() as manual_session:
            winner = manual_session.get(AnomalyRecord, anomaly_id)
            transition_anomaly(
                manual_session, winner, "resolved", now=NOW, source="manual", user_id="admin-winner",
            )
            manual_session.commit()

        result = submit_validation(callback_session, anomaly_id, "user-1", "stale callback", now=NOW)
        assert result.outcome == "already_resolved"

    with factory() as verify_session:
        persisted = verify_session.get(AnomalyRecord, anomaly_id)
        assert persisted.status == "resolved"
        assert persisted.resolution_source == "manual"
        assert persisted.resolved_by_user_id == "admin-winner"
        assert list(verify_session.scalars(select(AnomalyValidationSubmission))) == []
    engine.dispose()


def test_concurrent_callbacks_persist_exactly_one_winner(tmp_path):
    """Removing row serialization or the unique-conflict recovery must allow two winners or leak an error."""
    from app.validation_service import submit_validation

    database_path = tmp_path / "validation.sqlite"
    engine, factory, setup_session, rule = build_session(f"sqlite+pysqlite:///{database_path}")
    anomaly = make_anomaly(rule)
    setup_session.add(anomaly)
    setup_session.flush()
    setup_session.add_all([
        AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user-1"),
        AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user-2"),
    ])
    setup_session.commit()
    anomaly_id = anomaly.id
    setup_session.close()
    barrier = threading.Barrier(2)
    outcomes = []
    errors = []

    def submit(user_id):
        with factory() as thread_session:
            try:
                barrier.wait()
                outcomes.append(submit_validation(thread_session, anomaly_id, user_id, f"from {user_id}", now=NOW).outcome)
            except Exception as exc:  # pragma: no cover - asserted below for diagnostic clarity
                errors.append(exc)

    threads = [threading.Thread(target=submit, args=(user_id,)) for user_id in ("user-1", "user-2")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    with factory() as verify_session:
        assert errors == []
        assert sorted(outcomes) == ["accepted", "already_resolved"]
        assert len(list(verify_session.scalars(select(AnomalyValidationSubmission)))) == 1
        assert verify_session.get(AnomalyRecord, anomaly_id).status == "resolved"
    engine.dispose()


def test_card_patch_failure_is_retryable_and_does_not_rollback_resolution(monkeypatch):
    """A Feishu patch failure rolling back resolution or becoming unretryable must fail."""
    from app.validation_service import reconcile_validation_cards, submit_validation

    engine, _, session, rule = build_session()
    try:
        anomaly = make_anomaly(rule)
        session.add(anomaly)
        session.flush()
        request = AnomalyValidationRequest(
            anomaly_id=anomaly.id, recipient_user_id="user-1", delivery_status="sent", message_id="om_card",
        )
        session.add(request)
        session.commit()
        submit_validation(session, anomaly.id, "user-1", "resolved", now=NOW)

        failing_client = FeishuClient("cli", "secret", transport=httpx.MockTransport(lambda request: (
            httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
            if request.url.path.endswith("tenant_access_token/internal/")
            else httpx.Response(500, json={"code": 1, "msg": "temporary"})
        )))
        monkeypatch.setattr("app.validation_service.time.sleep", lambda _: None)
        assert reconcile_validation_cards(session, Settings(feishu_app_id="cli", feishu_app_secret="secret"), client=failing_client) == 1
        assert anomaly.status == "resolved"
        assert request.delivery_status == "update_failed"
        assert request.last_error == "更新飞书卡片失败: temporary (code: 1)"

        successful_client = FeishuClient("cli", "secret", transport=httpx.MockTransport(lambda request: (
            httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
            if request.url.path.endswith("tenant_access_token/internal/")
            else httpx.Response(200, json={"code": 0})
        )))
        assert reconcile_validation_cards(session, Settings(feishu_app_id="cli", feishu_app_secret="secret"), client=successful_client) == 0
        assert request.delivery_status == "resolved"
        assert request.last_error is None

        patched_requests = []
        no_repeat_client = FeishuClient("cli", "secret", transport=httpx.MockTransport(lambda request: (
            patched_requests.append(request) or httpx.Response(500, json={"code": 1, "msg": "must not patch"})
        )))
        assert reconcile_validation_cards(
            session, Settings(feishu_app_id="cli", feishu_app_secret="secret"), client=no_repeat_client,
        ) == 0
        assert patched_requests == []
    finally:
        session.close()
        engine.dispose()


def test_timed_out_card_reconciliation_converges_after_one_success():
    """A successfully synchronized timed-out card must not be patched on every scan."""
    from app.validation_service import reconcile_validation_cards

    engine, _, session, rule = build_session()
    patch_requests = []
    try:
        anomaly = make_anomaly(rule, status="timed_out")
        session.add(anomaly)
        session.flush()
        request = AnomalyValidationRequest(
            anomaly_id=anomaly.id, recipient_user_id="user-1", delivery_status="sent", message_id="om_card",
        )
        session.add(request)
        session.commit()

        client = FeishuClient("cli", "secret", transport=httpx.MockTransport(lambda request: (
            httpx.Response(200, json={"code": 0, "tenant_access_token": "token", "expire": 7200})
            if request.url.path.endswith("tenant_access_token/internal/")
            else (patch_requests.append(request) or httpx.Response(200, json={"code": 0}))
        )))
        settings = Settings(feishu_app_id="cli", feishu_app_secret="secret")

        assert reconcile_validation_cards(session, settings, client=client) == 0
        assert request.delivery_status == "timed_out"
        assert reconcile_validation_cards(session, settings, client=client) == 0
        assert len(patch_requests) == 1
    finally:
        session.close()
        engine.dispose()


def test_terminal_card_reconciliation_is_bounded_commits_before_http_and_stops_between_cards(caplog):
    """Shutdown may wait for the current patch, never for every candidate in an unbounded scan."""
    from app.validation_service import reconcile_validation_cards

    engine, _, session, rule = build_session()
    stop = threading.Event()
    patches = []
    try:
        anomaly = make_anomaly(rule, status="resolved")
        anomaly.active_fingerprint = None
        anomaly.resolved_at = NOW
        session.add(anomaly)
        session.flush()
        requests = [
            AnomalyValidationRequest(
                anomaly_id=anomaly.id, recipient_user_id=f"user-{index}",
                delivery_status="sent", message_id=f"om_{index}",
            )
            for index in range(3)
        ]
        session.add_all(requests)
        session.commit()

        class StopAfterOneClient:
            def patch_interactive(self, message_id, _card):
                patches.append((message_id, session.in_transaction()))
                stop.set()

        with caplog.at_level("WARNING", logger="app.validation_service"):
            assert reconcile_validation_cards(
                session, Settings(), client=StopAfterOneClient(), limit=2,
                should_stop=stop.is_set,
            ) == 0

        assert patches == [("om_0", False)]
        assert [request.delivery_status for request in requests].count("resolved") == 1
        assert [request.delivery_status for request in requests].count("sent") == 2
        assert any("下一轮" in record.getMessage() for record in caplog.records)
    finally:
        session.close()
        engine.dispose()
