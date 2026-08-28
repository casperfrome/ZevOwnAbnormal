"""Independent second-precision deadlines and three severity levels.

Revision ID: 20260828_0013
Revises: 20260828_0012
"""
import sqlalchemy as sa
from sqlalchemy.dialects import mysql
from alembic import op

revision = "20260828_0013"
down_revision = "20260828_0012"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    columns = {
        "rules": [sa.Column("deadline_seconds", sa.Integer(), nullable=False, server_default="86400")],
        "anomaly_records": [
            sa.Column("deadline_seconds_snapshot", sa.Integer(), nullable=True),
            sa.Column("first_delivered_at", sa.DateTime().with_variant(mysql.DATETIME(fsp=6), "mysql"), nullable=True),
        ],
        "anomaly_record_group_members": [sa.Column("timeout_notified_at", sa.DateTime(), nullable=True)],
        "anomaly_group_broadcast_deliveries": [sa.Column("round_index", sa.Integer(), nullable=False, server_default="0")],
    }
    added = set()
    for table, additions in columns.items():
        existing = {column["name"] for column in sa.inspect(bind).get_columns(table)}
        for column in additions:
            if column.name not in existing:
                op.add_column(table, column)
                added.add((table, column.name))
    if ("rules", "deadline_seconds") in added:
        bind.execute(sa.text("UPDATE rules SET deadline_seconds = validation_timeout_minutes * 60"))
    for table in ("rules", "anomaly_records"):
        bind.execute(sa.text(f"UPDATE {table} SET severity = 'high' WHERE severity = 'critical'"))
    if bind.dialect.name == "mysql":
        op.alter_column("anomaly_records", "validation_deadline", existing_type=sa.DateTime(),
                        type_=mysql.DATETIME(fsp=6), existing_nullable=True)
    if ("anomaly_record_group_members", "timeout_notified_at") in added:
        bind.execute(sa.text("""UPDATE anomaly_record_group_members SET timeout_notified_at = (
            SELECT g.timeout_processed_at FROM anomaly_record_groups g
            WHERE g.rule_id = anomaly_record_group_members.rule_id
              AND g.detected_at = anomaly_record_group_members.detected_at
        ) WHERE EXISTS (SELECT 1 FROM anomaly_record_groups g
            WHERE g.rule_id = anomaly_record_group_members.rule_id
              AND g.detected_at = anomaly_record_group_members.detected_at
              AND g.timeout_processed_at IS NOT NULL)"""))
    table = "anomaly_group_broadcast_deliveries"
    names = {item["name"] for item in sa.inspect(bind).get_unique_constraints(table)}
    with op.batch_alter_table(table) as batch:
        # MySQL needs the replacement FK-supporting index before the old index is dropped.
        if "uq_anomaly_group_delivery_round_part" not in names:
            batch.create_unique_constraint("uq_anomaly_group_delivery_round_part",
                ["rule_id", "detected_at", "broadcast_kind", "round_index", "part_index"])
        if "uq_anomaly_group_delivery_kind_part" in names:
            batch.drop_constraint("uq_anomaly_group_delivery_kind_part", type_="unique")


def downgrade():
    raise RuntimeError("严重程度合并和秒级时限无法无损回退；请保留迁移，或从升级前备份恢复")
