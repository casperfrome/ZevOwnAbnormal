"""store group broadcast webhooks as plaintext

Revision ID: 20260823_0010
Revises: 20260823_0009
"""

from alembic import op
import sqlalchemy as sa

from app.config import get_settings
from app.security import CredentialCipher


revision = "20260823_0010"
down_revision = "20260823_0009"
branch_labels = None
depends_on = None


def _replace_columns(*, source: str, target: str, decrypt: bool) -> None:
    bind = op.get_bind()
    cipher = CredentialCipher(get_settings().datasource_encryption_key)
    targets = (
        ("rules", "id", "group_" + source, "group_" + target, True),
        ("anomaly_group_broadcast_deliveries", "id", source, target, False),
    )
    converted_by_table = []
    for table, key_column, source_column, target_column, nullable in targets:
        rows = bind.execute(sa.text(
            f"SELECT {key_column}, {source_column} FROM {table} "
            f"WHERE {source_column} IS NOT NULL"
        )).all()
        converted_rows = [
            (row_id, cipher.decrypt(value) if decrypt else cipher.encrypt(value))
            for row_id, value in rows
        ]
        converted_by_table.append(
            (table, key_column, source_column, target_column, nullable, converted_rows)
        )

    for table, key_column, source_column, target_column, nullable, rows in converted_by_table:
        op.add_column(table, sa.Column(target_column, sa.Text(), nullable=True))
        for row_id, converted in rows:
            bind.execute(
                sa.text(
                    f"UPDATE {table} SET {target_column} = :value "
                    f"WHERE {key_column} = :row_id"
                ),
                {"value": converted, "row_id": row_id},
            )
        if bind.dialect.name == "sqlite":
            with op.batch_alter_table(table) as batch_op:
                if not nullable:
                    batch_op.alter_column(target_column, existing_type=sa.Text(), nullable=False)
                batch_op.drop_column(source_column)
        else:
            if not nullable:
                op.alter_column(target_column, existing_type=sa.Text(), nullable=False)
            op.drop_column(table, source_column)


def upgrade():
    _replace_columns(
        source="webhook_encrypted",
        target="webhook_url",
        decrypt=True,
    )


def downgrade():
    _replace_columns(
        source="webhook_url",
        target="webhook_encrypted",
        decrypt=False,
    )
