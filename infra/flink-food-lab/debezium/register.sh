#!/bin/sh
set -eu

config=$(printf '%s' "{
    \"connector.class\": \"io.debezium.connector.mysql.MySqlConnector\",
    \"tasks.max\": \"1\",
    \"database.hostname\": \"mysql\",
    \"database.port\": \"3306\",
    \"database.user\": \"${FLINK_LAB_MYSQL_CDC_USER}\",
    \"database.password\": \"${FLINK_LAB_MYSQL_CDC_PASSWORD}\",
    \"database.server.id\": \"1849\",
    \"topic.prefix\": \"flink-food-lab\",
    \"database.include.list\": \"${FLINK_LAB_MYSQL_DATABASE}\",
    \"table.include.list\": \"${FLINK_LAB_MYSQL_DATABASE}.orders\",
    \"schema.history.internal.kafka.bootstrap.servers\": \"kafka:29092\",
    \"schema.history.internal.kafka.topic\": \"flink-food-lab-schema-history\",
    \"snapshot.mode\": \"initial\",
    \"include.schema.changes\": \"false\",
    \"decimal.handling.mode\": \"string\",
    \"time.precision.mode\": \"connect\",
    \"tombstones.on.delete\": \"false\",
    \"topic.creation.enable\": \"false\",
    \"topic.creation.default.replication.factor\": \"1\",
    \"topic.creation.default.partitions\": \"3\",
    \"transforms\": \"route\",
    \"transforms.route.type\": \"org.apache.kafka.connect.transforms.RegexRouter\",
    \"transforms.route.regex\": \".*\",
    \"transforms.route.replacement\": \"flink-food-lab-orders-cdc\"
}")
payload=$(printf '{"name":"flink-food-lab-orders","config":%s}' "${config}")

status=$(curl --silent --output /tmp/connector.json --write-out '%{http_code}' \
    -H 'Content-Type: application/json' \
    -X POST "${CONNECT_URL}/connectors" \
    --data "${payload}")

if [ "${status}" = "409" ]; then
    curl --fail --silent -H 'Content-Type: application/json' \
        -X PUT "${CONNECT_URL}/connectors/flink-food-lab-orders/config" \
        --data "${config}" >/dev/null
elif [ "${status}" -lt 200 ] || [ "${status}" -ge 300 ]; then
    cat /tmp/connector.json
    exit 1
fi

attempt=0
while [ "${attempt}" -lt 30 ]; do
    connector_status=$(curl --fail --silent "${CONNECT_URL}/connectors/flink-food-lab-orders/status" || true)
    if printf '%s' "${connector_status}" | grep -q '"connector":{"state":"RUNNING"' \
        && printf '%s' "${connector_status}" | grep -q '"tasks":\[{"id":0,"state":"RUNNING"'; then
        printf '%s\n' "${connector_status}"
        exit 0
    fi
    attempt=$((attempt + 1))
    sleep 1
done

printf '%s\n' "${connector_status}"
exit 1
