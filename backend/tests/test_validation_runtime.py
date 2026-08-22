import asyncio
from contextlib import contextmanager
import threading

from fastapi.testclient import TestClient
import pytest

from app.config import Settings
from app.main import create_app


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
        "app.main.reconcile_validation_cards",
        lambda session, settings: events.append(("reconcile", session)),
    )
    settings = Settings()

    run_validation_maintenance_cycle(session_factory, settings)
    run_validation_maintenance_cycle(session_factory, settings)

    assert sessions[0] is not sessions[1]
    assert events == [
        ("open", sessions[0]), ("expire", sessions[0]), ("reconcile", sessions[0]), ("close", sessions[0]),
        ("open", sessions[1]), ("expire", sessions[1]), ("reconcile", sessions[1]), ("close", sessions[1]),
    ]


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

    def blocking_cycle(_session_factory, _settings):
        started.set()
        released.wait(timeout=2)
        finished.set()

    monkeypatch.setattr("app.main.run_validation_maintenance_cycle", blocking_cycle)

    async def cancel_during_cycle():
        task = asyncio.create_task(validation_maintenance_loop(lambda: None, Settings()))
        assert await asyncio.to_thread(started.wait, 1)
        asyncio.get_running_loop().call_later(0.1, released.set)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert finished.is_set()

    asyncio.run(cancel_during_cycle())


def test_maintenance_loop_preserves_cancellation_if_inflight_cycle_fails(monkeypatch):
    from app.main import validation_maintenance_loop

    started = threading.Event()
    released = threading.Event()

    def failing_cycle(_session_factory, _settings):
        started.set()
        released.wait(timeout=2)
        raise RuntimeError("maintenance failed during shutdown")

    monkeypatch.setattr("app.main.run_validation_maintenance_cycle", failing_cycle)

    async def cancel_during_failure():
        task = asyncio.create_task(validation_maintenance_loop(lambda: None, Settings()))
        assert await asyncio.to_thread(started.wait, 1)
        asyncio.get_running_loop().call_later(0.1, released.set)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(cancel_during_failure())


def test_validation_runtime_settings_have_safe_local_defaults():
    settings = Settings()

    assert settings.sentinel_public_base_url == "http://localhost:8000"
    assert settings.sentinel_api_base_url == "http://127.0.0.1:8000"
    assert settings.validation_timeout_scan_interval_seconds == 60
