import asyncio
from contextlib import contextmanager
from datetime import datetime
import threading

from fastapi.testclient import TestClient
import pytest

from app.config import Settings
from app.database import Base, make_session_factory
from app.main import create_app
from app.models import AnomalyPushJob, AnomalyRecord, AnomalyValidationRequest


def test_deadline_scan_expires_without_running_network_maintenance(monkeypatch):
    from app.main import run_deadline_scan_cycle
    engine, factory = make_session_factory("sqlite+pysqlite:///:memory:", testing=True)
    Base.metadata.create_all(engine)
    with factory() as session:
        anomaly = AnomalyRecord(rule_id="rule", rule_name="rule", dataset_name="data", severity="high",
            fingerprint="f" * 64, status="pending", business_key={}, row_details={}, matched_conditions=[],
            validation_deadline=datetime(2020, 1, 1))
        session.add(anomaly)
        session.commit()
        anomaly_id = anomaly.id
    def unexpected(*args, **kwargs):
        raise AssertionError("deadline scan must not perform network requests")
    monkeypatch.setattr("app.main.reconcile_validation_cards", unexpected)
    run_deadline_scan_cycle(factory, Settings(_env_file=None))
    with factory() as session:
        assert session.get(AnomalyRecord, anomaly_id).status == "timed_out"
    engine.dispose()


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

    monkeypatch.setattr(
        "app.main.queue_due_timeout_broadcasts",
        lambda session, settings, **kwargs: events.append(("timeout_broadcast", session, kwargs)),
    )
    monkeypatch.setattr(
        "app.main.expire_due_anomalies",
        lambda session, **kwargs: events.append(("expire", session, kwargs)),
    )
    monkeypatch.setattr(
        "app.main.queue_due_validation_push_jobs",
        lambda session, **kwargs: events.append(("queue", session, kwargs)),
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
        ("open", sessions[0]),
        ("queue", sessions[0], {"limit": 50}),
        ("reconcile", sessions[0], {"limit": 50, "should_stop": None}), ("close", sessions[0]),
        ("open", sessions[1]),
        ("queue", sessions[1], {"limit": 50}),
        ("reconcile", sessions[1], {"limit": 50, "should_stop": None}), ("close", sessions[1]),
    ]


def test_maintenance_cycle_recovers_a_request_into_kafka_pipeline_without_direct_send(tmp_path, monkeypatch):
    """A restart must queue a durable request without bypassing Kafka and DolphinScheduler."""
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

    settings = Settings(
        feishu_app_id="cli", feishu_app_secret="secret", validation_maintenance_batch_size=50,
    )
    run_validation_maintenance_cycle(factory, settings)

    with factory() as session:
        recovered = session.get(AnomalyValidationRequest, request_id)
        job = session.query(AnomalyPushJob).filter_by(delivery_id=request_id).one()
        assert recovered.delivery_status == "pending"
        assert recovered.message_id is None
        assert job.status == "pending_publish"
    engine.dispose()


def test_testing_app_disables_validation_maintenance_task():
    app = create_app(testing=True)

    assert app.state.validation_maintenance_task is None
    assert app.state.push_pipeline_task is None
    with TestClient(app):
        assert app.state.validation_maintenance_task is None
        assert app.state.push_pipeline_task is None


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
    settings = Settings(_env_file=None)

    assert settings.sentinel_public_base_url == "http://localhost:8000"
    assert settings.sentinel_api_base_url == "http://127.0.0.1:8000"
    assert settings.validation_timeout_scan_interval_seconds == 1
    assert settings.validation_maintenance_batch_size == 50
    assert settings.feishu_http_timeout_seconds == 10
    assert settings.kafka_bootstrap_servers == "localhost:9092"
    assert settings.kafka_anomaly_push_topic == "sentinel-anomaly-push"
    assert settings.kafka_anomaly_push_group == "sentinel-anomaly-push-dispatcher"


def test_testing_app_uses_fixed_internal_token_instead_of_runtime_environment(monkeypatch):
    monkeypatch.setenv("SENTINEL_INTERNAL_TOKEN", "production-runtime-token")

    app = create_app(testing=True)

    assert app.state.settings.internal_execution_token == "change-this-internal-token"


