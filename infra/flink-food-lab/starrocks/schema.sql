CREATE DATABASE IF NOT EXISTS flink_food_lab_warehouse;
USE flink_food_lab_warehouse;

CREATE TABLE IF NOT EXISTS ods_order_events (
    event_date DATE NOT NULL,
    topic_partition INT NOT NULL,
    topic_offset BIGINT NOT NULL,
    op VARCHAR(4) NULL,
    order_id VARCHAR(80) NULL,
    run_id VARCHAR(64) NULL,
    source_ts BIGINT NULL,
    kafka_ts DATETIME NULL,
    processed_at DATETIME NULL,
    latency_ms BIGINT NULL,
    payload STRING NULL
) ENGINE=OLAP
PRIMARY KEY (event_date, topic_partition, topic_offset)
DISTRIBUTED BY HASH(topic_partition) BUCKETS 3
PROPERTIES ("replication_num"="1");

CREATE TABLE IF NOT EXISTS dwd_order_current (
    order_id VARCHAR(80) NOT NULL,
    run_id VARCHAR(64) NULL,
    order_no VARCHAR(40) NULL,
    store_id VARCHAR(16) NULL,
    channel VARCHAR(16) NULL,
    items STRING NULL,
    amount DECIMAL(12,2) NULL,
    status VARCHAR(20) NULL,
    event_time DATETIME NULL,
    processed_at DATETIME NULL
) ENGINE=OLAP
PRIMARY KEY (order_id)
DISTRIBUTED BY HASH(order_id) BUCKETS 3
PROPERTIES ("replication_num"="1");

CREATE TABLE IF NOT EXISTS dws_store_metrics (
    run_id VARCHAR(64) NOT NULL,
    store_id VARCHAR(16) NOT NULL,
    order_count BIGINT NULL,
    revenue DECIMAL(18,2) NULL,
    average_ticket DECIMAL(18,2) NULL,
    updated_at DATETIME NULL
) ENGINE=OLAP
PRIMARY KEY (run_id, store_id)
DISTRIBUTED BY HASH(run_id, store_id) BUCKETS 3
PROPERTIES ("replication_num"="1");

CREATE TABLE IF NOT EXISTS dws_minute_metrics (
    run_id VARCHAR(64) NOT NULL,
    metric_minute VARCHAR(20) NOT NULL,
    order_count BIGINT NULL,
    revenue DECIMAL(18,2) NULL,
    updated_at DATETIME NULL
) ENGINE=OLAP
PRIMARY KEY (run_id, metric_minute)
DISTRIBUTED BY HASH(run_id, metric_minute) BUCKETS 3
PROPERTIES ("replication_num"="1");

CREATE TABLE IF NOT EXISTS ads_run_metrics (
    run_id VARCHAR(64) NOT NULL,
    order_count BIGINT NULL,
    revenue DECIMAL(18,2) NULL,
    average_ticket DECIMAL(18,2) NULL,
    latest_processed_at DATETIME NULL
) ENGINE=OLAP
PRIMARY KEY (run_id)
DISTRIBUTED BY HASH(run_id) BUCKETS 3
PROPERTIES ("replication_num"="1");
