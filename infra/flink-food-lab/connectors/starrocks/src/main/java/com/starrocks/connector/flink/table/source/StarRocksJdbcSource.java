/* Licensed under the Apache License, Version 2.0. See LICENSE. */
package com.starrocks.connector.flink.table.source;

import org.apache.flink.api.connector.source.Boundedness;
import org.apache.flink.api.connector.source.ReaderOutput;
import org.apache.flink.api.connector.source.Source;
import org.apache.flink.api.connector.source.SourceReader;
import org.apache.flink.api.connector.source.SourceReaderContext;
import org.apache.flink.api.connector.source.SourceSplit;
import org.apache.flink.api.connector.source.SplitEnumerator;
import org.apache.flink.api.connector.source.SplitEnumeratorContext;
import org.apache.flink.core.io.InputStatus;
import org.apache.flink.core.io.SimpleVersionedSerializer;
import org.apache.flink.table.data.RowData;
import org.apache.flink.table.types.logical.RowType;

import java.io.IOException;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.List;
import java.util.Properties;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.stream.Collectors;

/** One complete table split per batch query. Failed batch tasks replay the entire split. */
public final class StarRocksJdbcSource implements Source<RowData, StarRocksJdbcSource.TableSplit, Boolean> {
    private static final long serialVersionUID = 1L;
    private final StarRocksSourceOptions options;
    private final RowType rowType;

    public StarRocksJdbcSource(StarRocksSourceOptions options, RowType rowType) {
        this.options = options;
        this.rowType = rowType;
    }

    @Override public Boundedness getBoundedness() { return Boundedness.BOUNDED; }
    @Override public SourceReader<RowData, TableSplit> createReader(SourceReaderContext context) { return new JdbcReader(context); }
    @Override public SplitEnumerator<TableSplit, Boolean> createEnumerator(SplitEnumeratorContext<TableSplit> context) { return new Enumerator(context, true); }
    @Override public SplitEnumerator<TableSplit, Boolean> restoreEnumerator(SplitEnumeratorContext<TableSplit> context, Boolean remaining) { return new Enumerator(context, remaining); }
    @Override public SimpleVersionedSerializer<TableSplit> getSplitSerializer() {
        return new SimpleVersionedSerializer<>() {
            @Override public int getVersion() { return 1; }
            @Override public byte[] serialize(TableSplit split) { return new byte[]{1}; }
            @Override public TableSplit deserialize(int version, byte[] data) throws IOException {
                checkVersion(version, data);
                return new TableSplit();
            }
        };
    }
    @Override public SimpleVersionedSerializer<Boolean> getEnumeratorCheckpointSerializer() {
        return new SimpleVersionedSerializer<>() {
            @Override public int getVersion() { return 1; }
            @Override public byte[] serialize(Boolean state) { return new byte[]{(byte) (state ? 1 : 0)}; }
            @Override public Boolean deserialize(int version, byte[] data) throws IOException {
                checkVersion(version, data);
                return data[0] == 1;
            }
        };
    }
    private static void checkVersion(int version, byte[] data) throws IOException {
        if (version != 1 || data.length != 1 || (data[0] != 0 && data[0] != 1)) { throw new IOException("Invalid StarRocks table split state"); }
    }
    public static final class TableSplit implements SourceSplit {
        @Override public String splitId() { return "table"; }
    }

    private static final class Enumerator implements SplitEnumerator<TableSplit, Boolean> {
        private final SplitEnumeratorContext<TableSplit> context;
        private boolean remaining;
        Enumerator(SplitEnumeratorContext<TableSplit> context, boolean remaining) { this.context = context; this.remaining = remaining; }
        @Override public void start() {}
        @Override public void addReader(int subtask) {}
        @Override public void handleSplitRequest(int subtask, String host) {
            if (remaining) { context.assignSplit(new TableSplit(), subtask); remaining = false; }
            context.signalNoMoreSplits(subtask);
        }
        @Override public void addSplitsBack(List<TableSplit> splits, int subtask) { remaining |= !splits.isEmpty(); }
        @Override public Boolean snapshotState(long checkpointId) { return remaining; }
        @Override public void close() {}
    }

    private final class JdbcReader implements SourceReader<RowData, TableSplit> {
        private final SourceReaderContext context;
        private final BlockingQueue<RowData> rows = new ArrayBlockingQueue<>(options.getBatchRows());
        private final Object availabilityLock = new Object();
        private CompletableFuture<Void> available = new CompletableFuture<>();
        private volatile boolean finished;
        private volatile boolean closed;
        private volatile Throwable failure;
        private volatile Connection connection;
        private volatile Statement statement;
        private Thread worker;
        private boolean assigned;

