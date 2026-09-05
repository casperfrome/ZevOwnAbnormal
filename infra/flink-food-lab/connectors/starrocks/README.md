# StarRocks connector for Flink 2.3.0

Self-maintained Sink V2 migration of upstream `v1.2.15`, pinned to
`9cfffceff54750a11e8504f26f78e4da8744eb1a`, with a bounded JDBC SQL source
implemented on Flink 2.3's public Source API. Both the connector and the
bundled stream-load SDK are vendored here. Builds do not fetch an SDK snapshot.
See `ORIGIN.json`, `LICENSE`, and `NOTICE` for provenance and attribution.

## Build

```powershell
./build.ps1
# Optional isolated Maven cache:
./build.ps1 -MavenRepository D:/some/maven-repository
```

The entrypoint sets `JAVA_HOME=D:/jdk25`, prepends `D:/jdk25/bin` to `PATH`,
and uses `D:/apache-maven-3.9.12/bin/mvn.cmd`. Maven enforces JDK 25 and
compiles the connector and SDK with `--release 17`. All dependency and plugin
versions are pinned; Maven's build timestamp is fixed for reproducible archives.
`-PackageOnly` verifies without local installation; `-SkipTests` is available
for the enclosing infrastructure build after tests have passed.

The default build runs tests and installs:

```text
com.zev.flink:flink-connector-starrocks:1.2.15-flink-2.3.0-zev.1
target/flink-connector-starrocks-1.2.15-flink-2.3.0-zev.1.jar
```

The main JAR is shaded, including the pinned SDK, JDBC driver, HTTP client,
JSON, compression, and utility dependencies. Flink and its SLF4J logging API
are provided by the cluster. The sources JAR includes the vendored SDK.

## Java and SQL

```java
import com.starrocks.connector.flink.StarRocksSink;
import com.starrocks.connector.flink.table.sink.StarRocksSinkOptions;

StarRocksSinkOptions options = StarRocksSinkOptions.builder()
    .withProperty("jdbc-url", "jdbc:mysql://starrocks-fe:9030")
    .withProperty("load-url", "starrocks-fe:8030")
    .withProperty("database-name", "food")
    .withProperty("table-name", "orders")
    .withProperty("username", "root")
    .withProperty("password", "")
    .withProperty("sink.properties.format", "json")
    .withProperty("sink.semantic", "exactly-once")
    .withProperty("sink.label-prefix", "food-orders")
    .build();
jsonStrings.sinkTo(StarRocksSink.sink(options));
```

`StarRocksSink.sink(StarRocksSinkOptions)` returns the public
`org.apache.flink.api.connector.sink2.Sink<String>` interface. Construction
is serializable and does not contact StarRocks. Worker initialization performs
feature detection and opens connections. The existing options builder is retained.

SQL uses the service-discovered `starrocks` factory. All upstream sink options
and `sink.properties.*` pass-through options remain accepted. Physical columns
and primary keys use Flink's public `ResolvedSchema`; primary-key JSON/CSV
serialization preserves `__op` deletes and `sink.ignore.update-before` behavior.
SQL schema validation still contacts StarRocks when creating the runtime provider.

This artifact always uses Sink V2. `sink.use.new-sink-api` is accepted for
configuration compatibility, but does not select a legacy implementation.
`sink.version=V2` and `AUTO` are supported; `V1` is rejected. Streaming lookup,
the upstream BE tablet/Arrow scanner, catalog, CDC tools, and the removed
`SinkFunction` implementation are outside this migration.

## Bounded SQL queries

The same `starrocks` identifier also discovers a `DynamicTableSource` backed
by a native `Source<RowData, TableSplit, Boolean>`. Set
`execution.runtime-mode=batch`, then declare the source table's physical
schema using `jdbc-url`, `scan-url`, `database-name`, `table-name`, `username`,
and `password`. Existing learning-app source DDL continues to work.

The source streams rows through the bundled MySQL JDBC driver from the FE.
`scan-url` remains a required DDL compatibility field; this source transport
uses `jdbc-url`. Each table has one complete bounded split and one source
subtask. A worker thread and bounded queue prevent JDBC reads from blocking
the Flink task mailbox. Projection pushdown reads requested columns; a zero
column projection still emits one empty row for every database row, preserving
`COUNT(*)` and empty-table behavior. Flink executes filtering, aggregation,
CTEs, joins, ordering, limits, and SQL null semantics normally.

Additional supported options are `scan.connect.timeout-ms`,
`scan.params.query-timeout-s`, and `scan.params.batch-rows` (queue capacity).
Streaming lookup, BE scanner tuning/mapping, `scan.filter`, `scan.columns`,
and other unimplemented options fail validation rather than being ignored.
Use regular Flink SQL `WHERE` and projections for filtering and selection.

The source handles nullable strings, booleans, integer types, floats,
doubles, decimals with overflow checking, date/time/timestamp, and binary
fields. TIMESTAMP without time zone preserves the database wall-clock value.
Unsupported complex types fail schema validation. It is a bounded batch scan,
not CDC: failed batch tasks replay the complete table split instead of skipping
an unstable row offset. Streaming checkpoint resume is not supported. Reads
do not claim a consistent snapshot across concurrently modified tables; FE
JDBC scan throughput can be lower than the upstream parallel BE scanner.

## Checkpoints and recovery

The sink implements `Sink`, `SupportsWriterState`, and `SupportsCommitter`;
the writer implements `StatefulSinkWriter` and `CommittingSinkWriter`.
Exactly-once keeps the SDK transaction begin/load, checkpoint flush/prepare,
Flink-coordinated commit, and close/lingering-transaction abort lifecycle.
Use checkpointing and a stable, deployment-unique label prefix for recovery.
Exactly-once requires StarRocks transaction stream load. Existing upstream
multi-table transaction mode remains restricted to at-least-once semantics.

Migration fixes:

- Restored writer states reach the writer, including previous subtasks after rescaling.
- Writer state deserialization targets `StarRocksWriterState`, retaining version 1 JSON.
- Both checkpoint serializers reject unknown versions and invalid payloads.
- Exhausted commits throw `IOException`; a transient failure followed by success
  completes normally. Retries honor `sink.retry.interval-ms`.
- A recovered transaction that StarRocks reports as `COMMITTED` or `VISIBLE`
  remains idempotently successful through the pinned SDK's label-state check.

Tests cover state and transaction serialization, restored/rescaled state handoff,
lingering transaction cleanup inputs, commit retries/exhaustion/recovery, Java
facade serialization, SQL factory options, and primary-key delete serialization.
Local HTTP protocol tests exercise the actual SDK's repeated-commit behavior
for `COMMITTED`, `VISIBLE`, `PREPARED`, and `UNKNOWN` server states.
Real Flink batch-query tests over an H2 JDBC fixture exercise nonempty/empty
counts, projections, decimal and timestamp precision, date/integer mapping,
nulls, CTE aggregation, joins, limits, and unsupported-option rejection.
An availability regression test keeps a previously exposed pending future,
polls the empty reader, then scans 5,207 rows through a two-row queue. It
guards against orphaned source wakeups and exercises queue backpressure.

This module's tests do not claim a live StarRocks cluster failover or savepoint
compatibility with the removed legacy SinkFunction. Cluster smoke/recovery
verification belongs to the enclosing Flink lab. Vendored SDK behavior and its
dependencies are otherwise retained; this is a compatibility fork, not an
independent audit or upgrade of every upstream dependency.
