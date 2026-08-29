"""add account profiles and revocable sessions

Revision ID: 20260829_0014
Revises: 20260828_0013
"""

import sqlalchemy as sa
from alembic import op


revision = "20260829_0014"
down_revision = "20260828_0013"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("users") as batch:
        batch.alter_column(
            "username", new_column_name="login_name",
            existing_type=sa.String(length=100), existing_nullable=False,
        )
        batch.add_column(sa.Column("display_name", sa.String(length=100), nullable=False, server_default=""))
        batch.add_column(sa.Column("job_title", sa.String(length=100), nullable=False, server_default=""))
        batch.add_column(sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()))
        batch.add_column(sa.Column("session_version", sa.Integer(), nullable=False, server_default="0"))
    op.execute(sa.text("UPDATE users SET display_name = login_name WHERE display_name = ''"))


def downgrade():
    with op.batch_alter_table("users") as batch:
        batch.drop_column("session_version")
        batch.drop_column("is_active")
        batch.drop_column("job_title")
        batch.drop_column("display_name")
        batch.alter_column(
            "login_name", new_column_name="username",
            existing_type=sa.String(length=100), existing_nullable=False,
        )
