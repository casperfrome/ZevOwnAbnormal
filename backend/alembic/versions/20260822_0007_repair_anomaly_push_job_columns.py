"""repair missing anomaly push job columns

Revision ID: 20260822_0007
Revises: 20260822_0006
"""

import sqlalchemy as sa
from alembic import op


revision = "20260822_0007"
down_revision = "20260822_0006"
branch_labels = None
depends_on = None


TABLE_NAME = "anomaly_push_jobs"


def _column_names(bind) -> set[str]:
    return {item["name"] for item in sa.inspect(bind).get_columns(TABLE_NAME)}


def upgrade():
    bind = op.get_bind()
    if TABLE_NAME not in set(sa.inspect(bind).get_table_names()):
        return

    columns = _column_names(bind)
    if "cancel_requested" not in columns:
        op.add_column(
            TABLE_NAME,
            sa.Column(
                "cancel_requested",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )
    if "next_attempt_at" not in columns:
        op.add_column(
            TABLE_NAME,
            sa.Column("next_attempt_at", sa.DateTime(), nullable=True),
        )


def downgrade():
    # This revision repairs drift from the schema already declared by 0006.
    # Removing either column would make a downgraded database invalid at 0006.
    pass
