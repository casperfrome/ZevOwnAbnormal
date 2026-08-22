from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select

from app.config import get_settings
from app.database import Base, make_session_factory
from app.models import Dataset, Datasource, Rule
from app.security import CredentialCipher


LEGACY_ADS_DAILY_SQL = """SELECT metric_date, store_id, store_name, province, manager_open_id, gmv,
order_count, avg_order_value, refund_rate, avg_delivery_minutes, member_ratio, gmv_growth_rate
FROM ads_store_daily_operation WHERE metric_date >= CURRENT_DATE() - INTERVAL 30 DAY
ORDER BY store_id, metric_date"""
ADS_DAILY_SQL = """SELECT metric_date, store_id, store_name, province, manager_open_id, manager_user_id, gmv,
order_count, avg_order_value, refund_rate, avg_delivery_minutes, member_ratio, gmv_growth_rate
FROM ads_store_daily_operation WHERE metric_date >= CURRENT_DATE() - INTERVAL 30 DAY
ORDER BY store_id, metric_date"""
LEGACY_ADS_DAILY_FIELDS = [
    {"name": "metric_date", "type": "DATE"}, {"name": "store_id", "type": "VARCHAR"},
    {"name": "store_name", "type": "VARCHAR"}, {"name": "province", "type": "VARCHAR"},
    {"name": "manager_open_id", "type": "VARCHAR"}, {"name": "gmv", "type": "DECIMAL"},
    {"name": "order_count", "type": "INT"}, {"name": "avg_order_value", "type": "DECIMAL"},
    {"name": "refund_rate", "type": "DOUBLE"}, {"name": "avg_delivery_minutes", "type": "DOUBLE"},
    {"name": "member_ratio", "type": "DOUBLE"}, {"name": "gmv_growth_rate", "type": "DOUBLE"},
]
ADS_DAILY_FIELDS = [
    *LEGACY_ADS_DAILY_FIELDS[:5],
    {"name": "manager_user_id", "type": "VARCHAR"},
    *LEGACY_ADS_DAILY_FIELDS[5:],
]
DEMO_VALIDATION_TARGETS = [{"source": "field", "field": "manager_user_id"}]
DEMO_RULE_DESCRIPTION = "退款率超过 15% 时触发；启用前请替换为真实飞书接收者"
DEMO_RULE_CONDITIONS = [
    {"field": "refund_rate", "operator": "gt", "value": 0.15, "upper_value": None, "baseline": None}
]
DEMO_NOTIFICATION_TARGETS = [
    {"receive_id_type": "open_id", "source": "field", "value": None, "field": "manager_open_id"}
]


def _is_demo_owned_rule(rule: Rule, dataset: Dataset) -> bool:
    return (
        rule.dataset_id == dataset.id
        and rule.description == DEMO_RULE_DESCRIPTION
        and rule.conditions == DEMO_RULE_CONDITIONS
        and rule.anomaly_key_fields == ["store_id", "metric_date"]
        and rule.notification_targets == DEMO_NOTIFICATION_TARGETS
    )


def _upgrade_demo_dataset(dataset: Dataset, starrocks: Datasource) -> bool:
    if dataset.datasource_id != starrocks.id:
        print("检测到同名数据集但数据源不属于 demo，未自动更新；请人工核对 manager_user_id 字段。")
        return False
    if dataset.sql == ADS_DAILY_SQL and dataset.fields == ADS_DAILY_FIELDS:
        return True
    if dataset.sql == LEGACY_ADS_DAILY_SQL and dataset.fields == LEGACY_ADS_DAILY_FIELDS:
        dataset.sql = ADS_DAILY_SQL
        dataset.fields = [dict(field) for field in ADS_DAILY_FIELDS]
        return True
    print("检测到已定制的 demo 同名数据集，未自动更新；请人工把 manager_user_id 加入 SQL 和字段列表。")
    return False


