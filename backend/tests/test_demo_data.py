from sqlalchemy import select

from app.config import Settings
from app.database import make_session_factory
from app.models import Dataset, Rule
from scripts import generate_demo_data, seed_platform
from scripts.generate_demo_data import is_injected_anomaly


def test_small_profiles_always_include_a_latest_day_anomaly():
    assert is_injected_anomaly(store_index=1, day_offset=0)
    assert not is_injected_anomaly(store_index=1, day_offset=1)


def test_demo_validation_user_ids_are_deterministic_placeholders():
    assert generate_demo_data.demo_manager_user_id(1) == "demo_user_00001"
    assert generate_demo_data.demo_manager_user_id(12000) == "demo_user_12000"


def test_seeded_rule_is_disabled_but_ready_for_demo_user_id_field(tmp_path, monkeypatch):
    database_url = f"sqlite+pysqlite:///{tmp_path / 'seed.sqlite'}"
    monkeypatch.setattr(
        seed_platform,
        "get_settings",
        lambda: Settings(database_url=database_url),
    )

    seed_platform.main()

    engine, factory = make_session_factory(database_url, testing=True)
    try:
        with factory() as session:
            dataset = session.scalar(select(Dataset).where(Dataset.name == "门店综合经营日报"))
            rule = session.scalar(select(Rule).where(Rule.name == "门店高退款率检测"))

            assert "manager_user_id" in {field["name"] for field in dataset.fields}
            assert "manager_user_id" in dataset.sql
            assert rule.validation_enabled is False
            assert rule.validation_targets == [{"source": "field", "field": "manager_user_id"}]
            assert rule.validation_timeout_minutes == 1440
    finally:
        engine.dispose()
