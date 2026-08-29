from __future__ import annotations

import importlib
import re
from datetime import date

import pytest
from sqlalchemy import select

from app.config import Settings
from app.database import Base, make_session_factory
from app.models import Dataset, Datasource


def load_script():
    return importlib.import_module("scripts.generate_intransit_temperature_data")


def test_legacy_starrocks_temperature_seed_is_disabled_by_default(monkeypatch, capsys):
    generator = load_script()
    monkeypatch.setattr(generator, "parse_args", lambda: type("Args", (), {"allow_legacy_starrocks_seed": False, "seed": 1})())
    monkeypatch.setattr(generator, "generate_rows", lambda *_: (_ for _ in ()).throw(AssertionError("must not seed")))
    generator.main()
    assert "已停用" in capsys.readouterr().out


def test_generated_rows_are_deterministic_and_contain_exactly_two_distinct_anomalies():
    script = load_script()

    rows = script.generate_rows()

    assert rows == script.generate_rows()
    assert len(rows) == 188
    assert len({row[1] for row in rows}) == 188
    assert {row[0] for row in rows} == {"2026-08-22"}
    assert {row[1].date() for row in rows} == {date(2026, 8, 22)}
    assert all(re.fullmatch(r"[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-Z][A-Z0-9]{5}", row[2]) for row in rows)

    refrigerated_anomalies = [row for row in rows if not (0 < row[4] <= 7)]
    frozen_anomalies = [row for row in rows if row[5] > -12]
    assert len(refrigerated_anomalies) == 1
    assert len(frozen_anomalies) == 1
    assert refrigerated_anomalies[0] != frozen_anomalies[0]
    assert refrigerated_anomalies[0][5] <= -12
    assert 0 < frozen_anomalies[0][4] <= 7


class FakeStarRocksCursor:
    def __init__(self, state):
        self.state = state

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def execute(self, sql):
        normalized = " ".join(sql.split())
        self.state["executed"].append(normalized)
        if normalized == f"TRUNCATE TABLE {self.state['table_name']}":
            self.state["rows"] = []

    def executemany(self, sql, rows):
        self.state["insert_sql"].append(" ".join(sql.split()))
        self.state["rows"].extend(list(rows))


class FakeStarRocksConnection:
    def __init__(self, state):
        self.state = state

    def cursor(self):
        return FakeStarRocksCursor(self.state)

    def close(self):
        self.state["close_count"] += 1


def test_starrocks_seed_replaces_only_the_owned_table_and_uses_required_schema(monkeypatch):
    script = load_script()
    state = {
        "table_name": script.TABLE_NAME,
        "executed": [],
        "insert_sql": [],
        "rows": [("old",)],
        "close_count": 0,
    }
    databases = []

    def connection(database=None):
        databases.append(database)
        return FakeStarRocksConnection(state)

    monkeypatch.setattr(script, "starrocks_connection", connection)
    rows = script.generate_rows()

    script.seed_starrocks(rows)
    script.seed_starrocks(rows)

    assert databases == [None, "tastien_ads", None, "tastien_ads"]
    assert len(state["rows"]) == 188
    assert state["close_count"] == 4
    assert state["executed"].count("CREATE DATABASE IF NOT EXISTS tastien_ads") == 2
    assert state["executed"].count(f"TRUNCATE TABLE {script.TABLE_NAME}") == 2
    create_sql = next(sql for sql in state["executed"] if sql.startswith("CREATE TABLE IF NOT EXISTS"))
    assert "data_date VARCHAR(10)" in create_sql
    assert "detected_at DATETIME" in create_sql
    assert "license_plate VARCHAR(16)" in create_sql
    assert "target_store VARCHAR(100)" in create_sql
    assert "refrigerated_temperature DECIMAL(5,2)" in create_sql
    assert "frozen_temperature DECIMAL(5,2)" in create_sql


def test_platform_dataset_is_created_and_updated_idempotently(tmp_path):
    script = load_script()
    database_url = f"sqlite+pysqlite:///{tmp_path / 'platform.sqlite'}"
    settings = Settings(database_url=database_url)

    script.register_platform_dataset(settings)
    script.register_platform_dataset(settings)

    engine, factory = make_session_factory(database_url, testing=True)
    with factory() as session:
        sources = list(session.scalars(select(Datasource)))
        datasets = list(session.scalars(select(Dataset)))
        assert len(sources) == 1
        assert len(datasets) == 1
        assert sources[0].name == "塔斯汀经营 ADS"
        assert sources[0].database == "tastien_ads"
        assert datasets[0].name == "运输途中车辆温度"
        assert datasets[0].datasource_id == sources[0].id
        assert datasets[0].sql == script.DATASET_SQL
        assert datasets[0].fields == script.DATASET_FIELDS
        assert datasets[0].row_count == 188
    engine.dispose()


def test_platform_dataset_refuses_to_overwrite_a_custom_same_named_datasource(tmp_path):
    script = load_script()
    database_url = f"sqlite+pysqlite:///{tmp_path / 'custom.sqlite'}"
    engine, factory = make_session_factory(database_url, testing=True)
    Base.metadata.create_all(engine)
    with factory() as session:
        session.add(Datasource(
            name="塔斯汀经营 ADS", type="starrocks", host="customer.internal", port=9030,
            database="customer_ads", username="reader", password_encrypted="encrypted",
            description="customer owned", status="online",
        ))
        session.commit()
    engine.dispose()

    with pytest.raises(RuntimeError, match="同名数据源.*不匹配"):
        script.register_platform_dataset(Settings(database_url=database_url))
