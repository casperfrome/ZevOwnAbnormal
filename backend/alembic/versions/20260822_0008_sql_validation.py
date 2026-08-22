"""add SQL validation method and anomaly snapshots

Revision ID: 20260822_0008
Revises: 20260822_0007
"""

import sqlalchemy as sa
from alembic import op


revision = "20260822_0008"
down_revision = "20260822_0007"
branch_labels = None
depends_on = None


def _columns(bind, table_name: str) -> set[str]:
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return set()
    return {column["name"] for column in inspector.get_columns(table_name)}


def _empty_json_column(name: str) -> sa.Column:
    return sa.Column(
        name,
        sa.JSON(),
        nullable=False,
        server_default=sa.text("('{}')"),
    )


def upgrade():
    bind = op.get_bind()
    rule_columns = _columns(bind, "rules")
    if "validation_method" not in rule_columns:
        op.add_column(
            "rules",
            sa.Column(
                "validation_method",
                sa.String(length=20),
                nullable=False,
                server_default="pseudo",
            ),
        )
    if "sql_validation_config" not in rule_columns:
        op.add_column("rules", sa.Column("sql_validation_config", sa.JSON(), nullable=True))

    anomaly_columns = _columns(bind, "anomaly_records")
    if "validation_method_snapshot" not in anomaly_columns:
        op.add_column(
            "anomaly_records",
            sa.Column("validation_method_snapshot", sa.String(length=20), nullable=True),
        )
    if "validation_config_snapshot" not in anomaly_columns:
        op.add_column("anomaly_records", _empty_json_column("validation_config_snapshot"))
    bind.execute(sa.text(
        "UPDATE anomaly_records "
        "SET validation_method_snapshot = 'pseudo' "
        "WHERE validation_deadline IS NOT NULL "
        "AND validation_method_snapshot IS NULL"
    ))

    submission_columns = _columns(bind, "anomaly_validation_submissions")
    if submission_columns and "result_detail" not in submission_columns:
        op.add_column(
            "anomaly_validation_submissions",
            _empty_json_column("result_detail"),
        )


def downgrade():
    bind = op.get_bind()
    for table_name, column_name in (
        ("anomaly_validation_submissions", "result_detail"),
        ("anomaly_records", "validation_config_snapshot"),
        ("anomaly_records", "validation_method_snapshot"),
        ("rules", "sql_validation_config"),
        ("rules", "validation_method"),
    ):
        if column_name in _columns(bind, table_name):
            op.drop_column(table_name, column_name)
