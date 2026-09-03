#!/usr/bin/env bash
set -euo pipefail

export MYSQL_PWD="${STARROCKS_PASSWORD}"

sr_mysql=(
    mysql --protocol=tcp --host=starrocks --port=9030
    --user="${STARROCKS_USER}"
    --batch --skip-column-names
)

"${sr_mysql[@]}" < /opt/flink-food-lab/starrocks/schema.sql

wait_for_schema_change() {
    local table_name="$1"
    local state=""
    local attempt=0

    while (( attempt < 120 )); do
        state=$("${sr_mysql[@]}" --execute="
            SHOW ALTER TABLE COLUMN FROM flink_food_lab_warehouse
            WHERE TableName = '${table_name}'
            ORDER BY CreateTime DESC LIMIT 1;" | cut -f10)
        case "${state}" in
            FINISHED) return 0 ;;
            CANCELLED) echo "Schema migration for ${table_name} was cancelled" >&2; return 1 ;;
        esac
        attempt=$((attempt + 1))
        sleep 1
    done

    echo "Timed out waiting for schema migration on ${table_name} (state=${state})" >&2
    return 1
}

ensure_nullable() {
    local table_name="$1"
    local column_names="$2"
    local alter_clauses="$3"
    local non_nullable

    non_nullable=$("${sr_mysql[@]}" --execute="
        SELECT COUNT(*)
        FROM information_schema.columns
        WHERE TABLE_SCHEMA = 'flink_food_lab_warehouse'
          AND TABLE_NAME = '${table_name}'
          AND COLUMN_NAME IN (${column_names})
          AND IS_NULLABLE = 'NO';")

    if [[ "${non_nullable}" != "0" ]]; then
        "${sr_mysql[@]}" --execute="ALTER TABLE flink_food_lab_warehouse.${table_name} ${alter_clauses};"
        wait_for_schema_change "${table_name}"
    fi
}

# Retraction records contain only primary-key columns. All non-key columns in
# tables receiving a changelog therefore need to be nullable. These checks
# make an existing, non-empty learning volume converge without dropping data.
ensure_nullable dwd_order_current \
    "'run_id','order_no','store_id','channel','amount','status','event_time','processed_at'" \
    "MODIFY COLUMN run_id VARCHAR(64) NULL,
     MODIFY COLUMN order_no VARCHAR(40) NULL,
     MODIFY COLUMN store_id VARCHAR(16) NULL,
     MODIFY COLUMN channel VARCHAR(16) NULL,
     MODIFY COLUMN amount DECIMAL(12,2) NULL,
     MODIFY COLUMN status VARCHAR(20) NULL,
     MODIFY COLUMN event_time DATETIME NULL,
     MODIFY COLUMN processed_at DATETIME NULL"

ensure_nullable dws_store_metrics \
    "'order_count','revenue','average_ticket','updated_at'" \
    "MODIFY COLUMN order_count BIGINT NULL,
     MODIFY COLUMN revenue DECIMAL(18,2) NULL,
     MODIFY COLUMN average_ticket DECIMAL(18,2) NULL,
     MODIFY COLUMN updated_at DATETIME NULL"

ensure_nullable dws_minute_metrics \
    "'order_count','revenue','updated_at'" \
    "MODIFY COLUMN order_count BIGINT NULL,
     MODIFY COLUMN revenue DECIMAL(18,2) NULL,
     MODIFY COLUMN updated_at DATETIME NULL"

ensure_nullable ads_run_metrics \
    "'order_count','revenue','average_ticket','latest_processed_at'" \
    "MODIFY COLUMN order_count BIGINT NULL,
     MODIFY COLUMN revenue DECIMAL(18,2) NULL,
     MODIFY COLUMN average_ticket DECIMAL(18,2) NULL,
     MODIFY COLUMN latest_processed_at DATETIME NULL"
