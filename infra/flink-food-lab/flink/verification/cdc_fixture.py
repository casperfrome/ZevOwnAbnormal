"""Isolated, repeatable CDC fixture for the Java and SQL Flink 2.3 graphs.

Use D:/PythonVenv/Scripts/python.exe. No command writes to MySQL or resets
existing resources. All generated manifests/reports live in ./target/.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import re
import sys
import time
from datetime import datetime, timezone
from decimal import Decimal

SHOPS = ("T01", "T02", "S01", "S02")
PHASES = ("seed", "mutations", "advance", "expired", "late")
TABLES = ("flink_test_260904", "flink_test_260904_recent_5m")
BASE_MS = 1_788_566_400_000  # 2026-09-05T00:00:00Z, aligned to five seconds.
TARGET = Path(__file__).resolve().parent / "target"


def validate_namespace(topic: str, database: str) -> None:
    if not re.fullmatch(r"flink23-test-[A-Za-z0-9][A-Za-z0-9._-]{0,150}", topic):
        raise ValueError("Topic must start flink23-test- and contain only safe Kafka name characters.")
    if not re.fullmatch(r"flink23_test_[A-Za-z0-9][A-Za-z0-9_]{0,100}", database):
        raise ValueError("Database must start flink23_test_ and contain only SQL identifier characters.")


def timestamp(epoch_ms: int) -> str:
    return datetime.fromtimestamp(epoch_ms / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def epoch_ms(value: str) -> int:
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def fixture() -> list[dict]:
    phases = [{"name": name, "events": []} for name in PHASES]
    position = 100

    def row(order_id: int, shop: str, amount: str, seconds: int = 0) -> dict:
        return {"order_id": order_id, "shop_id": shop, "amount": amount,
                "created_at": timestamp(BASE_MS + seconds * 1000 + 123)}

    def emit(phase: int, operation: str, before: dict | None, after: dict | None) -> dict:
        nonlocal position
        position += 10
        event = {"before": before, "after": after, "op": operation,
                 "source": {"version": "3.0.0", "connector": "mysql", "name": "flink23-fixture",
                            "server_id": 230904, "file": "mysql-bin.000023", "pos": position, "row": 0,
                            "db": "fixture_only", "table": "fake_data_260904", "snapshot": "false"},
                 "ts_ms": BASE_MS + position}
        phases[phase]["events"].append(event)
        return event

    one, two, three, four, five, six = (
        row(1, "T01", "10.00"), row(2, "T02", "8.00"), row(3, "S01", "12.00"),
        row(4, "S02", "6.50"), row(5, "T01", "5.00"), row(6, "T02", "7.00"))
    first = emit(0, "c", None, one)
    phases[0]["events"].append(copy.deepcopy(first))
    emit(0, "r", None, two)
    emit(0, "c", None, three)
    emit(0, "c", None, four)
    emit(0, "c", None, five)
    emit(0, "c", None, six)
    changed_one = row(1, "T01", "11.25")
    same_shop = emit(1, "u", one, changed_one)
    phases[1]["events"].append(copy.deepcopy(same_shop))
    emit(1, "u", two, row(2, "S01", "9.50"))
    deleted = emit(1, "d", three, None)
    phases[1]["events"].append(copy.deepcopy(deleted))
    emit(2, "c", None, row(7, "S02", "6.00", 20))
    # A create/delete pair contributes zero but instantiates otherwise empty
    # global windows. A bare 20 -> 330 time jump creates no window [25,325).
    temporary = row(9, "T02", "5.50", 300)
    emit(3, "c", None, temporary)
    emit(3, "d", temporary, None)
    emit(3, "c", None, row(8, "T01", "5.50", 330))
    # Deliver this phase only after expired assertions: watermark is beyond
    # every window of this timestamp. Cumulative must still accept the order.
    emit(4, "c", None, row(10, "S01", "5.75", 0))
    return phases


def expected_state(phases: list[dict], completed: int) -> dict:
    orders, fingerprints = {}, {}
    maximum = 0
    for phase in phases[:completed]:
        for event in phase["events"]:
            snapshot = event["before"] if event["op"] == "d" else event["after"]
            maximum = max(maximum, epoch_ms(snapshot["created_at"]))
            key = str(snapshot["order_id"])
            source = event["source"]
            fingerprint = (source["server_id"], source["file"], source["pos"], source["row"])
            if fingerprints.get(key) == fingerprint:
                continue
            if event["op"] in ("u", "d") and orders.get(key) != event["before"]:
                raise AssertionError(f"Fixture before image does not match order {key}")
            if event["op"] == "d":
                del orders[key]
            else:
                orders[key] = copy.deepcopy(event["after"])
            fingerprints[key] = fingerprint
    cumulative = {shop: Decimal("0.00") for shop in SHOPS}
    for order in orders.values():
        cumulative[order["shop_id"]] += Decimal(order["amount"])
    # Bounded-out-of-orderness generator emits maxTimestamp - 5000 - 1.
    # A TimeWindow fires at end - 1, so this is the latest possible closed end.
    end = ((maximum - 5000) // 5000) * 5000 if maximum else 0
    return {"orders": list(orders.values()), "cumulative": {k: str(v) for k, v in cumulative.items()},
            "max_event_timestamp_ms": maximum, "latest_window_start_ms": end - 300_000,
            "latest_window_end_ms": end}


def window_values(orders: list[dict], start: int, end: int) -> dict:
    values = {shop: {"order_count": 0, "total_amount": Decimal("0.00")} for shop in SHOPS}
    for order in orders:
        if start <= epoch_ms(order["created_at"]) < end:
            value = values[order["shop_id"]]
            value["order_count"] += 1
            value["total_amount"] += Decimal(order["amount"])
    return values


def manifest_path(args) -> Path:
    return TARGET / f"{args.database}--{args.topic}.json"


def save(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def read_manifest(args) -> dict:
    path = manifest_path(args)
    data = json.loads(path.read_text(encoding="utf-8"))
    if (data["topic"], data["database"]) != (args.topic, args.database):
        raise ValueError("Manifest does not match the requested resource namespace.")
    if data["status"] != "ready":
        raise ValueError(f"Fixture status={data['status']}; use a fresh namespace after uncertain preparation/publication.")
    return data


def starrocks_connection(args):
    import pymysql
    host, separator, port = args.starrocks.rpartition(":")
    if not separator or not host or not port.isdigit():
        raise ValueError("--starrocks must be host:port")
    return pymysql.connect(host=host, port=int(port), user=args.username, password=args.password,
                           autocommit=True, charset="utf8mb4", connect_timeout=10,
                           read_timeout=15, write_timeout=15, cursorclass=pymysql.cursors.DictCursor)


def prepare(args) -> None:
    from confluent_kafka.admin import AdminClient, NewTopic
    path = manifest_path(args)
    if path.exists():
        raise ValueError(f"Manifest already exists: {path}; refusing to reset resources.")
    admin = AdminClient({"bootstrap.servers": args.bootstrap, "allow.auto.create.topics": False})
    existing = admin.list_topics(timeout=15).topics
    if args.topic in existing:
        raise ValueError("Kafka topic already exists; refusing to reuse or clear it.")
    connection = starrocks_connection(args)
    with connection:
        with connection.cursor() as cursor:
            cursor.execute("SHOW DATABASES")
            databases = {next(iter(row.values())) for row in cursor.fetchall()}
            if args.database in databases:
                raise ValueError("StarRocks database already exists; refusing to reuse or clear it.")
            data = {"version": 1, "status": "preparing", "topic": args.topic, "database": args.database,
                    "bootstrap": args.bootstrap, "starrocks": args.starrocks, "completed_phases": 0,
                    "base_timestamp_ms": BASE_MS, "phases": fixture(), "delivery_offsets": []}
            save(path, data)
            admin.create_topics([NewTopic(args.topic, num_partitions=1, replication_factor=1)],
                                request_timeout=15)[args.topic].result(timeout=20)
            cursor.execute(f"CREATE DATABASE `{args.database}`")
            cursor.execute(f"""CREATE TABLE `{args.database}`.`{TABLES[0]}` (
                shop_id VARCHAR(3) NOT NULL, total_revenue DECIMAL(18,2) NOT NULL
            ) ENGINE=OLAP PRIMARY KEY(shop_id) DISTRIBUTED BY HASH(shop_id) BUCKETS 1
            PROPERTIES ('replication_num'='1')""")
            cursor.execute(f"""CREATE TABLE `{args.database}`.`{TABLES[1]}` (
                shop_id VARCHAR(3) NOT NULL, window_start_ms BIGINT NOT NULL, window_end_ms BIGINT NOT NULL,
                order_count BIGINT NOT NULL, total_amount DECIMAL(18,2) NOT NULL
            ) ENGINE=OLAP PRIMARY KEY(shop_id) DISTRIBUTED BY HASH(shop_id) BUCKETS 1
            PROPERTIES ('replication_num'='1')""")
            data["status"] = "ready"
            data["expected"] = expected_state(data["phases"], 0)
            save(path, data)
    print(f"PREPARED {args.topic} and {args.database}; start the isolated Flink job before producing.\nManifest: {path}")


def produce(args) -> None:
    from confluent_kafka import Producer
    from confluent_kafka.admin import AdminClient
    data = read_manifest(args)
    admin = AdminClient({"bootstrap.servers": args.bootstrap, "allow.auto.create.topics": False})
    topics = admin.list_topics(timeout=15).topics
    if args.topic not in topics or len(topics[args.topic].partitions) != 1:
        raise ValueError("Prepared single-partition fixture topic is missing or was changed.")
    producer = Producer({"bootstrap.servers": args.bootstrap, "enable.idempotence": True,
                         "acks": "all", "message.timeout.ms": 15000})
    stop = PHASES.index(args.through_phase) + 1
    if stop <= data["completed_phases"]:
        print("No new phases; all requested events were already acknowledged.")
        return
    for index in range(data["completed_phases"], stop):
        phase = data["phases"][index]
        data["status"] = "producing"
        data["in_progress_phase"] = phase["name"]
        save(manifest_path(args), data)
        errors, offsets = [], []

        def delivered(error, message):
            if error:
                errors.append(str(error))
            else:
                offsets.append(message.offset())

        for event in phase["events"]:
            snapshot = event["after"] or event["before"]
            producer.produce(args.topic, partition=0, key=str(snapshot["order_id"]).encode(),
                             value=json.dumps(event, separators=(",", ":")).encode(), on_delivery=delivered)
            producer.poll(0)
        remaining = producer.flush(20)
        if errors or remaining or len(offsets) != len(phase["events"]):
            raise RuntimeError(f"Uncertain publication in phase {phase['name']}: {errors}, remaining={remaining}; use fresh resources.")
        data["delivery_offsets"].append({"phase": phase["name"], "offsets": offsets})
        data["completed_phases"] = index + 1
        data["status"] = "ready"
        data.pop("in_progress_phase", None)
        data["expected"] = expected_state(data["phases"], index + 1)
        save(manifest_path(args), data)
        print(f"PRODUCED {phase['name']}: {len(offsets)} events, offsets={offsets}")
        time.sleep(args.phase_gap)
    print(json.dumps(data["expected"], ensure_ascii=False, indent=2))


def compare(data: dict, cumulative: list[dict], recent: list[dict]) -> dict:
    expected = data["expected"]
    if len(cumulative) != 4 or {row["shop_id"] for row in cumulative} != set(SHOPS):
        raise AssertionError(f"Expected four cumulative shops; got {cumulative}")
    if len(recent) != 4 or {row["shop_id"] for row in recent} != set(SHOPS):
        raise AssertionError(f"Expected four window shops; got {recent}")
    for row in cumulative:
        actual = Decimal(str(row["total_revenue"]))
        target = Decimal(expected["cumulative"][row["shop_id"]])
        if actual != target:
            raise AssertionError(f"{row['shop_id']} cumulative {actual} != {target}")
    boundaries = {(row["window_start_ms"], row["window_end_ms"]) for row in recent}
    target_boundary = (expected["latest_window_start_ms"], expected["latest_window_end_ms"])
    if boundaries != {target_boundary}:
        raise AssertionError(f"Expected all shops at latest window {target_boundary}; got {boundaries}")
    values = window_values(expected["orders"], *target_boundary)
    for row in recent:
        target = values[row["shop_id"]]
        if row["order_count"] != target["order_count"] or Decimal(str(row["total_amount"])) != target["total_amount"]:
            raise AssertionError(f"{row['shop_id']} window mismatch: actual={row}, expected={target}")
    return {"result": "PASS", "topic": data["topic"], "database": data["database"],
            "completed_phases": data["completed_phases"], "window": target_boundary,
            "cumulative": cumulative, "recent": recent, "expected_window": values}


def assert_results(args) -> None:
    data = read_manifest(args)
    if data["completed_phases"] < 3:
        raise ValueError("Produce through advance or expired before asserting closed windows.")
    deadline = time.monotonic() + args.timeout
    last_failure = "No query attempted"
    while True:
        try:
            with starrocks_connection(args) as connection:
                with connection.cursor() as cursor:
                    cursor.execute(f"SELECT * FROM `{args.database}`.`{TABLES[0]}` ORDER BY shop_id")
                    cumulative = cursor.fetchall()
                    cursor.execute(f"SELECT * FROM `{args.database}`.`{TABLES[1]}` ORDER BY shop_id")
                    recent = cursor.fetchall()
            report = compare(data, cumulative, recent)
            path = TARGET / f"{args.database}--phase-{PHASES[data['completed_phases'] - 1]}--report.json"
            save(path, report)
            print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
            print(f"Report: {path}")
            return
        except (AssertionError, OSError) as error:
            last_failure = str(error)
        if time.monotonic() >= deadline:
            raise AssertionError(f"Timed out after {args.timeout}s: {last_failure}")
        time.sleep(1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "produce", "assert"))
    parser.add_argument("--topic", required=True)
    parser.add_argument("--database", required=True)
    parser.add_argument("--bootstrap", default="localhost:9092")
    parser.add_argument("--starrocks", default="localhost:9030")
    parser.add_argument("--username", default="root")
    parser.add_argument("--password", default="")
    parser.add_argument("--through-phase", choices=PHASES, default="expired")
    parser.add_argument("--phase-gap", type=float, default=1.0)
    parser.add_argument("--timeout", type=float, default=90.0)
    args = parser.parse_args()
    validate_namespace(args.topic, args.database)
    if args.phase_gap < 1 or args.timeout < 0:
        parser.error("--phase-gap must be at least 1 second; --timeout must be nonnegative.")
    {"prepare": prepare, "produce": produce, "assert": assert_results}[args.command](args)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FAIL: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
