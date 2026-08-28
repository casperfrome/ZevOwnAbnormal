"""add kafka to dolphinscheduler anomaly push pipeline

Revision ID: 20260822_0006
Revises: 20260822_0005
"""

from datetime import datetime, timezone as utc_timezone

import sqlalchemy as sa
from alembic import op


revision = "20260822_0006"
down_revision = "20260822_0005"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    if "anomaly_push_pipeline_state" not in tables:
        op.create_table(
            "anomaly_push_pipeline_state",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("generation", sa.Integer(), nullable=False, server_default=sa.text("1")),
            sa.Column("abort_in_progress", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
        )
        op.bulk_insert(
            sa.table(
                "anomaly_push_pipeline_state",
                sa.column("id", sa.Integer()),
                sa.column("generation", sa.Integer()),
                sa.column("abort_in_progress", sa.Boolean()),
                sa.column("updated_at", sa.DateTime()),
            ),
            [{"id": 1, "generation": 1, "abort_in_progress": False,
              "updated_at": datetime.now(utc_timezone.utc).replace(tzinfo=None)}],
        )
    if "anomaly_push_jobs" not in tables:
        op.create_table(
            "anomaly_push_jobs",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("anomaly_id", sa.String(36), sa.ForeignKey("anomaly_records.id"), nullable=False),
            sa.Column("kind", sa.String(20), nullable=False),
            sa.Column("delivery_id", sa.String(36), nullable=False),
            sa.Column("generation", sa.Integer(), nullable=False),
            sa.Column("status", sa.String(30), nullable=False, server_default="pending_publish"),
            sa.Column("cancel_requested", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("publish_attempts", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("dispatch_attempts", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("kafka_partition", sa.Integer(), nullable=True),
            sa.Column("kafka_offset", sa.Integer(), nullable=True),
            sa.Column("next_attempt_at", sa.DateTime(), nullable=True),
            sa.Column("last_error", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.UniqueConstraint("kind", "delivery_id", name="uq_anomaly_push_job_delivery"),
        )
        op.create_index("ix_anomaly_push_jobs_publish", "anomaly_push_jobs", ["status", "created_at"])
        op.create_index(
            "ix_anomaly_push_jobs_generation_status", "anomaly_push_jobs", ["generation", "status"],
        )


def downgrade():
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "anomaly_push_jobs" in tables:
        op.drop_table("anomaly_push_jobs")
    if "anomaly_push_pipeline_state" in tables:
        op.drop_table("anomaly_push_pipeline_state")