def test_settings_accept_the_sentinel_internal_token_name_from_env_file(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("SENTINEL_INTERNAL_TOKEN=sentinel-token-name\n", encoding="utf-8")

    settings = Settings(_env_file=env_file)

    assert settings.internal_execution_token == "sentinel-token-name"


@pytest.mark.parametrize(
    ("contents", "expected"),
    [
        ("SENTINEL_INTERNAL_TOKEN=canonical-only\n", "canonical-only"),
        ("INTERNAL_EXECUTION_TOKEN=legacy-only\n", "legacy-only"),
        (
            "SENTINEL_INTERNAL_TOKEN=shared-value\n"
            "INTERNAL_EXECUTION_TOKEN=shared-value\n",
            "shared-value",
        ),
    ],
)
def test_settings_accept_canonical_or_legacy_file_tokens_at_equal_priority(
    tmp_path, monkeypatch, contents, expected,
):
    monkeypatch.delenv("SENTINEL_INTERNAL_TOKEN", raising=False)
    monkeypatch.delenv("INTERNAL_EXECUTION_TOKEN", raising=False)
    env_file = tmp_path / ".env"
    env_file.write_text(contents, encoding="utf-8")

    assert Settings(_env_file=env_file).internal_execution_token == expected


def test_settings_reject_conflicting_nonempty_file_tokens_without_disclosing_values(
    tmp_path, monkeypatch,
):
    monkeypatch.delenv("SENTINEL_INTERNAL_TOKEN", raising=False)
    monkeypatch.delenv("INTERNAL_EXECUTION_TOKEN", raising=False)
    env_file = tmp_path / ".env"
    env_file.write_text(
        "SENTINEL_INTERNAL_TOKEN=canonical-secret\n"
        "INTERNAL_EXECUTION_TOKEN=legacy-secret\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError) as conflict:
        Settings(_env_file=env_file)

    assert "SENTINEL_INTERNAL_TOKEN" in str(conflict.value)
    assert "INTERNAL_EXECUTION_TOKEN" in str(conflict.value)
    assert "canonical-secret" not in str(conflict.value)
    assert "legacy-secret" not in str(conflict.value)


@pytest.mark.parametrize(
    ("process_name", "file_name"),
    [
        ("SENTINEL_INTERNAL_TOKEN", "INTERNAL_EXECUTION_TOKEN"),
        ("INTERNAL_EXECUTION_TOKEN", "SENTINEL_INTERNAL_TOKEN"),
    ],
)
def test_explicit_process_token_overrides_the_other_alias_in_dotenv(
    tmp_path, monkeypatch, process_name, file_name,
):
    monkeypatch.delenv("SENTINEL_INTERNAL_TOKEN", raising=False)
    monkeypatch.delenv("INTERNAL_EXECUTION_TOKEN", raising=False)
    monkeypatch.setenv(process_name, "process-token")
    env_file = tmp_path / ".env"
    env_file.write_text(f"{file_name}=file-token\n", encoding="utf-8")

    assert Settings(_env_file=env_file).internal_execution_token == "process-token"


def test_settings_reject_conflicting_process_tokens_without_disclosing_values(
    monkeypatch,
):
    monkeypatch.setenv("SENTINEL_INTERNAL_TOKEN", "canonical-process-secret")
    monkeypatch.setenv("INTERNAL_EXECUTION_TOKEN", "legacy-process-secret")

    with pytest.raises(ValueError) as conflict:
        Settings(_env_file=None)

    assert "canonical-process-secret" not in str(conflict.value)
    assert "legacy-process-secret" not in str(conflict.value)


def test_settings_trim_equal_process_token_aliases_before_comparison(monkeypatch):
    monkeypatch.setenv("SENTINEL_INTERNAL_TOKEN", "  shared-process-token\t")
    monkeypatch.setenv("INTERNAL_EXECUTION_TOKEN", "\tshared-process-token  ")

    assert Settings(_env_file=None).internal_execution_token == "shared-process-token"


def test_settings_treat_whitespace_process_alias_as_empty_and_trim_dotenv_token(
    tmp_path, monkeypatch,
):
    monkeypatch.setenv("SENTINEL_INTERNAL_TOKEN", " \t ")
    monkeypatch.delenv("INTERNAL_EXECUTION_TOKEN", raising=False)
    env_file = tmp_path / ".env"
    env_file.write_text(
        'SENTINEL_INTERNAL_TOKEN="  trimmed-file-token  "\n',
        encoding="utf-8",
    )

    assert Settings(_env_file=env_file).internal_execution_token == "trimmed-file-token"


def test_settings_trim_equal_quoted_dotenv_aliases_before_comparison(
    tmp_path, monkeypatch,
):
    monkeypatch.delenv("SENTINEL_INTERNAL_TOKEN", raising=False)
    monkeypatch.delenv("INTERNAL_EXECUTION_TOKEN", raising=False)
    env_file = tmp_path / ".env"
    env_file.write_text(
        'SENTINEL_INTERNAL_TOKEN="  shared-file-token"\n'
        'INTERNAL_EXECUTION_TOKEN="shared-file-token  "\n',
        encoding="utf-8",
    )

    assert Settings(_env_file=env_file).internal_execution_token == "shared-file-token"


def test_settings_preserve_explicit_internal_token_constructor_values():
    settings = Settings(_env_file=None, internal_execution_token="explicit-token")

    assert settings.internal_execution_token == "explicit-token"


def test_settings_trim_explicit_internal_token_constructor_values():
    settings = Settings(_env_file=None, internal_execution_token="  explicit-token\t ")

    assert settings.internal_execution_token == "explicit-token"
