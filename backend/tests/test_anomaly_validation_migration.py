from __future__ import annotations

from datetime import datetime
import importlib.util
import io
import json
from pathlib import Path

import sqlalchemy as sa
import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy.dialects import mysql, sqlite
from sqlalchemy.schema import CreateColumn

from app.database import Base
from app.models import AnomalyGroupBroadcastDelivery, AnomalyRecordGroup, Rule, RuleRun


MIGRATION_PATH = (
    Path(__file__).resolve().parents[1]
    / "alembic"
    / "versions"
    / "20260822_0002_anomaly_validation.py"
)
INITIAL_MIGRATION_PATH = MIGRATION_PATH.with_name("20260809_0001_initial.py")
INDEX_MIGRATION_PATH = MIGRATION_PATH.with_name("20260822_0004_validation_query_indexes.py")
RETRY_MIGRATION_PATH = MIGRATION_PATH.with_name("20260822_0005_validation_delivery_retry_schedule.py")
PUSH_MIGRATION_PATH = MIGRATION_PATH.with_name("20260822_0006_anomaly_push_pipeline.py")
PUSH_REPAIR_MIGRATION_PATH = MIGRATION_PATH.with_name(
    "20260822_0007_repair_anomaly_push_job_columns.py"
)
SQL_VALIDATION_MIGRATION_PATH = MIGRATION_PATH.with_name(
    "20260822_0008_sql_validation.py"
)
ANOMALY_GROUP_MIGRATION_PATH = MIGRATION_PATH.with_name(
    "20260823_0009_anomaly_record_groups.py"
)
PLAINTEXT_WEBHOOK_MIGRATION_PATH = MIGRATION_PATH.with_name(
    "20260823_0010_plaintext_group_webhooks.py"
)
MESSAGE_TEMPLATE_MIGRATION_PATH = MIGRATION_PATH.with_name(
    "20260823_0011_message_templates.py"
)


