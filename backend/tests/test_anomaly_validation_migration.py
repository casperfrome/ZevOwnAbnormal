from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy.dialects import mysql, sqlite
from sqlalchemy.schema import CreateColumn

from app.database import Base
from app.models import Rule


MIGRATION_PATH = (
    Path(__file__).resolve().parents[1]
    / "alembic"
    / "versions"
    / "20260822_0002_anomaly_validation.py"
)
INITIAL_MIGRATION_PATH = MIGRATION_PATH.with_name("20260809_0001_initial.py")
INDEX_MIGRATION_PATH = MIGRATION_PATH.with_name("20260822_0004_validation_query_indexes.py")
RETRY_MIGRATION_PATH = MIGRATION_PATH.with_name("20260822_0005_validation_delivery_retry_schedule.py")


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
