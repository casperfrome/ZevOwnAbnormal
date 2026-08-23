"""add custom message templates to rules

Revision ID: 20260823_0011
Revises: 20260823_0010
"""

import sqlalchemy as sa
from alembic import op


revision = "20260823_0011"
down_revision = "20260823_0010"
branch_labels = None
depends_on = None


def _rule_columns() -> set[str]:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "rules" not in inspector.get_table_names():
        return set()
    return {column["name"] for column in inspector.get_columns("rules")}


def upgrade() -> None:
    columns = _rule_columns()
    if "private_message_template" not in columns:
        op.add_column(
            "rules", sa.Column("private_message_template", sa.Text(), nullable=True),
        )
    if "group_message_template" not in columns:
        op.add_column(
            "rules", sa.Column("group_message_template", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    columns = _rule_columns()
    if "group_message_template" in columns:
        op.drop_column("rules", "group_message_template")
    if "private_message_template" in columns:
        op.drop_column("rules", "private_message_template")
