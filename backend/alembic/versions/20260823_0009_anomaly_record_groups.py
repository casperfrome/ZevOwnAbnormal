"""add anomaly record groups and Feishu group broadcasts

Revision ID: 20260823_0009
Revises: 20260822_0008
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql


revision = "20260823_0009"
down_revision = "20260822_0008"
branch_labels = None
depends_on = None


def _columns(bind, table_name: str) -> set[str]:
    inspector = sa.inspect(bind)
    if table_name not in inspector.get_table_names():
        return set()
    return {column["name"] for column in inspector.get_columns(table_name)}


def _empty_list_column(name: str) -> sa.Column:
    return sa.Column(name, sa.JSON(), nullable=False, server_default=sa.text("('[]')"))


def _precise_datetime():
    return sa.DateTime().with_variant(mysql.DATETIME(fsp=6), "mysql")


def upgrade():
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    if bind.dialect.name == "mysql":
        op.alter_column(
            "rule_runs", "started_at",
            existing_type=mysql.DATETIME(), type_=mysql.DATETIME(fsp=6),
            existing_nullable=False,
        )
    rule_columns = _columns(bind, "rules")
    if "group_broadcast_enabled" not in rule_columns:
        op.add_column(
            "rules",
            sa.Column(
                "group_broadcast_enabled", sa.Boolean(), nullable=False,
                server_default=sa.false(),
            ),
        )
    if "group_webhook_encrypted" not in rule_columns:
        op.add_column("rules", sa.Column("group_webhook_encrypted", sa.Text(), nullable=True))
    if "group_mention_targets" not in rule_columns:
        op.add_column("rules", _empty_list_column("group_mention_targets"))

    if "anomaly_record_groups" not in tables:
        op.create_table(
            "anomaly_record_groups",
            sa.Column("rule_id", sa.String(36), sa.ForeignKey("rules.id"), primary_key=True),
            sa.Column("detected_at", _precise_datetime(), primary_key=True),
            sa.Column("run_id", sa.String(36), sa.ForeignKey("rule_runs.id"), nullable=False),
            sa.Column("rule_name", sa.String(150), nullable=False),
            sa.Column("scanned_rows", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("matched_rows", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("new_anomalies", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("broadcast_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.UniqueConstraint("run_id", name="uq_anomaly_record_group_run"),
        )
        op.create_index(
            "ix_anomaly_record_groups_detected_at", "anomaly_record_groups", ["detected_at"],
        )
    if "anomaly_record_group_members" not in tables:
        op.create_table(
            "anomaly_record_group_members",
            sa.Column("rule_id", sa.String(36), primary_key=True),
            sa.Column("detected_at", _precise_datetime(), primary_key=True),
            sa.Column("anomaly_id", sa.String(36), sa.ForeignKey("anomaly_records.id"), primary_key=True),
            sa.Column("position", sa.Integer(), nullable=False),
            sa.ForeignKeyConstraint(
                ["rule_id", "detected_at"],
                ["anomaly_record_groups.rule_id", "anomaly_record_groups.detected_at"],
                name="fk_anomaly_group_member_group",
            ),
            sa.UniqueConstraint(
                "rule_id", "detected_at", "position", name="uq_anomaly_group_member_position",
            ),
        )
        op.create_index(
            "ix_anomaly_group_members_anomaly", "anomaly_record_group_members", ["anomaly_id"],
        )
    if "anomaly_group_broadcast_deliveries" not in tables:
        op.create_table(
            "anomaly_group_broadcast_deliveries",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("rule_id", sa.String(36), nullable=False),
            sa.Column("detected_at", _precise_datetime(), nullable=False),
            sa.Column("part_index", sa.Integer(), nullable=False),
            sa.Column("total_parts", sa.Integer(), nullable=False),
            sa.Column("webhook_encrypted", sa.Text(), nullable=False),
            sa.Column("payload", sa.JSON(), nullable=False),
            sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
            sa.Column("attempts", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("last_error", sa.Text(), nullable=True),
            sa.Column("delivered_at", sa.DateTime(), nullable=True),
            sa.Column("next_attempt_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(
                ["rule_id", "detected_at"],
                ["anomaly_record_groups.rule_id", "anomaly_record_groups.detected_at"],
                name="fk_anomaly_group_delivery_group",
            ),
            sa.UniqueConstraint(
                "rule_id", "detected_at", "part_index", name="uq_anomaly_group_delivery_part",
            ),
        )
        op.create_index(
            "ix_anomaly_group_deliveries_retry",
            "anomaly_group_broadcast_deliveries",
            ["status", "next_attempt_at", "updated_at"],
        )

    if "anomaly_id" in _columns(bind, "anomaly_push_jobs"):
        if bind.dialect.name == "sqlite":
            with op.batch_alter_table("anomaly_push_jobs") as batch_op:
                batch_op.alter_column(
                    "anomaly_id", existing_type=sa.String(36), nullable=True,
                )
        else:
            op.alter_column(
                "anomaly_push_jobs", "anomaly_id", existing_type=sa.String(36), nullable=True,
            )


def downgrade():
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    if "anomaly_push_jobs" in tables:
        bind.execute(sa.text("DELETE FROM anomaly_push_jobs WHERE kind = 'group_broadcast'"))
    for table_name in (
        "anomaly_group_broadcast_deliveries",
        "anomaly_record_group_members",
        "anomaly_record_groups",
    ):
        if table_name in set(sa.inspect(bind).get_table_names()):
            op.drop_table(table_name)
    if "anomaly_id" in _columns(bind, "anomaly_push_jobs"):
        if bind.dialect.name == "sqlite":
            with op.batch_alter_table("anomaly_push_jobs") as batch_op:
                batch_op.alter_column(
                    "anomaly_id", existing_type=sa.String(36), nullable=False,
                )
        else:
            op.alter_column(
                "anomaly_push_jobs", "anomaly_id", existing_type=sa.String(36), nullable=False,
            )
    for column_name in (
        "group_mention_targets", "group_webhook_encrypted", "group_broadcast_enabled",
    ):
        if column_name in _columns(bind, "rules"):
            op.drop_column("rules", column_name)
    if bind.dialect.name == "mysql":
        op.alter_column(
            "rule_runs", "started_at",
            existing_type=mysql.DATETIME(fsp=6), type_=mysql.DATETIME(),
            existing_nullable=False,
        )