def test_rule_enhancement_migration_preserves_legacy_data_and_separates_broadcast_kinds():
    path = MIGRATION_PATH.with_name("20260828_0012_rule_enhancements.py")
    spec = importlib.util.spec_from_file_location("rule_enhancements_0012", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    for name in ("rules", "anomaly_records", "anomaly_validation_requests"):
        sa.Table(name, metadata, sa.Column("id", sa.String(36), primary_key=True))
    for name in ("anomaly_record_groups", "anomaly_record_group_members"):
        sa.Table(name, metadata, sa.Column("rule_id", sa.String(36), primary_key=True),
                 sa.Column("detected_at", sa.DateTime, primary_key=True))
    sa.Table("anomaly_group_broadcast_deliveries", metadata,
        sa.Column("id", sa.String(36), primary_key=True), sa.Column("rule_id", sa.String(36)),
        sa.Column("detected_at", sa.DateTime), sa.Column("part_index", sa.Integer),
        sa.UniqueConstraint("rule_id", "detected_at", "part_index", name="uq_anomaly_group_delivery_part"))
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(sa.text("INSERT INTO rules (id) VALUES ('old-rule')"))
        connection.execute(sa.text("INSERT INTO anomaly_group_broadcast_deliveries VALUES ('old-delivery','old-rule','2026-08-28',1)"))
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        migration.upgrade()
        row = connection.execute(sa.text("SELECT repeat_push_enabled, timeout_broadcast_enabled, timeout_mention_targets FROM rules")).one()
        assert tuple(row) == (0, 0, '[]')
        assert connection.execute(sa.text("SELECT broadcast_kind FROM anomaly_group_broadcast_deliveries")).scalar_one() == "situation"
        connection.execute(sa.text("INSERT INTO anomaly_group_broadcast_deliveries (id,rule_id,detected_at,part_index,broadcast_kind) VALUES ('timeout','old-rule','2026-08-28',1,'timeout')"))
        with pytest.raises(RuntimeError, match="超时播报"):
            migration.downgrade()
        connection.execute(sa.text("DELETE FROM anomaly_group_broadcast_deliveries WHERE id='timeout'"))
        migration.downgrade()
        assert connection.execute(sa.text("SELECT id FROM anomaly_group_broadcast_deliveries")).scalar_one() == "old-delivery"
        assert "repeat_push_enabled" not in {column["name"] for column in sa.inspect(connection).get_columns("rules")}
    engine.dispose()


def load_migration():
    spec = importlib.util.spec_from_file_location("anomaly_validation_0002", MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_initial_migration():
    spec = importlib.util.spec_from_file_location("platform_initial_0001", INITIAL_MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_index_migration():
    spec = importlib.util.spec_from_file_location("anomaly_validation_0004", INDEX_MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_retry_migration():
    spec = importlib.util.spec_from_file_location("anomaly_validation_0005", RETRY_MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_push_migration():
    spec = importlib.util.spec_from_file_location("anomaly_push_0006", PUSH_MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_push_repair_migration():
    spec = importlib.util.spec_from_file_location(
        "anomaly_push_0007", PUSH_REPAIR_MIGRATION_PATH,
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_sql_validation_migration():
    spec = importlib.util.spec_from_file_location(
        "sql_validation_0008", SQL_VALIDATION_MIGRATION_PATH,
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_anomaly_group_migration():
    spec = importlib.util.spec_from_file_location(
        "anomaly_groups_0009", ANOMALY_GROUP_MIGRATION_PATH,
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_plaintext_webhook_migration():
    spec = importlib.util.spec_from_file_location(
        "plaintext_group_webhooks_0010", PLAINTEXT_WEBHOOK_MIGRATION_PATH,
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_message_template_migration():
    spec = importlib.util.spec_from_file_location(
        "message_templates_0011", MESSAGE_TEMPLATE_MIGRATION_PATH,
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_message_template_migration_adds_nullable_columns_without_backfilling_legacy_rules():
    """Making templates non-null or rewriting existing rules must fail this compatibility test."""
    migration = load_message_template_migration()
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    rules = sa.Table(
        "rules", metadata,
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(150), nullable=False),
    )
    metadata.create_all(engine)

    with engine.begin() as connection:
        connection.execute(rules.insert().values(id="legacy", name="旧规则"))
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        row = connection.execute(sa.text(
            "SELECT private_message_template, group_message_template FROM rules WHERE id='legacy'"
        )).one()
        columns = {item["name"]: item for item in sa.inspect(connection).get_columns("rules")}

    assert row == (None, None)
    assert columns["private_message_template"]["nullable"] is True
    assert columns["group_message_template"]["nullable"] is True
    engine.dispose()


def test_initial_migration_is_a_frozen_pre_validation_schema():
    migration = load_initial_migration()
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")

    with engine.begin() as connection:
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        inspector = sa.inspect(connection)
        tables = set(inspector.get_table_names())
        rule_columns = {column["name"] for column in inspector.get_columns("rules")}
        anomaly_columns = {column["name"] for column in inspector.get_columns("anomaly_records")}

    assert tables == {
        "users", "datasources", "datasets", "rules", "rule_runs",
        "anomaly_records", "anomaly_events", "notification_deliveries",
    }
    assert "validation_enabled" not in rule_columns
    assert "validation_targets" not in rule_columns
    assert "description" not in anomaly_columns
    assert "validation_deadline" not in anomaly_columns
    engine.dispose()


def test_validation_targets_default_compiles_as_mysql_json_expression_and_valid_sqlite_default():
    """Regressing to a quoted MySQL JSON default must fail before production migration."""
    migration = load_migration()

    column = migration._validation_targets_column()
    mysql_dialect = mysql.dialect()
    mysql_dialect.server_version_info = (8, 4, 10)
    mysql_ddl = str(CreateColumn(column).compile(dialect=mysql_dialect))
    sqlite_ddl = str(CreateColumn(column).compile(dialect=sqlite.dialect()))
    mysql_alter_buffer = io.StringIO()
    mysql_context = MigrationContext.configure(
        dialect=mysql_dialect,
        opts={"as_sql": True, "output_buffer": mysql_alter_buffer},
    )
    Operations(mysql_context).add_column("rules", column)
    mysql_alter = mysql_alter_buffer.getvalue()

    assert "DEFAULT ('[]')" in mysql_ddl
    assert "DEFAULT '[]'" not in mysql_ddl
    assert "ALTER TABLE rules ADD COLUMN validation_targets JSON NOT NULL DEFAULT ('[]')" in mysql_alter
    assert "DEFAULT ('[]')" in sqlite_ddl
    assert column.nullable is False


def test_description_default_compiles_as_mysql_text_expression_and_valid_sqlite_default():
    """A quoted TEXT default would make the MySQL 8.4 ALTER fail in production."""
    migration = load_migration()

    column = migration._description_column()
    mysql_dialect = mysql.dialect()
    mysql_dialect.server_version_info = (8, 4, 10)
    mysql_ddl = str(CreateColumn(column).compile(dialect=mysql_dialect))
    sqlite_ddl = str(CreateColumn(column).compile(dialect=sqlite.dialect()))
    mysql_alter_buffer = io.StringIO()
    mysql_context = MigrationContext.configure(
        dialect=mysql_dialect,
        opts={"as_sql": True, "output_buffer": mysql_alter_buffer},
    )
    Operations(mysql_context).add_column("anomaly_records", column)
    mysql_alter = mysql_alter_buffer.getvalue()

    assert "TEXT NOT NULL DEFAULT ('')" in mysql_ddl
    assert "TEXT NOT NULL DEFAULT ''" not in mysql_ddl
    assert "ALTER TABLE anomaly_records ADD COLUMN description TEXT NOT NULL DEFAULT ('')" in mysql_alter
    assert "DEFAULT ('')" in sqlite_ddl
    assert column.nullable is False


def test_sqlite_upgrade_backfills_existing_rules_and_preserves_non_null_default():
    """Existing rules must receive [] and future raw inserts must retain the same non-null default."""
    migration = load_migration()
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    rules = sa.Table("rules", metadata, sa.Column("id", sa.String(36), primary_key=True))
    sa.Table("anomaly_records", metadata, sa.Column("id", sa.String(36), primary_key=True))
    metadata.create_all(engine)

    with engine.begin() as connection:
        connection.execute(rules.insert().values(id="legacy-rule"))
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()

        legacy_value = connection.scalar(sa.text(
            "SELECT validation_targets FROM rules WHERE id = 'legacy-rule'"
        ))
        connection.execute(sa.text("INSERT INTO rules (id) VALUES ('new-rule')"))
        new_value = connection.scalar(sa.text(
            "SELECT validation_targets FROM rules WHERE id = 'new-rule'"
        ))
        column = next(item for item in sa.inspect(connection).get_columns("rules") if item["name"] == "validation_targets")

    assert json.loads(legacy_value) == []
    assert json.loads(new_value) == []
    assert column["nullable"] is False
    assert "[]" in column["default"]
    engine.dispose()


def test_fresh_metadata_uses_the_same_expression_default():
    """Fresh Alembic databases created through current metadata must not bypass the JSON default."""
    model_column = Rule.__table__.c.validation_targets
    mysql_ddl = str(CreateColumn(model_column).compile(dialect=mysql.dialect()))
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    sqlite_column = next(
        item for item in sa.inspect(engine).get_columns("rules")
        if item["name"] == "validation_targets"
    )

    assert "DEFAULT ('[]')" in mysql_ddl
    assert sqlite_column["nullable"] is False
    assert "[]" in sqlite_column["default"]
    engine.dispose()


def test_query_index_migration_adds_common_filter_sort_and_maintenance_indexes_on_sqlite():
    migration = load_index_migration()
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    sa.Table(
        "anomaly_records", metadata,
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("validation_deadline", sa.DateTime()),
        sa.Column("first_seen_at", sa.DateTime(), nullable=False),
    )
    sa.Table(
        "anomaly_validation_requests", metadata,
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("delivery_status", sa.String(20), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    metadata.create_all(engine)

    with engine.begin() as connection:
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        anomaly_indexes = {
            item["name"]: item["column_names"]
            for item in sa.inspect(connection).get_indexes("anomaly_records")
        }
        request_indexes = {
            item["name"]: item["column_names"]
            for item in sa.inspect(connection).get_indexes("anomaly_validation_requests")
        }

    assert anomaly_indexes == {
        "ix_anomaly_records_first_seen_id": ["first_seen_at", "id"],
        "ix_anomaly_records_status_deadline": ["status", "validation_deadline"],
    }
    assert request_indexes == {
        "ix_validation_requests_delivery_status_updated": ["delivery_status", "updated_at"],
    }
    engine.dispose()


def test_retry_schedule_migration_adds_persistent_fair_queue_columns_and_index():
    migration = load_retry_migration()
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    sa.Table(
        "anomaly_validation_requests", metadata,
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("delivery_status", sa.String(20), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    metadata.create_all(engine)

    with engine.begin() as connection:
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        inspector = sa.inspect(connection)
        columns = {item["name"]: item for item in inspector.get_columns(
            "anomaly_validation_requests"
        )}
        indexes = {
            item["name"]: item["column_names"]
            for item in inspector.get_indexes("anomaly_validation_requests")
        }

    assert columns["next_attempt_at"]["nullable"] is True
    assert columns["consecutive_failures"]["nullable"] is False
    assert "0" in str(columns["consecutive_failures"]["default"])
    assert indexes["ix_validation_requests_eligible_retry"] == [
        "delivery_status", "next_attempt_at", "updated_at",
    ]
    engine.dispose()


def test_retry_schedule_columns_and_eligible_index_compile_for_mysql_84():
    migration = load_retry_migration()
    dialect = mysql.dialect()
    dialect.server_version_info = (8, 4, 10)

    next_attempt_ddl = str(CreateColumn(
        migration._next_attempt_column()
    ).compile(dialect=dialect))
    failure_count_ddl = str(CreateColumn(
        migration._consecutive_failures_column()
    ).compile(dialect=dialect))
    metadata = sa.MetaData()
    requests = sa.Table(
        "anomaly_validation_requests",
        metadata,
        sa.Column("delivery_status", sa.String(20), nullable=False),
        sa.Column("next_attempt_at", sa.DateTime()),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    eligible_index = sa.Index(
        migration.ELIGIBLE_INDEX,
        requests.c.delivery_status,
        requests.c.next_attempt_at,
        requests.c.updated_at,
    )
    index_ddl = str(sa.schema.CreateIndex(eligible_index).compile(dialect=dialect))

    assert "next_attempt_at DATETIME" in next_attempt_ddl
    assert "consecutive_failures INTEGER NOT NULL DEFAULT 0" in failure_count_ddl
    assert (
        "CREATE INDEX ix_validation_requests_eligible_retry "
        "ON anomaly_validation_requests (delivery_status, next_attempt_at, updated_at)"
    ) == index_ddl


def test_push_pipeline_migration_creates_state_job_constraints_and_indexes():
    migration = load_push_migration()
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    sa.Table("anomaly_records", metadata, sa.Column("id", sa.String(36), primary_key=True))
    metadata.create_all(engine)

    with engine.begin() as connection:
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        inspector = sa.inspect(connection)
        state = connection.execute(sa.text(
            "SELECT generation, abort_in_progress FROM anomaly_push_pipeline_state WHERE id = 1"
        )).one()
        columns = {item["name"] for item in inspector.get_columns("anomaly_push_jobs")}
        indexes = {item["name"] for item in inspector.get_indexes("anomaly_push_jobs")}
        unique = {item["name"] for item in inspector.get_unique_constraints("anomaly_push_jobs")}

    assert state == (1, 0)
    assert {"generation", "status", "cancel_requested", "kafka_partition", "kafka_offset", "next_attempt_at"} <= columns
    assert indexes == {"ix_anomaly_push_jobs_generation_status", "ix_anomaly_push_jobs_publish"}
    assert unique == {"uq_anomaly_push_job_delivery"}
    engine.dispose()


def test_push_pipeline_repair_migration_adds_missing_columns_idempotently():
    migration = load_push_repair_migration()
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    anomalies = sa.Table(
        "anomaly_records",
        metadata,
        sa.Column("id", sa.String(36), primary_key=True),
    )
    jobs = sa.Table(
        "anomaly_push_jobs",
        metadata,
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("anomaly_id", sa.String(36), sa.ForeignKey(anomalies.c.id), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("delivery_id", sa.String(36), nullable=False),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("publish_attempts", sa.Integer(), nullable=False),
        sa.Column("dispatch_attempts", sa.Integer(), nullable=False),
        sa.Column("kafka_partition", sa.Integer(), nullable=True),
        sa.Column("kafka_offset", sa.Integer(), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    metadata.create_all(engine)

    with engine.begin() as connection:
        connection.execute(anomalies.insert(), {"id": "anomaly-1"})
        connection.execute(jobs.insert(), {
            "id": "job-1",
            "anomaly_id": "anomaly-1",
            "kind": "notification",
            "delivery_id": "delivery-1",
            "generation": 1,
            "status": "pending_publish",
            "publish_attempts": 0,
            "dispatch_attempts": 0,
            "created_at": datetime(2026, 8, 22, 14, 0),
            "updated_at": datetime(2026, 8, 22, 14, 0),
        })
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        migration.upgrade()

        columns = {
            item["name"]: item
            for item in sa.inspect(connection).get_columns("anomaly_push_jobs")
        }
        repaired_row = connection.execute(sa.text(
            "SELECT cancel_requested, next_attempt_at "
            "FROM anomaly_push_jobs WHERE id = 'job-1'"
        )).one()

    assert columns["cancel_requested"]["nullable"] is False
    assert columns["next_attempt_at"]["nullable"] is True
    assert repaired_row == (0, None)
    engine.dispose()


def test_sql_validation_migration_adds_snapshots_and_backfills_existing_pseudo_rows():
    migration = load_sql_validation_migration()
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    rules = sa.Table(
        "rules", metadata,
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("validation_enabled", sa.Boolean(), nullable=False),
    )
    anomalies = sa.Table(
        "anomaly_records", metadata,
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("validation_deadline", sa.DateTime(), nullable=True),
    )
    submissions = sa.Table(
        "anomaly_validation_submissions", metadata,
        sa.Column("id", sa.String(36), primary_key=True),
    )
    metadata.create_all(engine)

    with engine.begin() as connection:
        connection.execute(rules.insert(), {"id": "rule-1", "validation_enabled": True})
        connection.execute(anomalies.insert(), [
            {"id": "active", "validation_deadline": datetime(2026, 8, 22, 10, 0)},
            {"id": "legacy", "validation_deadline": None},
        ])
        connection.execute(submissions.insert(), {"id": "submission-1"})
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()

        inspector = sa.inspect(connection)
        assert {"validation_method", "sql_validation_config"} <= {
            item["name"] for item in inspector.get_columns("rules")
        }
        assert {"validation_method_snapshot", "validation_config_snapshot"} <= {
            item["name"] for item in inspector.get_columns("anomaly_records")
        }
        assert "result_detail" in {
            item["name"] for item in inspector.get_columns("anomaly_validation_submissions")
        }
        assert connection.execute(sa.text(
            "SELECT validation_method FROM rules WHERE id='rule-1'"
        )).scalar_one() == "pseudo"
        assert connection.execute(sa.text(
            "SELECT validation_method_snapshot FROM anomaly_records WHERE id='active'"
        )).scalar_one() == "pseudo"
        assert connection.execute(sa.text(
            "SELECT validation_method_snapshot FROM anomaly_records WHERE id='legacy'"
        )).scalar_one() is None
    engine.dispose()


def test_anomaly_group_migration_adds_rule_config_group_tables_and_nullable_push_target():
    """Dropping the composite group identity or nullable group jobs must fail this test."""
    migration = load_anomaly_group_migration()
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    sa.Table("rules", metadata, sa.Column("id", sa.String(36), primary_key=True))
    sa.Table("rule_runs", metadata, sa.Column("id", sa.String(36), primary_key=True))
    anomalies = sa.Table(
        "anomaly_records", metadata, sa.Column("id", sa.String(36), primary_key=True),
    )
    sa.Table(
        "anomaly_push_jobs", metadata,
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("anomaly_id", sa.String(36), sa.ForeignKey(anomalies.c.id), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
    )
    metadata.create_all(engine)

    with engine.begin() as connection:
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        inspector = sa.inspect(connection)
        rule_columns = {column["name"]: column for column in inspector.get_columns("rules")}
        push_columns = {column["name"]: column for column in inspector.get_columns("anomaly_push_jobs")}
        group_pk = inspector.get_pk_constraint("anomaly_record_groups")["constrained_columns"]
        tables = set(inspector.get_table_names())

    assert {
        "group_broadcast_enabled", "group_webhook_encrypted", "group_mention_targets",
    } <= set(rule_columns)
    assert rule_columns["group_broadcast_enabled"]["nullable"] is False
    assert push_columns["anomaly_id"]["nullable"] is True
    assert group_pk == ["rule_id", "detected_at"]
    assert {"anomaly_record_group_members", "anomaly_group_broadcast_deliveries"} <= tables

    with engine.begin() as connection:
        migration.op = Operations(MigrationContext.configure(connection))
        migration.downgrade()
        inspector = sa.inspect(connection)
        assert not {
            "anomaly_record_groups", "anomaly_record_group_members",
            "anomaly_group_broadcast_deliveries",
        } & set(inspector.get_table_names())
        assert {
            "group_broadcast_enabled", "group_webhook_encrypted", "group_mention_targets",
        }.isdisjoint({column["name"] for column in inspector.get_columns("rules")})
        anomaly_id = next(
            column for column in inspector.get_columns("anomaly_push_jobs")
            if column["name"] == "anomaly_id"
        )
        assert anomaly_id["nullable"] is False
    engine.dispose()


def test_anomaly_group_json_default_and_nullable_push_target_compile_for_mysql_84():
    migration = load_anomaly_group_migration()
    dialect = mysql.dialect()
    dialect.server_version_info = (8, 4, 10)

    mention_column = migration._empty_list_column("group_mention_targets")
    mention_ddl = str(CreateColumn(mention_column).compile(dialect=dialect))
    output = io.StringIO()
    context = MigrationContext.configure(
        dialect=dialect,
        opts={"as_sql": True, "output_buffer": output},
    )
    Operations(context).alter_column(
        "anomaly_push_jobs", "anomaly_id",
        existing_type=sa.String(36), nullable=True,
    )

    assert "JSON NOT NULL DEFAULT ('[]')" in mention_ddl
    assert "DEFAULT '[]'" not in mention_ddl
    assert "MODIFY anomaly_id VARCHAR(36) NULL" in output.getvalue()


def test_anomaly_group_identity_keeps_microseconds_on_mysql_84():
    """Same-rule runs inside one second need distinct persisted composite keys."""
    migration = load_anomaly_group_migration()
    dialect = mysql.dialect()
    dialect.server_version_info = (8, 4, 10)

    assert "DATETIME(6)" in str(migration._precise_datetime().compile(dialect=dialect))
    for column in (
        RuleRun.__table__.c.started_at,
        AnomalyRecordGroup.__table__.c.detected_at,
        AnomalyGroupBroadcastDelivery.__table__.c.detected_at,
    ):
        assert "DATETIME(6)" in str(column.type.compile(dialect=dialect))


def test_plaintext_webhook_migration_decrypts_existing_rules_and_deliveries(monkeypatch):
    from app.security import CredentialCipher

    key = "y4R9V3fBMN_WBq6j7u5oA-rOQ1z3B1l1J1dQxQ8_s8Y="
    webhook = "https://open.feishu.cn/open-apis/bot/v2/hook/migrated-hook"
    encrypted = CredentialCipher(key).encrypt(webhook)
    migration = load_plaintext_webhook_migration()
    monkeypatch.setattr(migration, "get_settings", lambda: type("S", (), {
        "datasource_encryption_key": key,
    })())
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    rules = sa.Table(
        "rules", metadata,
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("group_webhook_encrypted", sa.Text(), nullable=True),
    )
    deliveries = sa.Table(
        "anomaly_group_broadcast_deliveries", metadata,
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("webhook_encrypted", sa.Text(), nullable=False),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(rules.insert(), {"id": "rule-1", "group_webhook_encrypted": encrypted})
        connection.execute(deliveries.insert(), {"id": "delivery-1", "webhook_encrypted": encrypted})
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        assert connection.execute(sa.text(
            "SELECT group_webhook_url FROM rules WHERE id='rule-1'"
        )).scalar_one() == webhook
        assert connection.execute(sa.text(
            "SELECT webhook_url FROM anomaly_group_broadcast_deliveries WHERE id='delivery-1'"
        )).scalar_one() == webhook
        columns = {column["name"] for column in sa.inspect(connection).get_columns("rules")}
        assert "group_webhook_encrypted" not in columns
        migration.downgrade()
        restored = connection.execute(sa.text(
            "SELECT group_webhook_encrypted FROM rules WHERE id='rule-1'"
        )).scalar_one()
        assert CredentialCipher(key).decrypt(restored) == webhook
    engine.dispose()


def test_plaintext_webhook_migration_aborts_on_wrong_encryption_key(monkeypatch):
    from cryptography.fernet import Fernet, InvalidToken
    from app.security import CredentialCipher

    original_key = Fernet.generate_key().decode("ascii")
    wrong_key = Fernet.generate_key().decode("ascii")
    encrypted = CredentialCipher(original_key).encrypt(
        "https://open.feishu.cn/open-apis/bot/v2/hook/protected-hook"
    )
    migration = load_plaintext_webhook_migration()
    monkeypatch.setattr(migration, "get_settings", lambda: type("S", (), {
        "datasource_encryption_key": wrong_key,
    })())
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    rules = sa.Table(
        "rules", metadata,
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("group_webhook_encrypted", sa.Text(), nullable=True),
    )
    sa.Table(
        "anomaly_group_broadcast_deliveries", metadata,
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("webhook_encrypted", sa.Text(), nullable=False),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(rules.insert(), {"id": "rule-1", "group_webhook_encrypted": encrypted})
        migration.op = Operations(MigrationContext.configure(connection))
        with pytest.raises(InvalidToken):
            migration.upgrade()
        rule_columns = {column["name"] for column in sa.inspect(connection).get_columns("rules")}
        delivery_columns = {
            column["name"]
            for column in sa.inspect(connection).get_columns("anomaly_group_broadcast_deliveries")
        }
        assert "group_webhook_url" not in rule_columns
        assert "webhook_url" not in delivery_columns
    engine.dispose()


def test_plaintext_webhook_migration_resumes_partially_applied_mysql_style_state(monkeypatch):
    from app.security import CredentialCipher

    key = "y4R9V3fBMN_WBq6j7u5oA-rOQ1z3B1l1J1dQxQ8_s8Y="
    rule_webhook = "https://open.feishu.cn/open-apis/bot/v2/hook/already-plain"
    delivery_webhook = "https://open.feishu.cn/open-apis/bot/v2/hook/resume-delivery"
    encrypted = CredentialCipher(key).encrypt(delivery_webhook)
    migration = load_plaintext_webhook_migration()
    monkeypatch.setattr(migration, "get_settings", lambda: type("S", (), {
        "datasource_encryption_key": key,
    })())
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    rules = sa.Table(
        "rules", metadata,
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("group_webhook_url", sa.Text(), nullable=True),
    )
    deliveries = sa.Table(
        "anomaly_group_broadcast_deliveries", metadata,
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("webhook_encrypted", sa.Text(), nullable=False),
        sa.Column("webhook_url", sa.Text(), nullable=True),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(rules.insert(), {"id": "rule-1", "group_webhook_url": rule_webhook})
        connection.execute(deliveries.insert(), {
            "id": "delivery-1", "webhook_encrypted": encrypted, "webhook_url": None,
        })
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        assert connection.execute(sa.text(
            "SELECT group_webhook_url FROM rules WHERE id='rule-1'"
        )).scalar_one() == rule_webhook
        assert connection.execute(sa.text(
            "SELECT webhook_url FROM anomaly_group_broadcast_deliveries WHERE id='delivery-1'"
        )).scalar_one() == delivery_webhook
        delivery_columns = {
            column["name"]: column
            for column in sa.inspect(connection).get_columns("anomaly_group_broadcast_deliveries")
        }
        assert "webhook_encrypted" not in delivery_columns
        assert delivery_columns["webhook_url"]["nullable"] is False
    engine.dispose()


def test_plaintext_webhook_migration_preserves_existing_target_and_is_idempotent(monkeypatch):
    from cryptography.fernet import Fernet

    key = Fernet.generate_key().decode("ascii")
    webhook = "https://open.feishu.cn/open-apis/bot/v2/hook/authoritative-plain"
    migration = load_plaintext_webhook_migration()
    monkeypatch.setattr(migration, "get_settings", lambda: type("S", (), {
        "datasource_encryption_key": key,
    })())
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    rules = sa.Table(
        "rules", metadata,
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("group_webhook_encrypted", sa.Text(), nullable=True),
        sa.Column("group_webhook_url", sa.Text(), nullable=True),
    )
    deliveries = sa.Table(
        "anomaly_group_broadcast_deliveries", metadata,
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("webhook_encrypted", sa.Text(), nullable=False),
        sa.Column("webhook_url", sa.Text(), nullable=True),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(rules.insert(), {
            "id": "rule-1", "group_webhook_encrypted": "invalid-ciphertext",
            "group_webhook_url": webhook,
        })
        connection.execute(deliveries.insert(), {
            "id": "delivery-1", "webhook_encrypted": "invalid-ciphertext",
            "webhook_url": webhook,
        })
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        migration.upgrade()
        assert connection.execute(sa.text(
            "SELECT group_webhook_url FROM rules WHERE id='rule-1'"
        )).scalar_one() == webhook
        assert connection.execute(sa.text(
            "SELECT webhook_url FROM anomaly_group_broadcast_deliveries WHERE id='delivery-1'"
        )).scalar_one() == webhook
    engine.dispose()


def test_plaintext_webhook_migration_rejects_missing_source_and_target_columns(monkeypatch):
    key = "y4R9V3fBMN_WBq6j7u5oA-rOQ1z3B1l1J1dQxQ8_s8Y="
    migration = load_plaintext_webhook_migration()
    monkeypatch.setattr(migration, "get_settings", lambda: type("S", (), {
        "datasource_encryption_key": key,
    })())
    engine = sa.create_engine("sqlite+pysqlite:///:memory:")
    metadata = sa.MetaData()
    sa.Table("rules", metadata, sa.Column("id", sa.String(36), primary_key=True))
    sa.Table(
        "anomaly_group_broadcast_deliveries", metadata,
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("webhook_url", sa.Text(), nullable=False),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        migration.op = Operations(MigrationContext.configure(connection))
        with pytest.raises(RuntimeError, match="rules.*webhook"):
            migration.upgrade()
    engine.dispose()


def test_plaintext_webhook_migration_uses_mysql_alter_column_signature(monkeypatch):
    key = "y4R9V3fBMN_WBq6j7u5oA-rOQ1z3B1l1J1dQxQ8_s8Y="
    migration = load_plaintext_webhook_migration()
    monkeypatch.setattr(migration, "get_settings", lambda: type("S", (), {
        "datasource_encryption_key": key,
    })())

    class Result:
        def scalar_one(self):
            return 0

    class Bind:
        dialect = type("Dialect", (), {"name": "mysql"})()

        def execute(self, _statement, _parameters=None):
            return Result()

    class Inspector:
        def get_columns(self, table):
            name = "group_webhook_url" if table == "rules" else "webhook_url"
            return [{"name": "id", "nullable": False}, {"name": name, "nullable": True}]

    class OperationsRecorder:
        def __init__(self):
            self.bind = Bind()
            self.altered = []

        def get_bind(self):
            return self.bind

        def alter_column(self, table_name, column_name, **kwargs):
            self.altered.append((table_name, column_name, kwargs))

        def add_column(self, *_args, **_kwargs):
            raise AssertionError("already-migrated columns must not be re-added")

        def drop_column(self, *_args, **_kwargs):
            raise AssertionError("missing legacy columns must not be dropped")

    operations = OperationsRecorder()
    migration.op = operations
    monkeypatch.setattr(migration.sa, "inspect", lambda _bind: Inspector())

    migration.upgrade()

    assert len(operations.altered) == 1
    table_name, column_name, kwargs = operations.altered[0]
    assert (table_name, column_name) == (
        "anomaly_group_broadcast_deliveries", "webhook_url",
    )
    assert isinstance(kwargs["existing_type"], sa.Text)
    assert kwargs["nullable"] is False
