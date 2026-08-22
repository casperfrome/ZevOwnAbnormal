"""initial platform schema

This revision owns a frozen copy of the original schema. Later application
models must be introduced only by later migrations.
"""

import sqlalchemy as sa
from alembic import op

revision = "20260809_0001"
down_revision = None
branch_labels = None
depends_on = None


initial_metadata = sa.MetaData()


sa.Table(
    "users",
    initial_metadata,
    sa.Column("id", sa.String(length=36), primary_key=True),
    sa.Column("username", sa.String(length=100), nullable=False, unique=True),
    sa.Column("password_hash", sa.String(length=255), nullable=False),
    sa.Column("is_superuser", sa.Boolean(), nullable=False),
    sa.Column("created_at", sa.DateTime(), nullable=False),
    sa.Column("updated_at", sa.DateTime(), nullable=False),
)

sa.Table(
    "datasources",
    initial_metadata,
    sa.Column("id", sa.String(length=36), primary_key=True),
    sa.Column("name", sa.String(length=150), nullable=False, unique=True),
    sa.Column("type", sa.String(length=30), nullable=False),
    sa.Column("host", sa.String(length=255), nullable=False),
    sa.Column("port", sa.Integer(), nullable=False),
    sa.Column("database", sa.String(length=150), nullable=False),
    sa.Column("username", sa.String(length=150), nullable=False),
    sa.Column("password_encrypted", sa.Text(), nullable=False),
    sa.Column("ssl", sa.Boolean(), nullable=False),
    sa.Column("description", sa.Text(), nullable=False),
    sa.Column("status", sa.String(length=30), nullable=False),
    sa.Column("last_checked", sa.DateTime(), nullable=True),
    sa.Column("error_message", sa.Text(), nullable=True),
    sa.Column("created_at", sa.DateTime(), nullable=False),
    sa.Column("updated_at", sa.DateTime(), nullable=False),
)

sa.Table(
    "datasets",
    initial_metadata,
    sa.Column("id", sa.String(length=36), primary_key=True),
    sa.Column("name", sa.String(length=150), nullable=False, unique=True),
    sa.Column("description", sa.Text(), nullable=False),
    sa.Column("datasource_id", sa.String(length=36), sa.ForeignKey("datasources.id"), nullable=False),
    sa.Column("sql", sa.Text(), nullable=False),
    sa.Column("fields", sa.JSON(), nullable=False),
    sa.Column("row_count", sa.Integer(), nullable=False),
    sa.Column("created_at", sa.DateTime(), nullable=False),
    sa.Column("updated_at", sa.DateTime(), nullable=False),
)

sa.Table(
    "rules",
    initial_metadata,
    sa.Column("id", sa.String(length=36), primary_key=True),
    sa.Column("name", sa.String(length=150), nullable=False, unique=True),
    sa.Column("description", sa.Text(), nullable=False),
    sa.Column("dataset_id", sa.String(length=36), sa.ForeignKey("datasets.id"), nullable=False),
    sa.Column("severity", sa.String(length=20), nullable=False),
    sa.Column("logic", sa.String(length=3), nullable=False),
    sa.Column("conditions", sa.JSON(), nullable=False),
    sa.Column("anomaly_key_fields", sa.JSON(), nullable=False),
    sa.Column("schedule", sa.JSON(), nullable=False),
    sa.Column("notification_targets", sa.JSON(), nullable=False),
    sa.Column("enabled", sa.Boolean(), nullable=False),
    sa.Column("sync_status", sa.String(length=30), nullable=False),
    sa.Column("sync_error", sa.Text(), nullable=True),
    sa.Column("ds_workflow_code", sa.String(length=50), nullable=True),
    sa.Column("ds_schedule_id", sa.Integer(), nullable=True),
    sa.Column("deleted_at", sa.DateTime(), nullable=True),
    sa.Column("created_at", sa.DateTime(), nullable=False),
    sa.Column("updated_at", sa.DateTime(), nullable=False),
)

sa.Table(
    "rule_runs",
    initial_metadata,
    sa.Column("id", sa.String(length=36), primary_key=True),
    sa.Column("rule_id", sa.String(length=36), sa.ForeignKey("rules.id"), nullable=False),
    sa.Column("trigger_source", sa.String(length=30), nullable=False),
    sa.Column("status", sa.String(length=30), nullable=False),
    sa.Column("scanned_rows", sa.Integer(), nullable=False),
    sa.Column("matched_rows", sa.Integer(), nullable=False),
    sa.Column("new_anomalies", sa.Integer(), nullable=False),
    sa.Column("error_message", sa.Text(), nullable=True),
    sa.Column("started_at", sa.DateTime(), nullable=False),
    sa.Column("finished_at", sa.DateTime(), nullable=True),
)

sa.Table(
    "anomaly_records",
    initial_metadata,
    sa.Column("id", sa.String(length=36), primary_key=True),
    sa.Column("rule_id", sa.String(length=36), sa.ForeignKey("rules.id"), nullable=False),
    sa.Column("rule_name", sa.String(length=150), nullable=False),
    sa.Column("dataset_name", sa.String(length=150), nullable=False),
    sa.Column("severity", sa.String(length=20), nullable=False),
    sa.Column("status", sa.String(length=20), nullable=False),
    sa.Column("fingerprint", sa.String(length=64), nullable=False),
    sa.Column("active_fingerprint", sa.String(length=64), nullable=True),
    sa.Column("business_key", sa.JSON(), nullable=False),
    sa.Column("row_details", sa.JSON(), nullable=False),
    sa.Column("matched_conditions", sa.JSON(), nullable=False),
    sa.Column("hit_count", sa.Integer(), nullable=False),
    sa.Column("first_seen_at", sa.DateTime(), nullable=False),
    sa.Column("last_seen_at", sa.DateTime(), nullable=False),
    sa.Column("resolved_at", sa.DateTime(), nullable=True),
    sa.Column("assignee", sa.String(length=100), nullable=True),
    sa.UniqueConstraint("rule_id", "active_fingerprint", name="uq_active_anomaly"),
)

sa.Table(
    "anomaly_events",
    initial_metadata,
    sa.Column("id", sa.String(length=36), primary_key=True),
    sa.Column("anomaly_id", sa.String(length=36), sa.ForeignKey("anomaly_records.id"), nullable=False),
    sa.Column("event_type", sa.String(length=30), nullable=False),
    sa.Column("description", sa.Text(), nullable=False),
    sa.Column("created_at", sa.DateTime(), nullable=False),
)

sa.Table(
    "notification_deliveries",
    initial_metadata,
    sa.Column("id", sa.String(length=36), primary_key=True),
    sa.Column("anomaly_id", sa.String(length=36), sa.ForeignKey("anomaly_records.id"), nullable=False),
    sa.Column("receive_id_type", sa.String(length=20), nullable=False),
    sa.Column("recipient", sa.String(length=255), nullable=False),
    sa.Column("status", sa.String(length=20), nullable=False),
    sa.Column("attempts", sa.Integer(), nullable=False),
    sa.Column("message_id", sa.String(length=150), nullable=True),
    sa.Column("last_error", sa.Text(), nullable=True),
    sa.Column("created_at", sa.DateTime(), nullable=False),
    sa.Column("updated_at", sa.DateTime(), nullable=False),
    sa.UniqueConstraint(
        "anomaly_id", "receive_id_type", "recipient", name="uq_delivery_target"
    ),
)


def upgrade():
    initial_metadata.create_all(bind=op.get_bind())


def downgrade():
    initial_metadata.drop_all(bind=op.get_bind())
