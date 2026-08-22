"""add anomaly validation persistence

Revision ID: 20260822_0002
Revises: 20260809_0001
"""

import sqlalchemy as sa
from alembic import op


revision = "20260822_0002"
down_revision = "20260809_0001"
branch_labels = None
depends_on = None


def _columns(bind, table_name):
    return {column["name"] for column in sa.inspect(bind).get_columns(table_name)}


def upgrade():
    bind = op.get_bind()
    rule_columns = _columns(bind, "rules")
    if "validation_enabled" not in rule_columns:
        op.add_column("rules", sa.Column("validation_enabled", sa.Boolean(), nullable=False, server_default=sa.text("0")))
    if "validation_targets" not in rule_columns:
        op.add_column("rules", sa.Column("validation_targets", sa.JSON(), nullable=False, server_default=sa.text("'[]'")))
    if "validation_timeout_minutes" not in rule_columns:
        op.add_column("rules", sa.Column("validation_timeout_minutes", sa.Integer(), nullable=False, server_default=sa.text("1440")))

    anomaly_columns = _columns(bind, "anomaly_records")
    if "description" not in anomaly_columns:
        op.add_column("anomaly_records", sa.Column("description", sa.Text(), nullable=False, server_default=""))
    if "validation_deadline" not in anomaly_columns:
        op.add_column("anomaly_records", sa.Column("validation_deadline", sa.DateTime(), nullable=True))
    if "timed_out_at" not in anomaly_columns:
        op.add_column("anomaly_records", sa.Column("timed_out_at", sa.DateTime(), nullable=True))
    if "resolution_source" not in anomaly_columns:
        op.add_column("anomaly_records", sa.Column("resolution_source", sa.String(length=30), nullable=True))
    if "resolved_by_user_id" not in anomaly_columns:
        op.add_column("anomaly_records", sa.Column("resolved_by_user_id", sa.String(length=255), nullable=True))

    inspector = sa.inspect(bind)
    if "anomaly_validation_requests" not in inspector.get_table_names():
        op.create_table(
            "anomaly_validation_requests",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("anomaly_id", sa.String(length=36), nullable=False),
            sa.Column("recipient_user_id", sa.String(length=255), nullable=False),
            sa.Column("delivery_status", sa.String(length=20), nullable=False, server_default="pending"),
            sa.Column("delivery_attempts", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("message_id", sa.String(length=150), nullable=True),
            sa.Column("last_error", sa.Text(), nullable=True),
            sa.Column("delivered_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["anomaly_id"], ["anomaly_records.id"]),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("anomaly_id", "recipient_user_id", name="uq_validation_request_recipient"),
        )
    inspector = sa.inspect(bind)
    if "anomaly_validation_submissions" not in inspector.get_table_names():
        op.create_table(
            "anomaly_validation_submissions",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("anomaly_id", sa.String(length=36), nullable=False),
            sa.Column("request_id", sa.String(length=36), nullable=False),
            sa.Column("submitted_by_user_id", sa.String(length=255), nullable=False),
            sa.Column("submitted_text", sa.Text(), nullable=False),
            sa.Column("validator_type", sa.String(length=30), nullable=False, server_default="pseudo"),
            sa.Column("result", sa.String(length=30), nullable=False, server_default="passed"),
            sa.Column("submitted_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["anomaly_id"], ["anomaly_records.id"]),
            sa.ForeignKeyConstraint(["request_id"], ["anomaly_validation_requests.id"]),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("anomaly_id", name="uq_validation_submission_anomaly"),
        )


def downgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "anomaly_validation_submissions" in inspector.get_table_names():
        op.drop_table("anomaly_validation_submissions")
    if "anomaly_validation_requests" in inspector.get_table_names():
        op.drop_table("anomaly_validation_requests")
    for table_name, column_name in (
        ("anomaly_records", "resolved_by_user_id"),
        ("anomaly_records", "resolution_source"),
        ("anomaly_records", "timed_out_at"),
        ("anomaly_records", "validation_deadline"),
        ("anomaly_records", "description"),
        ("rules", "validation_timeout_minutes"),
        ("rules", "validation_targets"),
        ("rules", "validation_enabled"),
    ):
        if column_name in _columns(bind, table_name):
            op.drop_column(table_name, column_name)
