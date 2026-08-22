from __future__ import annotations

import argparse
import random
import time
from datetime import date, datetime, timedelta

import pymysql


PROVINCES = ["北京", "上海", "广东", "浙江", "江苏", "四川", "湖北", "湖南", "福建", "山东", "河南", "安徽"]
CHANNELS = ["堂食", "小程序", "美团", "饿了么"]
PRODUCTS = [("P001", "中国汉堡", 18.0), ("P002", "香辣鸡腿堡", 16.0), ("P003", "薯条", 8.0), ("P004", "可乐", 6.0), ("P005", "鸡翅", 12.0)]
STORE_DAILY_COLUMNS = (
    "metric_date, store_id, store_name, province, manager_open_id, manager_user_id, "
    "gmv, order_count, avg_order_value, refund_rate, avg_delivery_minutes, member_ratio, gmv_growth_rate"
)


def is_injected_anomaly(store_index: int, day_offset: int) -> bool:
    return day_offset == 0 and (store_index == 1 or store_index % 997 == 0)


def demo_manager_user_id(store_index: int) -> str:
    """Return a deterministic, non-production Feishu user_id placeholder."""
    return f"demo_user_{store_index:05d}"


def mysql_connection(database=None, root=True):
    return pymysql.connect(
        host="127.0.0.1", port=3306, user="root" if root else "app",
        password="dev_root_password" if root else "dev_app_password",
        database=database, charset="utf8mb4", autocommit=True,
    )


def starrocks_connection(database=None):
    return pymysql.connect(host="127.0.0.1", port=9030, user="root", password="", database=database, charset="utf8mb4", autocommit=True)


def _starrocks_column_exists(cursor, table_name: str, column_name: str) -> bool:
    cursor.execute(
        """SELECT 1 FROM information_schema.columns
WHERE table_schema = %s AND table_name = %s AND column_name = %s LIMIT 1""",
        ("tastien_ads", table_name, column_name),
    )
    return cursor.fetchone() is not None


def ensure_manager_user_id_column(cursor) -> None:
    """Upgrade the pre-validation demo table and wait for async StarRocks DDL."""
    table_name = "ads_store_daily_operation"
    column_name = "manager_user_id"
    if _starrocks_column_exists(cursor, table_name, column_name):
        return

    alter_error = None
    try:
        cursor.execute(
            'ALTER TABLE ads_store_daily_operation ADD COLUMN manager_user_id '
            'VARCHAR(100) DEFAULT "" AFTER manager_open_id'
        )
    except pymysql.MySQLError as exc:
        # A previous run may already have submitted the asynchronous schema change.
        alter_error = exc

    for check in range(61):
        if _starrocks_column_exists(cursor, table_name, column_name):
            return
        if check < 60:
            time.sleep(2)

    message = (
        "StarRocks manager_user_id 列升级未在 120 秒内完成；"
        "请运行 SHOW ALTER TABLE COLUMN FROM tastien_ads 检查任务，完成后重试造数。"
    )
    if alter_error is not None:
        raise RuntimeError(message) from alter_error
    raise RuntimeError(message)


