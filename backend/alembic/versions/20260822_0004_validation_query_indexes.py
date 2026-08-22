"""add anomaly validation query indexes

Revision ID: 20260822_0004
Revises: 20260822_0003
"""

import sqlalchemy as sa
from alembic import op


revision = "20260822_0004"
down_revision = "20260822_0003"
branch_labels = None
depends_on = None


INDEXES = (
    (
        "ix_anomaly_records_status_deadline",
        "anomaly_records",
        ["status", "validation_deadline"],
    ),
    (
        "ix_anomaly_records_first_seen_id",
        "anomaly_records",
        ["first_seen_at", "id"],
    ),
    (
        "ix_validation_requests_delivery_status_updated",
        "anomaly_validation_requests",
        ["delivery_status", "updated_at"],
    ),
)


def _index_names(bind, table_name: str) -> set[str]:
    return {item["name"] for item in sa.inspect(bind).get_indexes(table_name)}


def upgrade():
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    for index_name, table_name, columns in INDEXES:
        if table_name in tables and index_name not in _index_names(bind, table_name):
            op.create_index(index_name, table_name, columns, unique=False)


def downgrade():
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    for index_name, table_name, _columns in reversed(INDEXES):
        if table_name in tables and index_name in _index_names(bind, table_name):
            op.drop_index(index_name, table_name=table_name)
