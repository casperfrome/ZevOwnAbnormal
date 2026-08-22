"""add persistent validation delivery retry scheduling

Revision ID: 20260822_0005
Revises: 20260822_0004
"""

import sqlalchemy as sa
from alembic import op


revision = "20260822_0005"
down_revision = "20260822_0004"
branch_labels = None
depends_on = None


TABLE_NAME = "anomaly_validation_requests"
ELIGIBLE_INDEX = "ix_validation_requests_eligible_retry"


def _column_names(bind) -> set[str]:
    return {item["name"] for item in sa.inspect(bind).get_columns(TABLE_NAME)}


def _index_names(bind) -> set[str]:
    return {item["name"] for item in sa.inspect(bind).get_indexes(TABLE_NAME)}


def _next_attempt_column():
    return sa.Column("next_attempt_at", sa.DateTime(), nullable=True)


def _consecutive_failures_column():
    return sa.Column(
        "consecutive_failures",
        sa.Integer(),
        nullable=False,
        server_default=sa.text("0"),
    )


def upgrade():
    bind = op.get_bind()
    if TABLE_NAME not in set(sa.inspect(bind).get_table_names()):
        return
    columns = _column_names(bind)
    if "next_attempt_at" not in columns:
        op.add_column(TABLE_NAME, _next_attempt_column())
    if "consecutive_failures" not in columns:
        op.add_column(TABLE_NAME, _consecutive_failures_column())
    if ELIGIBLE_INDEX not in _index_names(bind):
        op.create_index(
            ELIGIBLE_INDEX,
            TABLE_NAME,
            ["delivery_status", "next_attempt_at", "updated_at"],
            unique=False,
        )


def downgrade():
    bind = op.get_bind()
    if TABLE_NAME not in set(sa.inspect(bind).get_table_names()):
        return
    if ELIGIBLE_INDEX in _index_names(bind):
        op.drop_index(ELIGIBLE_INDEX, table_name=TABLE_NAME)
    columns = _column_names(bind)
    if "consecutive_failures" in columns:
        op.drop_column(TABLE_NAME, "consecutive_failures")
    if "next_attempt_at" in columns:
        op.drop_column(TABLE_NAME, "next_attempt_at")