def seed_mysql(args, rng: random.Random):
    print(f"目标 MySQL 数据库: tastien_prod；门店 {args.stores:,}，订单 {args.orders:,}")
    root = mysql_connection()
    with root.cursor() as cur:
        if args.reset:
            cur.execute("DROP DATABASE IF EXISTS tastien_prod")
        cur.execute("CREATE DATABASE IF NOT EXISTS tastien_prod CHARACTER SET utf8mb4")
        cur.execute("GRANT ALL PRIVILEGES ON tastien_prod.* TO 'app'@'%'")
    root.close()
    conn = mysql_connection("tastien_prod")
    with conn.cursor() as cur:
        cur.execute("""CREATE TABLE IF NOT EXISTS stores (
            store_id VARCHAR(20) PRIMARY KEY, store_name VARCHAR(100), province VARCHAR(30), city VARCHAR(50),
            opened_at DATE, status VARCHAR(20), manager_open_id VARCHAR(100), INDEX idx_province(province)
        ) ENGINE=InnoDB""")
        cur.execute("""CREATE TABLE IF NOT EXISTS orders (
            order_id BIGINT PRIMARY KEY, store_id VARCHAR(20), ordered_at DATETIME, channel VARCHAR(20),
            status VARCHAR(20), customer_id VARCHAR(30), amount DECIMAL(12,2), discount_amount DECIMAL(12,2),
            delivery_minutes INT, INDEX idx_store_date(store_id, ordered_at), INDEX idx_ordered_at(ordered_at)
        ) ENGINE=InnoDB""")
        cur.execute("""CREATE TABLE IF NOT EXISTS order_items (
            id BIGINT AUTO_INCREMENT PRIMARY KEY, order_id BIGINT, product_id VARCHAR(20), product_name VARCHAR(100),
            quantity INT, unit_price DECIMAL(10,2), INDEX idx_order(order_id)
        ) ENGINE=InnoDB""")
        cur.execute("""CREATE TABLE IF NOT EXISTS payments (
            id BIGINT AUTO_INCREMENT PRIMARY KEY, order_id BIGINT, method VARCHAR(20), status VARCHAR(20), paid_at DATETIME,
            INDEX idx_payment_order(order_id)
        ) ENGINE=InnoDB""")
        cur.execute("""CREATE TABLE IF NOT EXISTS refunds (
            id BIGINT AUTO_INCREMENT PRIMARY KEY, order_id BIGINT, refund_amount DECIMAL(10,2), reason VARCHAR(100), refunded_at DATETIME,
            INDEX idx_refund_order(order_id)
        ) ENGINE=InnoDB""")
        if args.reset:
            cur.execute("TRUNCATE TABLE refunds")
            cur.execute("TRUNCATE TABLE payments")
            cur.execute("TRUNCATE TABLE order_items")
            cur.execute("TRUNCATE TABLE orders")
            cur.execute("TRUNCATE TABLE stores")
        stores = []
        for index in range(1, args.stores + 1):
            province = PROVINCES[(index - 1) % len(PROVINCES)]
            stores.append((f"TS{index:05d}", f"塔斯汀{province}{index:05d}店", province, f"{province}{(index % 30) + 1}市", date(2018, 1, 1) + timedelta(days=rng.randrange(3000)), "open", f"ou_demo_{index:05d}"))
        cur.executemany("INSERT IGNORE INTO stores VALUES (%s,%s,%s,%s,%s,%s,%s)", stores)

        end = date.today()
        order_batch, item_batch, payment_batch, refund_batch = [], [], [], []
        for order_id in range(1, args.orders + 1):
            store_index = rng.randint(1, args.stores)
            ordered_at = datetime.combine(end - timedelta(days=rng.randrange(args.days)), datetime.min.time()) + timedelta(seconds=rng.randrange(86400))
            product_count = rng.randint(1, 3)
            selected = [rng.choice(PRODUCTS) for _ in range(product_count)]
            amount = round(sum(product[2] * rng.randint(1, 2) for product in selected), 2)
            status = "refunded" if order_id % 97 == 0 else "paid"
            order_batch.append((order_id, f"TS{store_index:05d}", ordered_at, rng.choice(CHANNELS), status, f"C{rng.randint(1, max(args.orders // 3, 1)):09d}", amount, round(amount * rng.choice([0, 0, 0.05, 0.1]), 2), rng.randint(8, 55)))
            for product in selected:
                item_batch.append((order_id, product[0], product[1], 1, product[2]))
            payment_batch.append((order_id, rng.choice(["wechat", "alipay", "cash"]), "success", ordered_at))
            if status == "refunded":
                refund_batch.append((order_id, amount, rng.choice(["口味问题", "配送超时", "重复下单"]), ordered_at + timedelta(hours=1)))
            if len(order_batch) >= args.batch_size:
                cur.executemany("INSERT IGNORE INTO orders VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)", order_batch)
                cur.executemany("INSERT INTO order_items(order_id,product_id,product_name,quantity,unit_price) VALUES (%s,%s,%s,%s,%s)", item_batch)
                cur.executemany("INSERT INTO payments(order_id,method,status,paid_at) VALUES (%s,%s,%s,%s)", payment_batch)
                if refund_batch:
                    cur.executemany("INSERT INTO refunds(order_id,refund_amount,reason,refunded_at) VALUES (%s,%s,%s,%s)", refund_batch)
                order_batch.clear()
                item_batch.clear()
                payment_batch.clear()
                refund_batch.clear()
        if order_batch:
            cur.executemany("INSERT IGNORE INTO orders VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)", order_batch)
            cur.executemany("INSERT INTO order_items(order_id,product_id,product_name,quantity,unit_price) VALUES (%s,%s,%s,%s,%s)", item_batch)
            cur.executemany("INSERT INTO payments(order_id,method,status,paid_at) VALUES (%s,%s,%s,%s)", payment_batch)
            if refund_batch:
                cur.executemany("INSERT INTO refunds(order_id,refund_amount,reason,refunded_at) VALUES (%s,%s,%s,%s)", refund_batch)
    conn.close()


