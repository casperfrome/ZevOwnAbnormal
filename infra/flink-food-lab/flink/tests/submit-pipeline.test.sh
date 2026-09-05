#!/usr/bin/env bash
# Run with Bash and jq. All external systems are replaced with local commands.
set -euo pipefail
script=$(cd "$(dirname "$0")/../scripts" && pwd)/submit-pipeline.sh
test_parent=$(cd "${TMPDIR:-/tmp}" && pwd -P)
test_root=$(mktemp -d "${test_parent}/flink-submit-test.XXXXXX")
test_root=$(cd "${test_root}" && pwd -P)
cleanup() {
    local code=$?
    if [ "$code" -ne 0 ] && [ -n "${CASE_LOG:-}" ]; then cat "${CASE_LOG}/output" >&2; fi
    # Verify the resolved recursive-delete target stays in this test's temp area.
    case "${test_root}" in
        "${test_parent}"/flink-submit-test.*) rm -rf -- "${test_root}" ;;
        *) echo 'Refusing cleanup outside the test temp directory' >&2 ;;
    esac
}
trap cleanup EXIT
export FLINK_HOME="${test_root}/flink"
mkdir -p "${test_root}/bin" "${FLINK_HOME}/bin" "${FLINK_HOME}/sql"
printf 'SELECT 1;\n' > "${FLINK_HOME}/sql/pipeline.sql"
cat > "${test_root}/bin/mysql" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
sql=""
for arg in "$@"; do case "$arg" in --execute=*) sql=${arg#--execute=};; esac; done
printf '%s\n' "$sql" >> "$CASE_LOG/mysql"
case "$sql" in
  *savepoint_path*) printf '%s\n' "$SAVEPOINT";;
  'SELECT r.status'*) printf '%s\n' "$RUN_STATUS";;
  'SELECT 1 FROM '*)
    [ "$WAREHOUSE_FAIL" = 0 ] || exit 7
    if [[ "$sql" == *"${NONEMPTY_TABLE}"* ]]; then printf '%s' "$WAREHOUSE_ROWS"; fi;;
  'UPDATE lab_runs '*) ;;
  *) printf 'Unexpected SQL\n' >&2; exit 2;;
esac
MOCK
cat > "${test_root}/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$CASE_LOG/curl"
case "$*" in
  */jobs/overview*) [ "$OVERVIEW_FAIL" = 0 ] || exit 7; printf '%s\n' "$JOBS";;
  *mode=cancel*) printf '{}' ;;
  */checkpoints*) printf '{"counts":{"completed":1}}';;
  *) printf '{"state":"%s"}\n' "$NEW_JOB_STATE";;
esac
MOCK
cat > "${FLINK_HOME}/bin/sql-client.sh" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CASE_LOG/submitted"
printf 'Job ID: new-submitted-job\n'
MOCK
chmod +x "${test_root}/bin/"* "${FLINK_HOME}/bin/sql-client.sh"
export PATH="${test_root}/bin:${PATH}"
export MYSQL_ROOT_PASSWORD='test-only' FLINK_LAB_MYSQL_DATABASE='test_lab'
export FLINK_LAB_STARROCKS_DATABASE='test_warehouse' STARROCKS_USER='test' STARROCKS_PASSWORD='test-only'
export FLINK_LAB_KAFKA_TOPIC='test-topic' FLINK_LAB_SINK_LABEL_SUFFIX='test'
passed=0
reset_case() {
    export CASE_LOG="${test_root}/case-$((passed + 1))"
    mkdir -p "$CASE_LOG"
    export SAVEPOINT='' RUN_STATUS='ACTIVE' WAREHOUSE_ROWS='' NONEMPTY_TABLE='' WAREHOUSE_FAIL=0
    export JOBS='{"jobs":[]}' OVERVIEW_FAIL=0 NEW_JOB_STATE='RUNNING'
}
run_script() {
    set +e
    bash "$script" > "$CASE_LOG/output" 2>&1
    result=$?
    set -e
}
assert_preserved() {
    if grep -Eq 'UPDATE|TRUNCATE|DELETE' "$CASE_LOG/mysql"; then
        echo 'FAIL: startup attempted a data or metadata mutation' >&2
        return 1
    fi
    [ ! -e "$CASE_LOG/submitted" ]
}
pass() { passed=$((passed + 1)); printf 'PASS: %s\n' "$1"; }
assert_no_match() {
    if grep -qE "$1" "$2"; then echo "FAIL: unexpected $1 in command log" >&2; return 1; fi
}

