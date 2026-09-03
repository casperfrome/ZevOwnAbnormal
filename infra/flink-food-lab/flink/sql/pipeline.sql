SET 'execution.runtime-mode' = 'streaming';
SET 'execution.checkpointing.interval' = '5s';
SET 'execution.checkpointing.mode' = 'EXACTLY_ONCE';
SET 'execution.checkpointing.externalized-checkpoint-retention' = 'RETAIN_ON_CANCELLATION';
SET 'table.local-time-zone' = 'Asia/Shanghai';
SET 'table.dml-sync' = 'false';
SET 'pipeline.name' = 'flink-food-lab-realtime-warehouse';
SET 'parallelism.default' = '3';

CREATE TABLE orders_raw (
    payload STRING,
    kafka_partition INT METADATA FROM 'partition' VIRTUAL,
    kafka_offset BIGINT METADATA FROM 'offset' VIRTUAL,
    kafka_timestamp TIMESTAMP_LTZ(3) METADATA FROM 'timestamp' VIRTUAL
) WITH (
    'connector' = 'kafka',
    'topic' = '__KAFKA_TOPIC__',
    'properties.bootstrap.servers' = 'kafka:29092',
    'properties.group.id' = 'flink-food-lab-ods-v1',
    'scan.startup.mode' = 'earliest-offset',
    'value.format' = 'raw',
    'value.raw.charset' = 'UTF-8'
);

CREATE TABLE orders_cdc (
    id STRING,
    run_id STRING,
    order_no STRING,
    store_id STRING,
    channel STRING,
    items STRING,
    amount DECIMAL(12, 2),
    status STRING,
    event_time BIGINT,
    created_at STRING,
    updated_at STRING,
    PRIMARY KEY (id) NOT ENFORCED
) WITH (
    'connector' = 'kafka',
    'topic' = '__KAFKA_TOPIC__',
    'properties.bootstrap.servers' = 'kafka:29092',
    'properties.group.id' = 'flink-food-lab-current-v1',
    'scan.startup.mode' = 'earliest-offset',
    'value.format' = 'debezium-json',
    'value.debezium-json.ignore-parse-errors' = 'false'
);

CREATE TABLE ods_order_events (
    event_date DATE,
    topic_partition INT,
    topic_offset BIGINT,
    op STRING,
    order_id STRING,
    run_id STRING,
    source_ts BIGINT,
    kafka_ts TIMESTAMP(3),
    processed_at TIMESTAMP(3),
    latency_ms BIGINT,
    payload STRING,
    PRIMARY KEY (event_date, topic_partition, topic_offset) NOT ENFORCED
) WITH (
    'connector' = 'starrocks',
    'jdbc-url' = 'jdbc:mysql://starrocks:9030',
    'load-url' = 'starrocks:8030',
    'database-name' = '__STARROCKS_DATABASE__',
    'table-name' = 'ods_order_events',
    'username' = '__STARROCKS_USER__',
    'password' = '__STARROCKS_PASSWORD__',
    'sink.semantic' = 'exactly-once',
    'sink.label-prefix' = 'flink_food_lab_ods_v1___SINK_LABEL_SUFFIX__'
);

CREATE TABLE dwd_order_current (
    order_id STRING,
    run_id STRING,
    order_no STRING,
    store_id STRING,
    channel STRING,
    items STRING,
    amount DECIMAL(12, 2),
    status STRING,
    event_time TIMESTAMP(3),
    processed_at TIMESTAMP(3),
    PRIMARY KEY (order_id) NOT ENFORCED
) WITH (
    'connector' = 'starrocks',
    'jdbc-url' = 'jdbc:mysql://starrocks:9030',
    'load-url' = 'starrocks:8030',
    'database-name' = '__STARROCKS_DATABASE__',
    'table-name' = 'dwd_order_current',
    'username' = '__STARROCKS_USER__',
    'password' = '__STARROCKS_PASSWORD__',
    'sink.semantic' = 'exactly-once',
    'sink.label-prefix' = 'flink_food_lab_dwd_v1___SINK_LABEL_SUFFIX__'
);

CREATE TABLE dws_store_metrics (
    run_id STRING,
    store_id STRING,
    order_count BIGINT,
    revenue DECIMAL(18, 2),
    average_ticket DECIMAL(18, 2),
    updated_at TIMESTAMP(3),
    PRIMARY KEY (run_id, store_id) NOT ENFORCED
) WITH (
    'connector' = 'starrocks',
    'jdbc-url' = 'jdbc:mysql://starrocks:9030',
    'load-url' = 'starrocks:8030',
    'database-name' = '__STARROCKS_DATABASE__',
    'table-name' = 'dws_store_metrics',
    'username' = '__STARROCKS_USER__',
    'password' = '__STARROCKS_PASSWORD__',
    'sink.semantic' = 'exactly-once',
    'sink.label-prefix' = 'flink_food_lab_dws_store_v1___SINK_LABEL_SUFFIX__'
);

