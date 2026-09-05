/* Licensed under the Apache License, Version 2.0. See LICENSE. */
package com.starrocks.connector.flink.table.source;

import org.apache.flink.api.connector.source.ReaderOutput;
import org.apache.flink.api.connector.source.SourceReader;
import org.apache.flink.api.connector.source.SourceReaderContext;
import org.apache.flink.core.io.InputStatus;
import org.apache.flink.table.data.RowData;
import org.apache.flink.table.types.logical.BigIntType;
import org.apache.flink.table.types.logical.RowType;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class JdbcReaderAvailabilityTest {
    @Test
    @Timeout(20)
    void exposedAvailabilityPromiseSurvivesEmptyPollAndQueueBackpressure() throws Exception {
        String url = "jdbc:h2:mem:source_availability;MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1";
        Class.forName("org.h2.Driver");
        try (Connection connection = DriverManager.getConnection(url, "sa", ""); Statement statement = connection.createStatement()) {
            statement.execute("CREATE SCHEMA IF NOT EXISTS lab");
            statement.execute("CREATE TABLE lab.many_rows AS SELECT \"X\" AS id FROM SYSTEM_RANGE(1, 5207)");
        }
        StarRocksSourceOptions options = StarRocksSourceOptions.builder()
                .withProperty("jdbc-url", url).withProperty("scan-url", "unused:8030")
                .withProperty("database-name", "lab").withProperty("table-name", "many_rows")
                .withProperty("username", "sa").withProperty("password", "")
                .withProperty("scan.params.batch-rows", "2").build();
        StarRocksJdbcSource source = new StarRocksJdbcSource(options,
                RowType.of(new org.apache.flink.table.types.logical.LogicalType[]{new BigIntType()}, new String[]{"id"}));
        AtomicLong count = new AtomicLong();
        AtomicLong sum = new AtomicLong();
        @SuppressWarnings("unchecked") ReaderOutput<RowData> output = mock(ReaderOutput.class);
        doAnswer(call -> {
            count.incrementAndGet();
            sum.addAndGet(((RowData) call.getArgument(0)).getLong(0));
            return null;
        }).when(output).collect(any(RowData.class));
        try (SourceReader<RowData, StarRocksJdbcSource.TableSplit> reader = source.createReader(mock(SourceReaderContext.class))) {
            reader.start();
            CompletableFuture<Void> previouslyExposed = reader.isAvailable();
            assertEquals(InputStatus.NOTHING_AVAILABLE, reader.pollNext(output));
            // A pending promise may already be retained by the Flink SourceOperator. Polling while
            // empty must not replace it with a different promise that alone receives the wakeup.
            reader.addSplits(List.of(new StarRocksJdbcSource.TableSplit()));
            reader.notifyNoMoreSplits();
            previouslyExposed.get(2, TimeUnit.SECONDS);
            while (true) {
                reader.isAvailable().get(2, TimeUnit.SECONDS);
                InputStatus status = reader.pollNext(output);
                if (status == InputStatus.END_OF_INPUT) { break; }
            }
        }
        assertEquals(5207, count.get());
        assertEquals(5207L * 5208L / 2, sum.get());
    }
}
