#!/usr/bin/env bash
set -euo pipefail

running_jobs=$(curl --fail --silent http://flink-jobmanager:8081/jobs/overview || true)
if echo "${running_jobs}" | grep -Eq '"name":"flink-food-lab-realtime-warehouse"[^}]*"state":"RUNNING"'; then
    echo "Flink Food Lab job is already running."
    exit 0
fi

savepoint=$(mysql --protocol=tcp --host=mysql --user=root --password="${MYSQL_ROOT_PASSWORD}" \
    --database="${FLINK_LAB_MYSQL_DATABASE}" --batch --skip-column-names \
    --execute="SELECT COALESCE(r.savepoint_path, '') FROM lab_runs r JOIN generator_state g ON g.run_id=r.id WHERE g.id=1" | tail -n 1)

prepared_sql=/tmp/flink-food-lab-pipeline.sql
submitted_job_id=""

prepare_sql() {
    local label_suffix topic database username password
    label_suffix="${FLINK_LAB_SINK_LABEL_SUFFIX:-$(date -u +%Y%m%d%H%M%S%N)-$$}"
    label_suffix=$(printf '%s' "${label_suffix}" | tr -cd '[:alnum:]_-')
    topic=$(printf '%s' "${FLINK_LAB_KAFKA_TOPIC}" | sed -e "s/'/''/g" -e 's/[\\&|]/\\&/g')
    database=$(printf '%s' "${FLINK_LAB_STARROCKS_DATABASE}" | sed -e "s/'/''/g" -e 's/[\\&|]/\\&/g')
    username=$(printf '%s' "${STARROCKS_USER}" | sed -e "s/'/''/g" -e 's/[\\&|]/\\&/g')
    password=$(printf '%s' "${STARROCKS_PASSWORD}" | sed -e "s/'/''/g" -e 's/[\\&|]/\\&/g')
    sed \
        -e "s|__SINK_LABEL_SUFFIX__|${label_suffix}|g" \
        -e "s|__KAFKA_TOPIC__|${topic}|g" \
        -e "s|__STARROCKS_DATABASE__|${database}|g" \
        -e "s|__STARROCKS_USER__|${username}|g" \
        -e "s|__STARROCKS_PASSWORD__|${password}|g" \
        /opt/flink/sql/pipeline.sql > "${prepared_sql}"
}

wait_for_healthy_job() {
    local job_id="$1"
    local attempt=0
    local job_status=""
    local checkpoints=""

    while (( attempt < 120 )); do
        job_status=$(curl --fail --silent "http://flink-jobmanager:8081/jobs/${job_id}" || true)
        if echo "${job_status}" | grep -q '"state":"RUNNING"'; then
            checkpoints=$(curl --fail --silent "http://flink-jobmanager:8081/jobs/${job_id}/checkpoints" || true)
            if echo "${checkpoints}" | grep -Eq '"completed":[1-9][0-9]*'; then
                mysql --protocol=tcp --host=mysql --user=root --password="${MYSQL_ROOT_PASSWORD}" \
                    --database="${FLINK_LAB_MYSQL_DATABASE}" \
                    --execute="UPDATE lab_runs r JOIN generator_state g ON g.run_id=r.id SET r.status='ACTIVE' WHERE g.id=1"
                echo "Flink Food Lab job ${job_id} is RUNNING and completed a checkpoint."
                return 0
            fi
        elif echo "${job_status}" | grep -Eq '"state":"(FAILED|CANCELED|FINISHED)"'; then
            echo "Flink Food Lab job ${job_id} entered a terminal state." >&2
            return 1
        fi
        attempt=$((attempt + 1))
        sleep 1
    done

    echo "Flink Food Lab job ${job_id} did not complete a checkpoint within 120 seconds." >&2
    return 1
}

submit() {
    local log_file=/tmp/flink-food-lab-submit.log
    prepare_sql
    set +e
    /opt/flink/bin/sql-client.sh -Dexecution.target=remote -Drest.address=flink-jobmanager "$@" -f "${prepared_sql}" 2>&1 | tee "${log_file}"
    local sql_client_status=${PIPESTATUS[0]}
    set -e
    if [ "${sql_client_status}" -ne 0 ] || grep -q '\[ERROR\]' "${log_file}"; then
        return 1
    fi
    submitted_job_id=$(sed -n 's/^Job ID: //p' "${log_file}" | tail -n 1 | tr -d '\r')
    if [ -z "${submitted_job_id}" ]; then
        echo "Flink SQL Client did not return a Job ID." >&2
        return 1
    fi
    wait_for_healthy_job "${submitted_job_id}"
}
if [ -n "${savepoint}" ]; then
    savepoint_path=${savepoint#file:}
    if [ "${savepoint_path}" != "${savepoint}" ] && [ ! -e "${savepoint_path}" ]; then
        echo "Recorded savepoint is absent from the persistent volume; rebuilding only Flink Food Lab tables."
        mysql --protocol=tcp --host=mysql --user=root --password="${MYSQL_ROOT_PASSWORD}" \
            --database="${FLINK_LAB_MYSQL_DATABASE}" \
            --execute="UPDATE lab_runs r JOIN generator_state g ON g.run_id=r.id SET r.status='REBUILDING', r.savepoint_path=NULL WHERE g.id=1"
        for table in ods_order_events dwd_order_current dws_store_metrics dws_minute_metrics ads_run_metrics; do
            mysql --protocol=tcp --host=starrocks --port=9030 --user="${STARROCKS_USER}" --password="${STARROCKS_PASSWORD}" \
                --database="${FLINK_LAB_STARROCKS_DATABASE}" --execute="TRUNCATE TABLE ${table}"
        done
    else
        if submit -Dexecution.state-recovery.path="${savepoint}"; then
            exit 0
        fi
        if [ -n "${submitted_job_id}" ]; then
            curl --fail --silent --request PATCH "http://flink-jobmanager:8081/jobs/${submitted_job_id}?mode=cancel" >/dev/null || true
        fi
        echo "Savepoint restore failed while the savepoint still exists; warehouse data was preserved. Use the confirmed rebuild API after diagnosis." >&2
        exit 1
    fi
fi

submit
