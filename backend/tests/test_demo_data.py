import random
from types import SimpleNamespace

from sqlalchemy import select

from app.config import Settings
from app.database import Base, make_session_factory
from app.models import Dataset, Datasource, Rule
from scripts import generate_demo_data, seed_platform
from scripts.generate_demo_data import is_injected_anomaly


def test_legacy_platform_seed_is_disabled_by_default(monkeypatch, capsys):
    monkeypatch.setattr(seed_platform, "get_settings", lambda: (_ for _ in ()).throw(AssertionError("must not connect")))
    seed_platform.main()
    assert "已停用" in capsys.readouterr().out


def test_legacy_data_generation_requires_explicit_opt_in(monkeypatch):
    args = type("Args", (), {"allow_legacy_demo_reset": False, "seed": 1})()
    monkeypatch.setattr(generate_demo_data, "parse_args", lambda: args)
    monkeypatch.setattr(generate_demo_data, "seed_mysql", lambda *_: (_ for _ in ()).throw(AssertionError("must not seed")))
    generate_demo_data.main()


def test_small_profiles_always_include_a_latest_day_anomaly():
    assert is_injected_anomaly(store_index=1, day_offset=0)
    assert not is_injected_anomaly(store_index=1, day_offset=1)


def test_demo_validation_user_ids_are_deterministic_placeholders():
    assert generate_demo_data.demo_manager_user_id(1) == "demo_user_00001"
    assert generate_demo_data.demo_manager_user_id(12000) == "demo_user_12000"


class FakeStarRocksCursor:
    def __init__(self, state):
        self.state = state
        self.fetchone_result = None
        self.fetchall_result = []
        self.description = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def execute(self, sql, params=None):
        normalized = " ".join(sql.split())
        self.state["executed"].append((normalized, params))
        if "information_schema.columns" in normalized:
            if params[2] == self.state.get("pending_column"):
                if self.state["pending_visibility_checks"] > 0:
                    self.state["pending_visibility_checks"] -= 1
                    self.fetchone_result = None
                    return
                self.state["columns"].add(self.state.pop("pending_column"))
            self.fetchone_result = (1,) if params[2] in self.state["columns"] else None
        elif normalized.startswith("ALTER TABLE ads_store_daily_operation ADD COLUMN manager_user_id"):
            self.state["alter_count"] += 1
            self.state["pending_column"] = "manager_user_id"
        elif normalized == "SHOW ALTER TABLE COLUMN FROM tastien_ads":
            self.description = [(name,) for name in self.state.get("alter_job_columns", [])]
            self.fetchall_result = self.state.get("alter_job_rows", [])
        elif normalized.startswith("TRUNCATE TABLE "):
            table_name = normalized.split()[-1]
            self.state["truncated_tables"].append(table_name)
            self.state["tables"][table_name] = []

    def fetchone(self):
        return self.fetchone_result

    def fetchall(self):
        return self.fetchall_result

    def executemany(self, sql, rows):
        normalized = " ".join(sql.split())
        rows = list(rows)
        self.state["batches"].append((normalized, rows))
        table_name = normalized.split()[2]
        columns = [column.strip() for column in normalized.split("(", 1)[1].split(")", 1)[0].split(",")]
        self.state["tables"][table_name].extend(dict(zip(columns, row)) for row in rows)


class FakeStarRocksConnection:
    def __init__(self, state):
        self.state = state

    def cursor(self):
        return FakeStarRocksCursor(self.state)

    def close(self):
        pass


