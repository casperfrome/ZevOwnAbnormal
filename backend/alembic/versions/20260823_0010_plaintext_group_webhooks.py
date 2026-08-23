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
    migration_plans = []
    for table, key_column, source_column, target_column, nullable in targets:
        columns = {
            column["name"]: column
            for column in sa.inspect(bind).get_columns(table)
        }
        source_exists = source_column in columns
        target_exists = target_column in columns
        if not source_exists and not target_exists:
            raise RuntimeError(
                f"{table} 缺少 webhook 源字段 {source_column} 和目标字段 {target_column}"
            )

        target_missing = f"{target_column} IS NULL" if target_exists else "1 = 1"
        rows = []
        if source_exists:
            rows = bind.execute(sa.text(
                f"SELECT {key_column}, {source_column} FROM {table} "
                f"WHERE {source_column} IS NOT NULL AND {target_missing}"
            )).all()
        converted_rows = [
            (row_id, cipher.decrypt(value) if decrypt else cipher.encrypt(value))
            for row_id, value in rows
        ]

        if not nullable:
            missing_required = bind.execute(sa.text(
                f"SELECT COUNT(*) FROM {table} WHERE {target_missing}"
                + (f" AND {source_column} IS NULL" if source_exists else "")
            )).scalar_one()
            if missing_required:
                raise RuntimeError(
                    f"{table}.{target_column} 有 {missing_required} 条记录无法从 {source_column} 补齐"
                )

        migration_plans.append(
            {
                "table": table,
                "key_column": key_column,
                "source_column": source_column,
                "target_column": target_column,
                "nullable": nullable,
                "source_exists": source_exists,
                "target_exists": target_exists,
                "target_nullable": columns[target_column]["nullable"] if target_exists else True,
                "rows": converted_rows,
            }
        )

    for plan in migration_plans:
        table = plan["table"]
        target_column = plan["target_column"]
        if not plan["target_exists"]:
            op.add_column(table, sa.Column(target_column, sa.Text(), nullable=True))
        for row_id, converted in plan["rows"]:
            bind.execute(
                sa.text(
                    f"UPDATE {table} SET {target_column} = :value "
                    f"WHERE {plan['key_column']} = :row_id"
                ),
                {"value": converted, "row_id": row_id},
            )

        needs_not_null = not plan["nullable"] and plan["target_nullable"]
        if bind.dialect.name == "sqlite":
            if needs_not_null or plan["source_exists"]:
                with op.batch_alter_table(table) as batch_op:
                    if needs_not_null:
                        batch_op.alter_column(
                            target_column, existing_type=sa.Text(), nullable=False,
                        )
                    if plan["source_exists"]:
                        batch_op.drop_column(plan["source_column"])
        else:
            if needs_not_null:
                op.alter_column(
                    table, target_column, existing_type=sa.Text(), nullable=False,
                )
            if plan["source_exists"]:
                op.drop_column(table, plan["source_column"])


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
