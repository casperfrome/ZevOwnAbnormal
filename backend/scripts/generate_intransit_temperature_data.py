from __future__ import annotations

import argparse
import random
import sys
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pymysql
from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings, get_settings
from app.database import Base, make_session_factory
from app.models import Dataset, Datasource


DATABASE_NAME = "tastien_ads"
TABLE_NAME = "dwd_sc_intransit_car_temperature_di"
DATASET_NAME = "运输途中车辆温度"
ROW_COUNT = 188
DATA_DATE = "2026-08-22"
DEFAULT_SEED = 20260822

DATASOURCE_FINGERPRINT = {
    "name": "塔斯汀经营 ADS",
    "type": "starrocks",
    "host": "127.0.0.1",
    "port": 9030,
    "database": DATABASE_NAME,
    "username": "root",
    "password_encrypted": "",
    "ssl": False,
    "description": "StarRocks 综合经营 ADS 层",
}

DATASET_SQL = f"""SELECT data_date, detected_at, license_plate, target_store,
refrigerated_temperature, frozen_temperature
FROM {TABLE_NAME}
ORDER BY detected_at"""

DATASET_FIELDS = [
    {"name": "data_date", "type": "VARCHAR"},
    {"name": "detected_at", "type": "DATETIME"},
    {"name": "license_plate", "type": "VARCHAR"},
    {"name": "target_store", "type": "VARCHAR"},
    {"name": "refrigerated_temperature", "type": "DECIMAL"},
    {"name": "frozen_temperature", "type": "DECIMAL"},
]

PROVINCE_PREFIXES = "京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼"
PLATE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"
PLATE_SUFFIX_CHARS = f"{PLATE_LETTERS}0123456789"
STORE_CITIES = [
    ("北京", "朝阳"), ("上海", "浦东"), ("广州", "天河"), ("深圳", "南山"),
    ("杭州", "西湖"), ("南京", "鼓楼"), ("武汉", "江汉"), ("成都", "锦江"),
    ("重庆", "渝中"), ("西安", "雁塔"), ("长沙", "岳麓"), ("厦门", "思明"),
]


def _decimal_temperature(rng: random.Random, lower: int, upper: int) -> Decimal:
    return Decimal(rng.randint(lower, upper)).scaleb(-2)


def _license_plate(rng: random.Random, used: set[str]) -> str:
    while True:
        plate = (
            rng.choice(PROVINCE_PREFIXES)
            + rng.choice(PLATE_LETTERS)
            + "".join(rng.choice(PLATE_SUFFIX_CHARS) for _ in range(5))
        )
        if plate not in used:
            used.add(plate)
            return plate


def generate_rows(seed: int = DEFAULT_SEED) -> list[tuple]:
    rng = random.Random(seed)
    day_start = datetime(2026, 8, 22)
    seconds = sorted(rng.sample(range(24 * 60 * 60), ROW_COUNT))
    used_plates: set[str] = set()
    rows = []

    for second in seconds:
        city, district = rng.choice(STORE_CITIES)
        rows.append((
            DATA_DATE,
            day_start + timedelta(seconds=second),
            _license_plate(rng, used_plates),
            f"塔斯汀{city}{district}{rng.randint(1, 99):02d}店",
            _decimal_temperature(rng, 50, 680),
            _decimal_temperature(rng, -2400, -1201),
        ))

    refrigerated_anomaly = list(rows[-2])
    refrigerated_anomaly[4] = Decimal("8.50")
    refrigerated_anomaly[5] = Decimal("-18.00")
    rows[-2] = tuple(refrigerated_anomaly)

    frozen_anomaly = list(rows[-1])
    frozen_anomaly[4] = Decimal("4.00")
    frozen_anomaly[5] = Decimal("-8.50")
    rows[-1] = tuple(frozen_anomaly)
    return rows


def starrocks_connection(database: str | None = None):
    return pymysql.connect(
        host="127.0.0.1",
        port=9030,
        user="root",
        password="",
        database=database,
        charset="utf8mb4",
        autocommit=True,
    )


def seed_starrocks(rows: list[tuple]) -> None:
    connection = starrocks_connection()
    try:
        with connection.cursor() as cursor:
            cursor.execute(f"CREATE DATABASE IF NOT EXISTS {DATABASE_NAME}")
    finally:
        connection.close()

    connection = starrocks_connection(DATABASE_NAME)
    try:
        with connection.cursor() as cursor:
            cursor.execute(f"""CREATE TABLE IF NOT EXISTS {TABLE_NAME} (
                data_date VARCHAR(10),
                detected_at DATETIME,
                license_plate VARCHAR(16),
                target_store VARCHAR(100),
                refrigerated_temperature DECIMAL(5,2),
                frozen_temperature DECIMAL(5,2)
            ) ENGINE=OLAP
            DUPLICATE KEY(data_date, detected_at, license_plate)
            DISTRIBUTED BY HASH(license_plate) BUCKETS 4
            PROPERTIES ('replication_num'='1')""")
            cursor.execute(f"TRUNCATE TABLE {TABLE_NAME}")
            cursor.executemany(
                f"""INSERT INTO {TABLE_NAME} (
                    data_date, detected_at, license_plate, target_store,
                    refrigerated_temperature, frozen_temperature
                ) VALUES (%s, %s, %s, %s, %s, %s)""",
                rows,
            )
    finally:
        connection.close()


def _is_standard_datasource(datasource: Datasource) -> bool:
    return all(
        getattr(datasource, field) == expected
        for field, expected in DATASOURCE_FINGERPRINT.items()
    )


def register_platform_dataset(settings: Settings | None = None) -> None:
    settings = settings or get_settings()
    engine, factory = make_session_factory(settings.database_url)
    Base.metadata.create_all(engine)
    try:
        with factory() as session:
            datasource = session.scalar(
                select(Datasource).where(Datasource.name == DATASOURCE_FINGERPRINT["name"])
            )
            if datasource is None:
                datasource = Datasource(**DATASOURCE_FINGERPRINT, status="online")
                session.add(datasource)
                session.flush()
            elif not _is_standard_datasource(datasource):
                raise RuntimeError("检测到同名数据源，但配置与标准 StarRocks 数据源不匹配，已停止注册数据集")

            dataset = session.scalar(select(Dataset).where(Dataset.name == DATASET_NAME))
            if dataset is None:
                dataset = Dataset(
                    name=DATASET_NAME,
                    description="运输途中车辆的冷藏区与冷冻区温度明细，用于温控异常检测",
                    datasource=datasource,
                    sql=DATASET_SQL,
                    fields=[dict(field) for field in DATASET_FIELDS],
                    row_count=ROW_COUNT,
                )
                session.add(dataset)
            elif dataset.datasource_id != datasource.id:
                raise RuntimeError("检测到同名数据集指向其他数据源，已停止更新")
            else:
                dataset.description = "运输途中车辆的冷藏区与冷冻区温度明细，用于温控异常检测"
                dataset.sql = DATASET_SQL
                dataset.fields = [dict(field) for field in DATASET_FIELDS]
                dataset.row_count = ROW_COUNT
            session.commit()
    finally:
        engine.dispose()


def parse_args():
    parser = argparse.ArgumentParser(description="生成运输途中车辆温度 StarRocks 演示数据并注册平台数据集")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help="随机种子，默认 20260822")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    rows = generate_rows(args.seed)
    seed_starrocks(rows)
    register_platform_dataset()
    print(f"运输温度数据生成完成：{DATABASE_NAME}.{TABLE_NAME} 共 {len(rows)} 条，平台数据集“{DATASET_NAME}”已注册")


if __name__ == "__main__":
    main()