def test_existing_twelve_column_starrocks_data_is_upgraded_and_replaced_idempotently(monkeypatch):
    state = {
        "columns": {
            "metric_date", "store_id", "store_name", "province", "manager_open_id", "gmv",
            "order_count", "avg_order_value", "refund_rate", "avg_delivery_minutes", "member_ratio",
            "gmv_growth_rate",
        },
        "alter_count": 0,
        "pending_visibility_checks": 2,
        "executed": [],
        "batches": [],
        "truncated_tables": [],
        "tables": {
            "ads_store_daily_operation": [
                {"store_id": "TS00001", "manager_open_id": "ou_demo_00001", "manager_user_id": ""}
            ],
            "ads_region_daily_operation": [{"province": "旧数据"}],
            "ads_brand_daily_operation": [{"gmv": -1}],
            "user_owned_table": [{"sentinel": "keep"}],
        },
    }
    sleeps = []

    def connection(_database=None):
        return FakeStarRocksConnection(state)

    monkeypatch.setattr(generate_demo_data, "starrocks_connection", connection)
    monkeypatch.setattr(generate_demo_data.time, "sleep", sleeps.append)
    args = SimpleNamespace(reset=False, stores=1, days=1, batch_size=10)

    generate_demo_data.seed_starrocks(args, random.Random(7))
    generate_demo_data.seed_starrocks(args, random.Random(7))

    assert state["alter_count"] == 1
    assert sleeps == [2, 2]
    alter_sql = next(sql for sql, _ in state["executed"] if sql.startswith("ALTER TABLE"))
    assert alter_sql == (
        'ALTER TABLE ads_store_daily_operation ADD COLUMN manager_user_id '
        'VARCHAR(100) DEFAULT "" AFTER manager_open_id'
    )
    store_inserts = [item for item in state["batches"] if item[0].startswith("INSERT INTO ads_store_daily_operation")]
    assert len(store_inserts) == 2
    assert all(
        sql.startswith(
            "INSERT INTO ads_store_daily_operation "
            "(metric_date, store_id, store_name, province, manager_open_id, manager_user_id,"
        )
        for sql, _ in store_inserts
    )
    assert all(len(row) == 13 for _, rows in store_inserts for row in rows)
    assert state["truncated_tables"] == [
        "ads_store_daily_operation",
        "ads_region_daily_operation",
        "ads_brand_daily_operation",
    ] * 2
    assert len(state["tables"]["ads_store_daily_operation"]) == 1
    assert state["tables"]["ads_store_daily_operation"][0]["store_id"] == "TS00001"
    assert state["tables"]["ads_store_daily_operation"][0]["manager_user_id"] == "demo_user_00001"
    assert len(state["tables"]["ads_region_daily_operation"]) == 1
    assert len(state["tables"]["ads_brand_daily_operation"]) == 1
    assert state["tables"]["user_owned_table"] == [{"sentinel": "keep"}]


def test_cancelled_starrocks_column_job_reports_job_reason_without_waiting(monkeypatch):
    state = {
        "columns": set(),
        "alter_count": 0,
        "pending_visibility_checks": 999,
        "executed": [],
        "batches": [],
        "truncated_tables": [],
        "tables": {},
        "alter_job_columns": ["JobId", "TableName", "State", "Msg"],
        "alter_job_rows": [
            (4321, "ads_store_daily_operation", "CANCELLED", "schema change rejected")
        ],
    }
    sleeps = []
    cursor = FakeStarRocksCursor(state)
    monkeypatch.setattr(generate_demo_data.time, "sleep", sleeps.append)

    try:
        generate_demo_data.ensure_manager_user_id_column(cursor)
    except RuntimeError as exc:
        message = str(exc)
    else:
        raise AssertionError("cancelled StarRocks schema-change job should fail")

    assert "4321" in message
    assert "CANCELLED" in message
    assert "schema change rejected" in message
    assert sleeps == []


def test_seeded_rule_is_disabled_but_ready_for_demo_user_id_field(tmp_path, monkeypatch):
    database_url = f"sqlite+pysqlite:///{tmp_path / 'seed.sqlite'}"
    monkeypatch.setattr(
        seed_platform,
        "get_settings",
        lambda: Settings(database_url=database_url),
    )

    seed_platform.main(allow_legacy_demo=True)

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


def test_seed_platform_upgrades_legacy_demo_metadata_without_enabling_rule(tmp_path, monkeypatch):
    database_url = f"sqlite+pysqlite:///{tmp_path / 'legacy-seed.sqlite'}"
    engine, factory = make_session_factory(database_url, testing=True)
    Base.metadata.create_all(engine)
    with factory() as session:
        source = Datasource(
            name="塔斯汀经营 ADS", type="starrocks", host="127.0.0.1", port=9030,
            database="tastien_ads", username="root", password_encrypted="",
            description="StarRocks 综合经营 ADS 层",
        )
        dataset = Dataset(
            name="门店综合经营日报", datasource=source, description="StarRocks 门店级 ADS 指标，用于异常检测",
            sql=seed_platform.LEGACY_ADS_DAILY_SQL,
            fields=seed_platform.LEGACY_ADS_DAILY_FIELDS,
        )
        rule = Rule(
            name="门店高退款率检测", description="退款率超过 15% 时触发；启用前请替换为真实飞书接收者",
            dataset=dataset, severity="high", logic="AND",
            conditions=[{"field": "refund_rate", "operator": "gt", "value": 0.15, "upper_value": None, "baseline": None}],
            anomaly_key_fields=["store_id", "metric_date"],
            schedule={"frequency": "day", "interval": 1, "time": "09:00", "start_date": "2026-08-22", "end_date": None},
            notification_targets=[{"receive_id_type": "open_id", "source": "field", "value": None, "field": "manager_open_id"}],
            validation_enabled=False, validation_targets=[], validation_timeout_minutes=1440,
            enabled=False, sync_status="pending",
        )
        session.add(rule)
        session.commit()
        dataset_id, rule_id = dataset.id, rule.id
    engine.dispose()
    monkeypatch.setattr(seed_platform, "get_settings", lambda: Settings(database_url=database_url))

    seed_platform.main(allow_legacy_demo=True)

    engine, factory = make_session_factory(database_url, testing=True)
    try:
        with factory() as session:
            dataset = session.get(Dataset, dataset_id)
            rule = session.get(Rule, rule_id)
            assert dataset.sql == seed_platform.ADS_DAILY_SQL
            assert dataset.fields == seed_platform.ADS_DAILY_FIELDS
            assert rule.validation_enabled is False
            assert rule.validation_targets == [{"source": "field", "field": "manager_user_id"}]
            assert rule.validation_timeout_minutes == 1440
            assert rule.enabled is False
    finally:
        engine.dispose()