CREATE TABLE dws_minute_metrics (
    run_id STRING,
    metric_minute STRING,
    order_count BIGINT,
    revenue DECIMAL(18, 2),
    updated_at TIMESTAMP(3),
    PRIMARY KEY (run_id, metric_minute) NOT ENFORCED
) WITH (
    'connector' = 'starrocks',
    'jdbc-url' = 'jdbc:mysql://starrocks:9030',
    'load-url' = 'starrocks:8030',
    'database-name' = '__STARROCKS_DATABASE__',
    'table-name' = 'dws_minute_metrics',
    'username' = '__STARROCKS_USER__',
    'password' = '__STARROCKS_PASSWORD__',
    'sink.semantic' = 'exactly-once',
    'sink.label-prefix' = 'flink_food_lab_dws_minute_v1___SINK_LABEL_SUFFIX__'
);

CREATE TABLE ads_run_metrics (
    run_id STRING,
    order_count BIGINT,
    revenue DECIMAL(18, 2),
    average_ticket DECIMAL(18, 2),
    latest_processed_at TIMESTAMP(3),
    PRIMARY KEY (run_id) NOT ENFORCED
) WITH (
    'connector' = 'starrocks',
    'jdbc-url' = 'jdbc:mysql://starrocks:9030',
    'load-url' = 'starrocks:8030',
    'database-name' = '__STARROCKS_DATABASE__',
    'table-name' = 'ads_run_metrics',
    'username' = '__STARROCKS_USER__',
    'password' = '__STARROCKS_PASSWORD__',
    'sink.semantic' = 'exactly-once',
    'sink.label-prefix' = 'flink_food_lab_ads_v1___SINK_LABEL_SUFFIX__'
);

EXECUTE STATEMENT SET
BEGIN
    INSERT INTO ods_order_events
    SELECT
        CAST(FROM_UNIXTIME(CAST(JSON_VALUE(payload, '$.ts_ms') AS BIGINT) / 1000) AS DATE),
        kafka_partition,
        kafka_offset,
        JSON_VALUE(payload, '$.op'),
        COALESCE(JSON_VALUE(payload, '$.after.id'), JSON_VALUE(payload, '$.before.id')),
        COALESCE(JSON_VALUE(payload, '$.after.run_id'), JSON_VALUE(payload, '$.before.run_id')),
        CAST(JSON_VALUE(payload, '$.ts_ms') AS BIGINT),
        CAST(kafka_timestamp AS TIMESTAMP(3)),
        LOCALTIMESTAMP,
        GREATEST(0, UNIX_TIMESTAMP() * 1000 - CAST(JSON_VALUE(payload, '$.ts_ms') AS BIGINT)),
        payload
    FROM orders_raw
    WHERE JSON_VALUE(payload, '$.op') IN ('c', 'u', 'd', 'r');

    INSERT INTO dwd_order_current
    SELECT id, run_id, order_no, store_id, COALESCE(channel, '未知'), items, amount, status,
           CAST(TO_TIMESTAMP_LTZ(event_time, 3) AS TIMESTAMP(3)), LOCALTIMESTAMP
    FROM orders_cdc;

    INSERT INTO dws_store_metrics
    SELECT
        run_id,
        store_id,
        COUNT(*),
        COALESCE(SUM(amount), CAST(0 AS DECIMAL(18, 2))),
        CASE WHEN COUNT(*) = 0 THEN CAST(0 AS DECIMAL(18, 2)) ELSE CAST(SUM(amount) / COUNT(*) AS DECIMAL(18, 2)) END,
        LOCALTIMESTAMP
    FROM orders_cdc
    WHERE status <> 'CANCELLED'
    GROUP BY run_id, store_id;

    INSERT INTO dws_minute_metrics
    SELECT
        run_id,
        DATE_FORMAT(CAST(TO_TIMESTAMP_LTZ(event_time, 3) AS TIMESTAMP(3)), 'yyyy-MM-dd HH:mm:00'),
        COUNT(*),
        COALESCE(SUM(amount), CAST(0 AS DECIMAL(18, 2))),
        LOCALTIMESTAMP
    FROM orders_cdc
    WHERE status <> 'CANCELLED'
    GROUP BY run_id, DATE_FORMAT(CAST(TO_TIMESTAMP_LTZ(event_time, 3) AS TIMESTAMP(3)), 'yyyy-MM-dd HH:mm:00');

    INSERT INTO ads_run_metrics
    SELECT
        run_id,
        COUNT(*),
        COALESCE(SUM(amount), CAST(0 AS DECIMAL(18, 2))),
        CASE WHEN COUNT(*) = 0 THEN CAST(0 AS DECIMAL(18, 2)) ELSE CAST(SUM(amount) / COUNT(*) AS DECIMAL(18, 2)) END,
        LOCALTIMESTAMP
    FROM orders_cdc
    WHERE status <> 'CANCELLED'
    GROUP BY run_id;
END;