reset_case
export SAVEPOINT="file://${test_root}/absent-savepoint"
run_script
[ "$result" -ne 0 ]; assert_preserved
pass 'missing recorded savepoint preserves tables and metadata'

reset_case
export WAREHOUSE_ROWS=1
run_script
[ "$result" -ne 0 ]; assert_preserved
pass 'nonempty warehouse without state cannot silently replay'

reset_case
export WAREHOUSE_ROWS=1 NONEMPTY_TABLE='ads_run_metrics'
run_script
[ "$result" -ne 0 ]; assert_preserved
pass 'all five warehouse tables are checked before a fresh submission'

reset_case
export WAREHOUSE_FAIL=1
run_script
[ "$result" -ne 0 ]; assert_preserved
pass 'warehouse read failure does not get mistaken for an empty warehouse'

reset_case
run_script
[ "$result" -eq 0 ]; [ -f "$CASE_LOG/submitted" ]
assert_no_match 'TRUNCATE' "$CASE_LOG/mysql"
pass 'empty warehouse permits first submission'

reset_case
export RUN_STATUS='REBUILDING' WAREHOUSE_ROWS=1
run_script
[ "$result" -eq 0 ]; [ -f "$CASE_LOG/submitted" ]
assert_no_match 'TRUNCATE' "$CASE_LOG/mysql"
pass 'confirmed rebuilding state permits submission without truncating'

reset_case
touch "${test_root}/valid-savepoint"
export SAVEPOINT="file://${test_root}/valid-savepoint" NEW_JOB_STATE='FAILED'
run_script
[ "$result" -ne 0 ]
assert_no_match 'TRUNCATE|UPDATE' "$CASE_LOG/mysql"
grep -q '/jobs/new-submitted-job?mode=cancel' "$CASE_LOG/curl"
[ "$(grep -c 'mode=cancel' "$CASE_LOG/curl")" -eq 1 ]
pass 'failed restore preserves data and cancels only its newly submitted job'

reset_case
export SAVEPOINT="file://${test_root}/valid-savepoint"
run_script
[ "$result" -eq 0 ]
grep -q -- '-Dexecution.state-recovery.path=file:' "$CASE_LOG/submitted"
assert_no_match 'mode=cancel' "$CASE_LOG/curl"
pass 'successful restore passes the saved recovery path'

reset_case
export JOBS='{"jobs":[{"state": "RUNNING", "tasks":{"total":1}, "name": "flink-food-lab-realtime-warehouse", "jid":"existing"}]}'
run_script
[ "$result" -eq 0 ]; [ ! -e "$CASE_LOG/mysql" ]; [ ! -e "$CASE_LOG/submitted" ]
pass 'existing running job is detected independent of JSON field order'

reset_case
export JOBS='{"jobs":[{"name":"unrelated-job","state":"RUNNING"},{"name":"flink-food-lab-realtime-warehouse","state":"FINISHED"}]}'
run_script
[ "$result" -eq 0 ]; [ -f "$CASE_LOG/submitted" ]
pass 'unrelated running job and terminal lab job do not block fresh submission'

reset_case
export JOBS='{"jobs":[{"name":"flink-food-lab-realtime-warehouse","state":"RUNNING"},{"name":"flink-food-lab-realtime-warehouse","state":"RUNNING"}]}'
run_script
[ "$result" -ne 0 ]; [ ! -e "$CASE_LOG/mysql" ]; [ ! -e "$CASE_LOG/submitted" ]
pass 'multiple active lab jobs require diagnosis'

for state in CREATED RESTARTING FAILING CANCELLING RECONCILING INITIALIZING UNKNOWN; do
    reset_case
    export JOBS="{\"jobs\":[{\"name\":\"flink-food-lab-realtime-warehouse\",\"state\":\"$state\",\"jid\":\"existing\"}]}"
    run_script
    [ "$result" -ne 0 ]; [ ! -e "$CASE_LOG/mysql" ]; [ ! -e "$CASE_LOG/submitted" ]
    pass "transitional job $state prevents duplicate submission"
done

reset_case
export OVERVIEW_FAIL=1
run_script
[ "$result" -ne 0 ]; [ ! -e "$CASE_LOG/mysql" ]; [ ! -e "$CASE_LOG/submitted" ]
pass 'unreachable job overview fails closed'

reset_case
export JOBS='{"not-jobs":[]}'
run_script
[ "$result" -ne 0 ]; [ ! -e "$CASE_LOG/mysql" ]; [ ! -e "$CASE_LOG/submitted" ]
pass 'malformed job overview fails closed'

printf '%s isolated submit safety tests passed.\n' "$passed"