def test_seed_platform_preserves_customized_demo_named_metadata(tmp_path, monkeypatch, capsys):
    database_url = f"sqlite+pysqlite:///{tmp_path / 'custom-seed.sqlite'}"
    engine, factory = make_session_factory(database_url, testing=True)
    Base.metadata.create_all(engine)
    with factory() as session:
        source = Datasource(
            name="塔斯汀经营 ADS", type="starrocks", host="custom-host", port=9030,
            database="custom_ads", username="root", password_encrypted="",
        )
        dataset = Dataset(
            name="门店综合经营日报", datasource=source, description="user customized",
            sql="SELECT custom_metric FROM custom_table",
            fields=[{"name": "custom_metric", "type": "INT"}],
        )
        rule = Rule(
            name="门店高退款率检测", description="user customized", dataset=dataset,
            severity="critical", logic="OR",
            conditions=[{"field": "custom_metric", "operator": "gt", "value": 99}],
            anomaly_key_fields=["custom_metric"], schedule={"frequency": "hour", "interval": 2},
            notification_targets=[{"receive_id_type": "user_id", "source": "literal", "value": "custom-user"}],
            validation_enabled=True,
            validation_targets=[{"source": "literal", "value": "custom-validator"}],
            validation_timeout_minutes=30, enabled=True, sync_status="synced",
        )
        session.add(rule)
        session.commit()
        dataset_id, rule_id = dataset.id, rule.id
    engine.dispose()
    monkeypatch.setattr(seed_platform, "get_settings", lambda: Settings(database_url=database_url))

    seed_platform.main(allow_legacy_demo=True)

    engine, factory = make_session_factory(database_url, testing=True)
    try:
        with factory() as session:
            dataset = session.get(Dataset, dataset_id)
            rule = session.get(Rule, rule_id)
            assert (dataset.sql, dataset.fields, dataset.description) == (
                "SELECT custom_metric FROM custom_table",
                [{"name": "custom_metric", "type": "INT"}],
                "user customized",
            )
            assert rule.validation_enabled is True
            assert rule.validation_targets == [{"source": "literal", "value": "custom-validator"}]
            assert rule.validation_timeout_minutes == 30
            assert rule.notification_targets == [
                {"receive_id_type": "user_id", "source": "literal", "value": "custom-user"}
            ]
            assert rule.enabled is True
            assert "未自动更新" in capsys.readouterr().out
    finally:
        engine.dispose()


def test_seed_platform_does_not_point_new_rule_at_unmigrated_custom_dataset(tmp_path, monkeypatch, capsys):
    database_url = f"sqlite+pysqlite:///{tmp_path / 'custom-dataset.sqlite'}"
    engine, factory = make_session_factory(database_url, testing=True)
    Base.metadata.create_all(engine)
    with factory() as session:
        source = Datasource(
            name="塔斯汀经营 ADS", type="starrocks", host="custom-host", port=9030,
            database="custom_ads", username="root", password_encrypted="",
        )
        session.add(Dataset(
            name="门店综合经营日报", datasource=source, description="user customized",
            sql="SELECT custom_metric FROM custom_table",
            fields=[{"name": "custom_metric", "type": "INT"}],
        ))
        session.commit()
    engine.dispose()
    monkeypatch.setattr(seed_platform, "get_settings", lambda: Settings(database_url=database_url))

    seed_platform.main(allow_legacy_demo=True)

    engine, factory = make_session_factory(database_url, testing=True)
    try:
        with factory() as session:
            rule = session.scalar(select(Rule).where(Rule.name == "门店高退款率检测"))
            assert rule.validation_enabled is False
            assert rule.validation_targets == []
            assert rule.enabled is False
            assert "未自动更新" in capsys.readouterr().out
    finally:
        engine.dispose()