def seed_starrocks(args, rng: random.Random):
    print(f"目标 StarRocks 数据库: tastien_ads；门店日 ADS 约 {args.stores * args.days:,} 行")
    conn = starrocks_connection()
    with conn.cursor() as cur:
        if args.reset:
            cur.execute("DROP DATABASE IF EXISTS tastien_ads")
        cur.execute("CREATE DATABASE IF NOT EXISTS tastien_ads")
    conn.close()
    conn = starrocks_connection("tastien_ads")
    with conn.cursor() as cur:
        cur.execute("""CREATE TABLE IF NOT EXISTS ads_store_daily_operation (
            metric_date DATE, store_id VARCHAR(20), store_name VARCHAR(100), province VARCHAR(30),
            manager_open_id VARCHAR(100), manager_user_id VARCHAR(100),
            gmv DECIMAL(14,2), order_count INT, avg_order_value DECIMAL(10,2), refund_rate DOUBLE,
            avg_delivery_minutes DOUBLE, member_ratio DOUBLE, gmv_growth_rate DOUBLE
        ) ENGINE=OLAP DUPLICATE KEY(metric_date, store_id) DISTRIBUTED BY HASH(store_id) BUCKETS 8 PROPERTIES ('replication_num'='1')""")
        cur.execute("""CREATE TABLE IF NOT EXISTS ads_region_daily_operation (
            metric_date DATE, province VARCHAR(30), gmv DECIMAL(16,2), order_count BIGINT, store_count INT, refund_rate DOUBLE
        ) ENGINE=OLAP DUPLICATE KEY(metric_date, province) DISTRIBUTED BY HASH(province) BUCKETS 4 PROPERTIES ('replication_num'='1')""")
        cur.execute("""CREATE TABLE IF NOT EXISTS ads_brand_daily_operation (
            metric_date DATE, gmv DECIMAL(18,2), order_count BIGINT, active_store_count INT, avg_order_value DECIMAL(10,2), refund_rate DOUBLE
        ) ENGINE=OLAP DUPLICATE KEY(metric_date) DISTRIBUTED BY HASH(metric_date) BUCKETS 2 PROPERTIES ('replication_num'='1')""")
        ensure_manager_user_id_column(cur)
        if args.reset:
            cur.execute("TRUNCATE TABLE ads_store_daily_operation")
            cur.execute("TRUNCATE TABLE ads_region_daily_operation")
            cur.execute("TRUNCATE TABLE ads_brand_daily_operation")
        end = date.today()
        batch = []
        region_totals = {}
        brand_totals = {}
        for offset in range(args.days):
            metric_date = end - timedelta(days=offset)
            for index in range(1, args.stores + 1):
                province = PROVINCES[(index - 1) % len(PROVINCES)]
                order_count = rng.randint(45, 320)
                aov = rng.uniform(24, 42)
                gmv = round(order_count * aov, 2)
                refund_rate = round(rng.uniform(0.002, 0.06), 4)
                if is_injected_anomaly(index, offset):
                    gmv = round(gmv * 4.5, 2)
                    refund_rate = 0.22
                batch.append((
                    metric_date, f"TS{index:05d}", f"塔斯汀{province}{index:05d}店", province,
                    f"ou_demo_{index:05d}", demo_manager_user_id(index), gmv, order_count,
                    round(aov, 2), refund_rate, round(rng.uniform(12, 38), 2),
                    round(rng.uniform(0.35, 0.85), 4), round(rng.uniform(-0.2, 0.35), 4),
                ))
                rkey = (metric_date, province)
                current = region_totals.setdefault(rkey, [0.0, 0, 0, 0.0])
                current[0] += gmv
                current[1] += order_count
                current[2] += 1
                current[3] += refund_rate
                brand = brand_totals.setdefault(metric_date, [0.0, 0, 0.0])
                brand[0] += gmv
                brand[1] += order_count
                brand[2] += refund_rate
                if len(batch) >= args.batch_size:
                    cur.executemany(
                        f"INSERT INTO ads_store_daily_operation ({STORE_DAILY_COLUMNS}) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                        batch,
                    )
                    batch.clear()
        if batch:
            cur.executemany(
                f"INSERT INTO ads_store_daily_operation ({STORE_DAILY_COLUMNS}) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                batch,
            )
        region_rows = [(day, province, round(v[0], 2), v[1], v[2], round(v[3] / v[2], 4)) for (day, province), v in region_totals.items()]
        brand_rows = [(day, round(v[0], 2), v[1], args.stores, round(v[0] / v[1], 2), round(v[2] / args.stores, 4)) for day, v in brand_totals.items()]
        cur.executemany(
            "INSERT INTO ads_region_daily_operation "
            "(metric_date, province, gmv, order_count, store_count, refund_rate) VALUES (%s,%s,%s,%s,%s,%s)",
            region_rows,
        )
        cur.executemany(
            "INSERT INTO ads_brand_daily_operation "
            "(metric_date, gmv, order_count, active_store_count, avg_order_value, refund_rate) "
            "VALUES (%s,%s,%s,%s,%s,%s)",
            brand_rows,
        )
    conn.close()


def parse_args():
    parser = argparse.ArgumentParser(description="生成塔斯汀门店订单及 ADS 演示数据")
    parser.add_argument("--stores", type=int, default=12000)
    parser.add_argument("--orders", type=int, default=1_000_000)
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--seed", type=int, default=20260809)
    parser.add_argument("--batch-size", type=int, default=5000)
    parser.add_argument("--reset", action="store_true")
    return parser.parse_args()


def main():
    args = parse_args()
    rng = random.Random(args.seed)
    seed_mysql(args, rng)
    seed_starrocks(args, rng)
    print("演示数据生成完成")


if __name__ == "__main__":
    main()
