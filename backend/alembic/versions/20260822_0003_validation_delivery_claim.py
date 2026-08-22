"""add validation delivery claim timestamp

Revision ID: 20260822_0003
Revises: 20260822_0002
"""

import sqlalchemy as sa
from alembic import op


revision = "20260822_0003"
down_revision = "20260822_0002"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("anomaly_validation_requests")}
    if "send_started_at" not in columns:
        op.add_column(
            "anomaly_validation_requests",
            sa.Column("send_started_at", sa.DateTime(), nullable=True),
        )


def downgrade():
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("anomaly_validation_requests")}
    if "send_started_at" in columns:
        op.drop_column("anomaly_validation_requests", "send_started_at")