        JdbcReader(SourceReaderContext context) { this.context = context; }
        @Override public void start() { context.sendSplitRequest(); }
        @Override public void addSplits(List<TableSplit> splits) {
            if (splits.isEmpty()) { return; }
            if (assigned || splits.size() != 1) { throw new IllegalStateException("Expected one table split per reader"); }
            assigned = true;
            worker = new Thread(this::fetch, "starrocks-jdbc-scan-" + context.getIndexOfSubtask());
            worker.setDaemon(true);
            worker.start();
        }
        private void fetch() {
            Properties properties = new Properties();
            properties.setProperty("user", options.getUsername());
            properties.setProperty("password", options.getPassword());
            if (options.getJdbcUrl().startsWith("jdbc:mysql:")) {
                properties.setProperty("connectTimeout", String.valueOf(options.getConnectTimeoutMs()));
                properties.setProperty("socketTimeout", String.valueOf(Math.multiplyExact((long) options.getQueryTimeout(), 1000L)));
            }
            try {
                // Explicit load is necessary in Flink's user-code classloader; DriverManager's
                // process-wide service discovery may have already run before this connector loaded.
                if (options.getJdbcUrl().startsWith("jdbc:mysql:")) { Class.forName("com.mysql.jdbc.Driver"); }
                try (Connection conn = DriverManager.getConnection(options.getJdbcUrl(), properties)) {
                    connection = conn;
                    if (closed) { return; }
                    try (Statement query = conn.createStatement(ResultSet.TYPE_FORWARD_ONLY, ResultSet.CONCUR_READ_ONLY)) {
                        statement = query;
                        query.setQueryTimeout(options.getQueryTimeout());
                        query.setFetchSize(options.getJdbcUrl().startsWith("jdbc:mysql:") ? Integer.MIN_VALUE : options.getBatchRows());
                        String columns = rowType.getFieldNames().isEmpty() ? "1" : rowType.getFieldNames().stream().map(StarRocksJdbcSource::quote).collect(Collectors.joining(","));
                        String sql = "SELECT " + columns + " FROM " + quote(options.getDatabaseName()) + "." + quote(options.getTableName());
                        try (ResultSet result = query.executeQuery(sql)) {
                            while (!closed && result.next()) {
                                rows.put(JdbcRowConverter.read(result, rowType));
                                signal();
                            }
                        }
                    }
                }
            } catch (Throwable error) {
                if (!closed) { failure = error; }
            } finally {
                statement = null;
                connection = null;
                finished = true;
                signal();
            }
        }
        private void signal() { synchronized (availabilityLock) { available.complete(null); } }
        @Override public InputStatus pollNext(ReaderOutput<RowData> output) throws Exception {
            if (failure != null) { throw new IOException("StarRocks bounded JDBC scan failed", failure); }
            RowData row = rows.poll();
            if (row != null) { output.collect(row); }
            synchronized (availabilityLock) {
                if (!rows.isEmpty()) { return InputStatus.MORE_AVAILABLE; }
                if (finished) {
                    if (failure != null) { throw new IOException("StarRocks bounded JDBC scan failed", failure); }
                    return InputStatus.END_OF_INPUT;
                }
                // SourceOperator may already retain an unfinished future from isAvailable().
                // Replacing that pending promise strands the mailbox even when fetch() fills
                // the queue. Only a completed promise may be replaced for the next empty period.
                if (available.isDone()) { available = new CompletableFuture<>(); }
                return InputStatus.NOTHING_AVAILABLE;
            }
        }
        @Override public CompletableFuture<Void> isAvailable() {
            synchronized (availabilityLock) {
                return !rows.isEmpty() || finished ? CompletableFuture.completedFuture(null) : available;
            }
        }
        @Override public void notifyNoMoreSplits() { if (!assigned) { finished = true; signal(); } }
        @Override public List<TableSplit> snapshotState(long checkpointId) {
            // The SQL factory permits batch only. Retain the complete split for batch task replay;
            // deliberately do not persist a row offset into a concurrently mutable table.
            return assigned ? List.of(new TableSplit()) : List.of();
        }
        @Override public void close() throws Exception {
            closed = true;
            if (worker != null) { worker.interrupt(); }
            try {
                Statement query = statement;
                if (query != null) { query.cancel(); }
            } finally {
                Connection conn = connection;
                if (conn != null) { conn.close(); }
                if (worker != null) { worker.join(1000); }
            }
        }
    }
    private static String quote(String identifier) { return "`" + identifier.replace("`", "``") + "`"; }
}