def test_seed_platform_does_not_upgrade_legacy_metadata_on_same_named_custom_datasource(
    tmp_path, monkeypatch, capsys
):
    database_url = f"sqlite+pysqlite:///{tmp_path / 'custom-source-legacy-dataset.sqlite'}"
    engine, factory = make_session_factory(database_url, testing=True)
    Base.metadata.create_all(engine)
    with factory() as session:
        source = Datasource(
            name="塔斯汀经营 ADS", type="starrocks", host="customer-starrocks.internal", port=9030,
            database="tastien_ads", username="root", password_encrypted="",
            description="customer-owned datasource",
        )
        dataset = Dataset(
            name="门店综合经营日报", datasource=source, description="customer-owned dataset",
            sql=seed_platform.LEGACY_ADS_DAILY_SQL,
            fields=seed_platform.LEGACY_ADS_DAILY_FIELDS,
        )
        session.add(dataset)
        session.commit()
        dataset_id = dataset.id
    engine.dispose()
    monkeypatch.setattr(seed_platform, "get_settings", lambda: Settings(database_url=database_url))

    seed_platform.main(allow_legacy_demo=True)

    engine, factory = make_session_factory(database_url, testing=True)
    try:
        with factory() as session:
            dataset = session.get(Dataset, dataset_id)
            rule = session.scalar(select(Rule).where(Rule.name == "门店高退款率检测"))
            assert dataset.sql == seed_platform.LEGACY_ADS_DAILY_SQL
            assert dataset.fields == seed_platform.LEGACY_ADS_DAILY_FIELDS
            assert rule.validation_targets == []
            assert "数据源指纹" in capsys.readouterr().out
    finally:
        engine.dispose()


def test_seed_platform_skips_demo_dataset_and_rule_for_same_named_custom_datasource_without_dataset(
    tmp_path, monkeypatch, capsys
):
    database_url = f"sqlite+pysqlite:///{tmp_path / 'custom-source-no-dataset.sqlite'}"
    engine, factory = make_session_factory(database_url, testing=True)
    Base.metadata.create_all(engine)
    with factory() as session:
        session.add(Datasource(
            name="塔斯汀经营 ADS", type="starrocks", host="customer-starrocks.internal", port=9030,
            database="customer_ads", username="customer", password_encrypted="encrypted",
            description="customer-owned datasource",
        ))
        session.commit()
    engine.dispose()
    monkeypatch.setattr(seed_platform, "get_settings", lambda: Settings(database_url=database_url))

    seed_platform.main(allow_legacy_demo=True)

    engine, factory = make_session_factory(database_url, testing=True)
    try:
        with factory() as session:
            assert session.scalar(select(Dataset).where(Dataset.name == "门店综合经营日报")) is None
            assert session.scalar(select(Rule).where(Rule.name == "门店高退款率检测")) is None
        output = capsys.readouterr().out
        assert "完整 demo 数据源指纹" in output
        assert "跳过" in output
    finally:
        engine.dispose()


def test_seed_platform_does_not_add_validation_target_to_active_legacy_demo_rule(
    tmp_path, monkeypatch, capsys
):
    database_url = f"sqlite+pysqlite:///{tmp_path / 'active-legacy-rule.sqlite'}"
    engine, factory = make_session_factory(database_url, testing=True)
    Base.metadata.create_all(engine)
    with factory() as session:
        source = Datasource(
            name="塔斯汀经营 ADS", type="starrocks", host="127.0.0.1", port=9030,
            database="tastien_ads", username="root", password_encrypted="",
            description="StarRocks 综合经营 ADS 层",
        )
        dataset = Dataset(
            name="门店综合经营日报", datasource=source,
            description="StarRocks 门店级 ADS 指标，用于异常检测",
            sql=seed_platform.LEGACY_ADS_DAILY_SQL,
            fields=seed_platform.LEGACY_ADS_DAILY_FIELDS,
        )
        rule = Rule(
            name="门店高退款率检测", description=seed_platform.DEMO_RULE_DESCRIPTION,
            dataset=dataset, severity="high", logic="AND",
            conditions=[dict(condition) for condition in seed_platform.DEMO_RULE_CONDITIONS],
            anomaly_key_fields=["store_id", "metric_date"],
            schedule={"frequency": "day", "interval": 1, "time": "09:00", "start_date": "2026-08-22", "end_date": None},
            notification_targets=[dict(target) for target in seed_platform.DEMO_NOTIFICATION_TARGETS],
            validation_enabled=False, validation_targets=[], validation_timeout_minutes=1440,
            enabled=True, sync_status="synced",
        )
        session.add(rule)
        session.commit()
        rule_id = rule.id
    engine.dispose()
    monkeypatch.setattr(seed_platform, "get_settings", lambda: Settings(database_url=database_url))

    seed_platform.main(allow_legacy_demo=True)

    engine, factory = make_session_factory(database_url, testing=True)
    try:
        with factory() as session:
            rule = session.get(Rule, rule_id)
            assert rule.enabled is True
            assert rule.validation_enabled is False
            assert rule.validation_targets == []
            assert "启用中的 demo 规则" in capsys.readouterr().out
    finally:
        engine.dispose()
