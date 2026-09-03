# Flink Food Lab infrastructure

This directory is an isolated addition to the `zev-own-abnormal` Compose project. It creates only the
`flink_food_lab` MySQL database, the `flink-food-lab-*` Kafka topics, the five
`flink_food_lab_warehouse` StarRocks tables, and the Flink/Debezium services named `flink-*` or
`debezium-*`. Existing Sentinel and DolphinScheduler data is never truncated or removed.

Use the learning application's `scripts/start.ps1` and `scripts/stop.ps1`; do not use `docker compose down -v`.

