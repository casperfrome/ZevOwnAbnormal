import asyncio
from contextlib import contextmanager
from datetime import datetime
import threading

from fastapi.testclient import TestClient
import pytest

from app.config import Settings
from app.database import Base, make_session_factory
from app.main import create_app
from app.models import AnomalyRecord, AnomalyValidationRequest


def test_maintenance_cycle_uses_a_fresh_closed_session_and_runs_domain_operations(monkeypatch):
    from app.main import run_validation_maintenance_cycle

    events = []
    sessions = []

    class FakeSession:
        pass

    @contextmanager
    def session_factory():
        session = FakeSession()
        sessions.append(session)
        events.append(("open", session))
        try:
            yield session
        finally:
            events.append(("close", session))

    monkeypatch.setattr("app.main.expire_due_anomalies", lambda session: events.append(("expire", session)))
    monkeypatch.setattr(
        "app.main.deliver_validation_requests",
        lambda session, settings, **kwargs: events.append(("deliver", session, kwargs)),
    )
    monkeypatch.setattr(
        "app.main.reconcile_validation_cards",
        lambda session, settings, **kwargs: events.append(("reconcile", session, kwargs)),
    )
    settings = Settings()

    run_validation_maintenance_cycle(session_factory, settings)
    run_validation_maintenance_cycle(session_factory, settings)

    assert sessions[0] is not sessions[1]
    assert events == [
        ("open", sessions[0]), ("expire", sessions[0]),
        ("deliver", sessions[0], {"limit": 50, "should_stop": None}),
        ("reconcile", sessions[0], {"limit": 50, "should_stop": None}), ("close", sessions[0]),
        ("open", sessions[1]), ("expire", sessions[1]),
        ("deliver", sessions[1], {"limit": 50, "should_stop": None}),
        ("reconcile", sessions[1], {"limit": 50, "should_stop": None}), ("close", sessions[1]),
    ]


def test_maintenance_cycle_recovers_a_request_committed_before_the_process_crashed(tmp_path, monkeypatch):
    """A restart must deliver a durable pending request even when execution never reached send."""
    from app.main import run_validation_maintenance_cycle

    database_url = f"sqlite+pysqlite:///{tmp_path / 'maintenance-recovery.sqlite'}"
    engine, factory = make_session_factory(database_url, testing=False)
    Base.metadata.create_all(engine)
    now = datetime(2026, 8, 22, 4, 0, 0)
    with factory() as session:
        anomaly = AnomalyRecord(
            rule_id="rule-1", rule_name="rule", dataset_name="dataset", severity="high",
            status="pending", description="needs validation", fingerprint="f" * 64,
            active_fingerprint="f" * 64, business_key={"id": 1}, row_details={"amount": 42},
            matched_conditions=[], first_seen_at=now, last_seen_at=now,
        )
        session.add(anomaly)
        session.flush()
        request = AnomalyValidationRequest(anomaly_id=anomaly.id, recipient_user_id="user-1")
        session.add(request)
        session.commit()
        request_id = request.id

    sent = []

    class RestartClient:
        def __init__(self, *_args, **_kwargs):
            pass

        def send_interactive(self, receive_id_type, recipient, card, *, idempotency_key=None):
            sent.append((receive_id_type, recipient, card["schema"], idempotency_key))
            return "om_recovered"

        def patch_interactive(self, *_args, **_kwargs):
            raise AssertionError("no terminal card should need reconciliation")

        def close(self):
            pass

    monkeypatch.setattr("app.validation_service.FeishuClient", RestartClient)
    settings = Settings(
        feishu_app_id="cli", feishu_app_secret="secret", validation_maintenance_batch_size=50,
    )
    run_validation_maintenance_cycle(factory, settings)

    with factory() as session:
        recovered = session.get(AnomalyValidationRequest, request_id)
        assert sent == [("user_id", "user-1", "2.0", request_id)]
        assert recovered.delivery_status == "sent"
        assert recovered.message_id == "om_recovered"
    engine.dispose()


def test_testing_app_disables_validation_maintenance_task():
    app = create_app(testing=True)

    assert app.state.validation_maintenance_task is None
    with TestClient(app):
        assert app.state.validation_maintenance_task is None


def test_maintenance_loop_waits_for_an_inflight_cycle_before_cancelling(monkeypatch):
    from app.main import validation_maintenance_loop

    started = threading.Event()
    released = threading.Event()
    finished = threading.Event()

    observed_stop_event = []

    def blocking_cycle(_session_factory, _settings, stop_event):
        observed_stop_event.append(stop_event)
        started.set()
        assert stop_event.wait(timeout=2)
        finished.set()

    monkeypatch.setattr("app.main.run_validation_maintenance_cycle", blocking_cycle)

    async def cancel_during_cycle():
        task = asyncio.create_task(validation_maintenance_loop(lambda: None, Settings()))
        assert await asyncio.to_thread(started.wait, 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert finished.is_set()
        assert observed_stop_event[0].is_set()

    asyncio.run(cancel_during_cycle())


def test_maintenance_loop_preserves_cancellation_if_inflight_cycle_fails(monkeypatch):
    from app.main import validation_maintenance_loop

    started = threading.Event()
    released = threading.Event()

    def failing_cycle(_session_factory, _settings, stop_event):
        started.set()
        assert stop_event.wait(timeout=2)
        raise RuntimeError("maintenance failed during shutdown")

    monkeypatch.setattr("app.main.run_validation_maintenance_cycle", failing_cycle)

    async def cancel_during_failure():
        task = asyncio.create_task(validation_maintenance_loop(lambda: None, Settings()))
        assert await asyncio.to_thread(started.wait, 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(cancel_during_failure())


def test_validation_runtime_settings_have_safe_local_defaults():
    settings = Settings()

    assert settings.sentinel_public_base_url == "http://localhost:8000"
    assert settings.sentinel_api_base_url == "http://127.0.0.1:8000"
    assert settings.validation_timeout_scan_interval_seconds == 60
    assert settings.validation_maintenance_batch_size == 50
    assert settings.feishu_http_timeout_seconds == 10


def test_settings_accept_the_sentinel_internal_token_name_from_env_file(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("SENTINEL_INTERNAL_TOKEN=sentinel-token-name\n", encoding="utf-8")

    settings = Settings(_env_file=env_file)

    assert settings.internal_execution_token == "sentinel-token-name"


def test_settings_preserve_explicit_internal_token_constructor_values():
    settings = Settings(_env_file=None, internal_execution_token="explicit-token")

    assert settings.internal_execution_token == "explicit-token"
