"""Repeat detections, split broadcasts and persisted SQL validation results.

Revision ID: 20260828_0012
Revises: 20260823_0011
"""

import sqlalchemy as sa
from alembic import op

revision = "20260828_0012"
down_revision = "20260823_0011"
branch_labels = None
depends_on = None


def _columns():
    return {
        "rules": [
            sa.Column("repeat_push_enabled", sa.Boolean(), nullable=False, server_default=sa.text("0")),
            sa.Column("timeout_broadcast_enabled", sa.Boolean(), nullable=False, server_default=sa.text("0")),
            sa.Column("timeout_message_template", sa.Text(), nullable=True),
            sa.Column("timeout_mention_targets", sa.JSON(), nullable=False, server_default=sa.text("('[]')")),
        ],
        "anomaly_records": [
            sa.Column("last_sql_validation_result", sa.JSON(), nullable=True),
            sa.Column("validation_result_version", sa.Integer(), nullable=False, server_default=sa.text("0")),
        ],
        "anomaly_validation_requests": [
            sa.Column("synced_result_version", sa.Integer(), nullable=False, server_default=sa.text("0")),
        ],
        "anomaly_record_groups": [
            sa.Column("timeout_broadcast_snapshot", sa.JSON(), nullable=False, server_default=sa.text("('{}')")),
            sa.Column("timeout_deadline", sa.DateTime(), nullable=True),
            sa.Column("timeout_processed_at", sa.DateTime(), nullable=True),
        ],
        "anomaly_record_group_members": [
            sa.Column("is_new", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        ],
        "anomaly_group_broadcast_deliveries": [
            sa.Column("broadcast_kind", sa.String(20), nullable=False, server_default=sa.text("'situation'")),
        ],
    }


DELIVERY_TABLE = "anomaly_group_broadcast_deliveries"
OLD_KEY = "uq_anomaly_group_delivery_part"
NEW_KEY = "uq_anomaly_group_delivery_kind_part"
DEADLINE_INDEX = "ix_anomaly_record_groups_timeout_deadline"


def _replace_delivery_key(old_name, new_name, columns):
    names = {constraint["name"] for constraint in sa.inspect(op.get_bind()).get_unique_constraints(DELIVERY_TABLE)}
    # Create the replacement before dropping the old index: on MySQL the
    # leading rule/group columns also support the delivery foreign key.
    with op.batch_alter_table(DELIVERY_TABLE) as batch:
        if new_name not in names:
            batch.create_unique_constraint(new_name, columns)
        if old_name in names:
            batch.drop_constraint(old_name, type_="unique")


def upgrade():
    for table, columns in _columns().items():
        existing = {column["name"] for column in sa.inspect(op.get_bind()).get_columns(table)}
        for column in columns:
            if column.name not in existing:
                op.add_column(table, column)
    indexes = {index["name"] for index in sa.inspect(op.get_bind()).get_indexes("anomaly_record_groups")}
    if DEADLINE_INDEX not in indexes:
        op.create_index(DEADLINE_INDEX, "anomaly_record_groups", ["timeout_deadline"])
    _replace_delivery_key(OLD_KEY, NEW_KEY, ["rule_id", "detected_at", "broadcast_kind", "part_index"])


def downgrade():
    existing = {column["name"] for column in sa.inspect(op.get_bind()).get_columns(DELIVERY_TABLE)}
    if "broadcast_kind" in existing:
        if op.get_bind().execute(sa.text(
            "SELECT COUNT(*) FROM anomaly_group_broadcast_deliveries WHERE broadcast_kind <> 'situation'"
        )).scalar_one():
            raise RuntimeError("已有超时播报投递，不能无损回退；请保留迁移并回滚应用版本")
    _replace_delivery_key(NEW_KEY, OLD_KEY, ["rule_id", "detected_at", "part_index"])
    indexes = {index["name"] for index in sa.inspect(op.get_bind()).get_indexes("anomaly_record_groups")}
    if DEADLINE_INDEX in indexes:
        op.drop_index(DEADLINE_INDEX, table_name="anomaly_record_groups")
    for table, columns in reversed(list(_columns().items())):
        existing = {column["name"] for column in sa.inspect(op.get_bind()).get_columns(table)}
        with op.batch_alter_table(table) as batch:
            for column in reversed(columns):
                if column.name in existing:
                    batch.drop_column(column.name)