def main():
    settings = get_settings()
    engine, factory = make_session_factory(settings.database_url)
    Base.metadata.create_all(engine)
    cipher = CredentialCipher(settings.datasource_encryption_key)
    with factory() as session:
        mysql = session.scalar(select(Datasource).where(Datasource.name == "塔斯汀订单生产库"))
        if not mysql:
            mysql = Datasource(
                name="塔斯汀订单生产库", type="mysql", host="127.0.0.1", port=3306,
                database="tastien_prod", username="app", password_encrypted=cipher.encrypt("dev_app_password"),
                description="Faker 生成的门店订单生产模拟数据", status="online",
            )
            session.add(mysql)
        starrocks = session.scalar(select(Datasource).where(Datasource.name == "塔斯汀经营 ADS"))
        if not starrocks:
            starrocks = Datasource(
                name="塔斯汀经营 ADS", type="starrocks", host="127.0.0.1", port=9030,
                database="tastien_ads", username="root", password_encrypted="",
                description="StarRocks 综合经营 ADS 层", status="online",
            )
            session.add(starrocks)
        session.flush()

        order_daily = session.scalar(select(Dataset).where(Dataset.name == "每日订单经营汇总"))
        if not order_daily:
            order_daily = Dataset(
                name="每日订单经营汇总", description="MySQL 最近 30 天订单金额、订单量和履约时长",
                datasource=mysql,
                sql="""SELECT DATE(ordered_at) AS metric_date, store_id, COUNT(*) AS order_count,
SUM(amount) AS gmv, AVG(delivery_minutes) AS avg_delivery_minutes
FROM orders WHERE ordered_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
GROUP BY DATE(ordered_at), store_id ORDER BY store_id, metric_date""",
                fields=[
                    {"name": "metric_date", "type": "DATE"}, {"name": "store_id", "type": "VARCHAR"},
                    {"name": "order_count", "type": "BIGINT"}, {"name": "gmv", "type": "DECIMAL"},
                    {"name": "avg_delivery_minutes", "type": "DECIMAL"},
                ],
            )
            session.add(order_daily)
        ads_daily = session.scalar(select(Dataset).where(Dataset.name == "门店综合经营日报"))
        if not ads_daily:
            ads_daily = Dataset(
                name="门店综合经营日报", description="StarRocks 门店级 ADS 指标，用于异常检测",
                datasource=starrocks,
                sql=ADS_DAILY_SQL,
                fields=[dict(field) for field in ADS_DAILY_FIELDS],
            )
            session.add(ads_daily)
            ads_validation_ready = True
        else:
            ads_validation_ready = _upgrade_demo_dataset(ads_daily, starrocks)
        session.flush()
        demo_rule = session.scalar(select(Rule).where(Rule.name == "门店高退款率检测"))
        if not demo_rule:
            demo_rule = Rule(
                name="门店高退款率检测", description=DEMO_RULE_DESCRIPTION,
                dataset=ads_daily, severity="high", logic="AND",
                conditions=[dict(condition) for condition in DEMO_RULE_CONDITIONS],
                anomaly_key_fields=["store_id", "metric_date"],
                schedule={"frequency": "day", "interval": 1, "time": "09:00", "start_date": date.today().isoformat(), "end_date": None},
                notification_targets=[dict(target) for target in DEMO_NOTIFICATION_TARGETS],
                validation_enabled=False,
                validation_targets=(
                    [dict(target) for target in DEMO_VALIDATION_TARGETS]
                    if ads_validation_ready else []
                ),
                validation_timeout_minutes=1440,
                enabled=False, sync_status="pending",
            )
            session.add(demo_rule)
        elif (
            ads_validation_ready
            and _is_demo_owned_rule(demo_rule, ads_daily)
            and demo_rule.validation_enabled is False
            and demo_rule.validation_targets == []
        ):
            demo_rule.validation_targets = [dict(target) for target in DEMO_VALIDATION_TARGETS]
        elif not _is_demo_owned_rule(demo_rule, ads_daily):
            print("检测到已定制的 demo 同名规则，未自动更新 validation 配置。")
        session.commit()
    engine.dispose()
    print("平台演示元数据初始化完成")


if __name__ == "__main__":
    main()
