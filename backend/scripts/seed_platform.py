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
                sql="""SELECT metric_date, store_id, store_name, province, manager_open_id, manager_user_id, gmv,
order_count, avg_order_value, refund_rate, avg_delivery_minutes, member_ratio, gmv_growth_rate
FROM ads_store_daily_operation WHERE metric_date >= CURRENT_DATE() - INTERVAL 30 DAY
ORDER BY store_id, metric_date""",
                fields=[
                    {"name": "metric_date", "type": "DATE"}, {"name": "store_id", "type": "VARCHAR"},
                    {"name": "store_name", "type": "VARCHAR"}, {"name": "province", "type": "VARCHAR"},
                    {"name": "manager_open_id", "type": "VARCHAR"}, {"name": "manager_user_id", "type": "VARCHAR"},
                    {"name": "gmv", "type": "DECIMAL"},
                    {"name": "order_count", "type": "INT"}, {"name": "avg_order_value", "type": "DECIMAL"},
                    {"name": "refund_rate", "type": "DOUBLE"}, {"name": "avg_delivery_minutes", "type": "DOUBLE"},
                    {"name": "member_ratio", "type": "DOUBLE"}, {"name": "gmv_growth_rate", "type": "DOUBLE"},
                ],
            )
            session.add(ads_daily)
        session.flush()
        if not session.scalar(select(Rule).where(Rule.name == "门店高退款率检测")):
            session.add(Rule(
                name="门店高退款率检测", description="退款率超过 15% 时触发；启用前请替换为真实飞书接收者",
                dataset=ads_daily, severity="high", logic="AND",
                conditions=[{"field": "refund_rate", "operator": "gt", "value": 0.15, "upper_value": None, "baseline": None}],
                anomaly_key_fields=["store_id", "metric_date"],
                schedule={"frequency": "day", "interval": 1, "time": "09:00", "start_date": date.today().isoformat(), "end_date": None},
                notification_targets=[{"receive_id_type": "open_id", "source": "field", "value": None, "field": "manager_open_id"}],
                validation_enabled=False,
                validation_targets=[{"source": "field", "field": "manager_user_id"}],
                validation_timeout_minutes=1440,
                enabled=False, sync_status="pending",
            ))
        session.commit()
    engine.dispose()
    print("平台演示元数据初始化完成")


if __name__ == "__main__":
    main()
