/* Licensed under the Apache License, Version 2.0. See LICENSE. */
package com.starrocks.connector.flink.table.sink.v2;

import com.starrocks.connector.flink.table.sink.ExactlyOnceLabelGeneratorSnapshot;
import com.starrocks.connector.flink.table.sink.LingeringTransactionAborter;
import com.starrocks.connector.flink.table.sink.StarRocksSinkOptions;
import com.starrocks.data.load.stream.StreamLoadSnapshot;
import com.starrocks.data.load.stream.properties.StreamLoadProperties;
import com.starrocks.data.load.stream.v2.StreamLoadManagerV2;
import org.apache.flink.api.connector.sink2.Committer;
import org.apache.flink.api.connector.sink2.WriterInitContext;
import org.junit.jupiter.api.Test;
import org.mockito.MockedConstruction;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.OptionalLong;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class RecoveryTest {
    static StarRocksSinkOptions options() {
        return StarRocksSinkOptions.builder()
                .withProperty("jdbc-url", "jdbc:mysql://127.0.0.1:1")
                .withProperty("load-url", "127.0.0.1:1")
                .withProperty("database-name", "db")
                .withProperty("table-name", "tbl")
                .withProperty("username", "test")
                .withProperty("password", "")
                .withProperty("sink.semantic", "exactly-once")
                .withProperty("sink.version", "V2")
                .withProperty("sink.label-prefix", "recovery")
                .withProperty("sink.max-retries", "2")
                .withProperty("sink.retry.interval-ms", "0")
                .build();
    }

    static StarRocksWriterState state(int subtask) {
        return new StarRocksWriterState(List.of(new ExactlyOnceLabelGeneratorSnapshot(
                42, "db", "tbl", "recovery", 4, subtask, 17)));
    }

    static StreamLoadSnapshot transaction() {
        StreamLoadSnapshot snapshot = new StreamLoadSnapshot();
        snapshot.setId("checkpoint-42");
        snapshot.setTimestamp(1234);
        snapshot.setTransactions(List.of(new StreamLoadSnapshot.Transaction("db", "tbl", "prepared-42")));
        return snapshot;
    }

    @Test
    void writerStateRoundTripKeepsLabelStateForRescaling() throws Exception {
        StarRocksWriterStateSerializer serializer = new StarRocksWriterStateSerializer();
        StarRocksWriterState original = state(3);
        StarRocksWriterState restored = serializer.deserialize(serializer.getVersion(), serializer.serialize(original));
        assertEquals(original.getLabelSnapshots(), restored.getLabelSnapshots());
        assertThrows(IOException.class, () -> serializer.deserialize(99, serializer.serialize(original)));
    }

    @Test
    void committableRoundTripPreservesPreparedTransaction() throws Exception {
        StarRocksCommittableSerializer serializer = new StarRocksCommittableSerializer();
        StarRocksCommittable original = new StarRocksCommittable(transaction());
        StarRocksCommittable restored = serializer.deserialize(serializer.getVersion(), serializer.serialize(original));
        assertEquals("checkpoint-42", restored.getLabelSnapshot().getId());
        assertEquals("prepared-42", restored.getLabelSnapshot().getTransactions().get(0).getLabel());
        assertFalse(restored.getLabelSnapshot().getTransactions().get(0).isFinish());
        assertThrows(IOException.class, () -> serializer.deserialize(99, serializer.serialize(original)));
    }

    @Test
    void sinkPassesAllRecoveredWriterStatesToWriter() throws Exception {
        List<StarRocksWriterState> recovered = List.of(state(1), state(3));
        List<Object> actual = new ArrayList<>();
        try (MockedConstruction<StarRocksWriter> construction = mockConstruction(StarRocksWriter.class,
                (writer, context) -> actual.add(context.arguments().get(5)))) {
            StarRocksSink<String> sink = new StarRocksSink<>(options(),
                    new StringRecordSerializationSchema("db", "tbl"), mock(StreamLoadProperties.class));
            sink.restoreWriter(mock(WriterInitContext.class), recovered);
            assertEquals(List.of(recovered), actual);
        }
    }

    @Test
    void restoredWriterUsesAllPriorSubtasksForLingeringTransactionCleanup() throws Exception {
        WriterInitContext context = mock(WriterInitContext.class, RETURNS_DEEP_STUBS);
        when(context.getRestoredCheckpointId()).thenReturn(OptionalLong.of(42));
        when(context.getTaskInfo().getNumberOfParallelSubtasks()).thenReturn(2);
        when(context.getTaskInfo().getIndexOfThisSubtask()).thenReturn(0);
        List<Object> abortArguments = new ArrayList<>();
        try (MockedConstruction<StreamLoadManagerV2> managers = mockConstruction(StreamLoadManagerV2.class);
             MockedConstruction<LingeringTransactionAborter> aborters = mockConstruction(LingeringTransactionAborter.class,
                     (aborter, ctor) -> abortArguments.addAll(ctor.arguments()))) {
            StarRocksWriter<String> writer = new StarRocksWriter<>(options(), context,
                    context.asSerializationSchemaInitializationContext(),
                    new StringRecordSerializationSchema("db", "tbl"), mock(StreamLoadProperties.class),
                    List.of(state(1), state(3)));
            assertEquals(42L, abortArguments.get(1));
            assertEquals(List.of(state(1).getLabelSnapshots().get(0), state(3).getLabelSnapshots().get(0)), abortArguments.get(5));
            verify(aborters.constructed().get(0)).execute();
            writer.close();
        }
    }

    @Test
    void commitRetriesTransientFailuresAndStopsAfterSuccess() throws Exception {
        try (MockedConstruction<StreamLoadManagerV2> managers = mockConstruction(StreamLoadManagerV2.class,
                (manager, ctor) -> when(manager.commit(any())).thenThrow(new RuntimeException("temporary"))
                        .thenReturn(false).thenReturn(true))) {
            try (StarRocksCommitter committer = new StarRocksCommitter(options(), null)) {
                committer.commit(List.of(request(new StarRocksCommittable(transaction()))));
                verify(managers.constructed().get(0), times(3)).commit(any());
            }
        }
    }

    @Test
    void checkpointFlushPreparesTransactionWithoutCommittingIt() throws Exception {
        WriterInitContext context = mock(WriterInitContext.class, RETURNS_DEEP_STUBS);
        when(context.getRestoredCheckpointId()).thenReturn(OptionalLong.empty());
        when(context.getTaskInfo().getNumberOfParallelSubtasks()).thenReturn(1);
        StreamLoadSnapshot prepared = transaction();
        try (MockedConstruction<StreamLoadManagerV2> managers = mockConstruction(StreamLoadManagerV2.class,
                (manager, ctor) -> {
                    when(manager.snapshot()).thenReturn(prepared);
                    when(manager.prepare(prepared)).thenReturn(true);
                });
             MockedConstruction<LingeringTransactionAborter> aborters = mockConstruction(LingeringTransactionAborter.class)) {
            StarRocksWriter<String> writer = new StarRocksWriter<>(options(), context,
                    context.asSerializationSchemaInitializationContext(), new StringRecordSerializationSchema("db", "tbl"),
                    mock(StreamLoadProperties.class), List.of());
            writer.write("{\"id\":42}", null);
            writer.flush(false);
            assertSame(prepared, writer.prepareCommit().iterator().next().getLabelSnapshot());
            StreamLoadManagerV2 manager = managers.constructed().get(0);
            org.mockito.InOrder order = inOrder(manager);
            order.verify(manager).write(null, "db", "tbl", "{\"id\":42}");
            order.verify(manager).flush();
            order.verify(manager).snapshot();
            order.verify(manager).prepare(prepared);
            verify(manager, never()).commit(any());
            writer.close();
        }
    }

    @Test
    void failedPrepareAbortsTransactionAndFailsCheckpoint() throws Exception {
        WriterInitContext context = mock(WriterInitContext.class, RETURNS_DEEP_STUBS);
        when(context.getRestoredCheckpointId()).thenReturn(OptionalLong.empty());
        when(context.getTaskInfo().getNumberOfParallelSubtasks()).thenReturn(1);
        StreamLoadSnapshot prepared = transaction();
        try (MockedConstruction<StreamLoadManagerV2> managers = mockConstruction(StreamLoadManagerV2.class,
                (manager, ctor) -> when(manager.snapshot()).thenReturn(prepared));
             MockedConstruction<LingeringTransactionAborter> aborters = mockConstruction(LingeringTransactionAborter.class)) {
            StarRocksWriter<String> writer = new StarRocksWriter<>(options(), context,
                    context.asSerializationSchemaInitializationContext(), new StringRecordSerializationSchema("db", "tbl"),
                    mock(StreamLoadProperties.class), List.of());
            assertThrows(RuntimeException.class, writer::prepareCommit);
            verify(managers.constructed().get(0)).abort(prepared);
            verify(managers.constructed().get(0), never()).commit(any());
            writer.close();
        }
    }

    @Test
    void exhaustedCommitFailureFailsCheckpointInsteadOfLosingTransaction() throws Exception {
        try (MockedConstruction<StreamLoadManagerV2> managers = mockConstruction(StreamLoadManagerV2.class,
                (manager, ctor) -> when(manager.commit(any())).thenReturn(false))) {
            try (StarRocksCommitter committer = new StarRocksCommitter(options(), null)) {
                assertThrows(IOException.class, () -> committer.commit(List.of(request(new StarRocksCommittable(transaction())))));
                verify(managers.constructed().get(0), times(3)).commit(any());
            }
        }
    }

    @Test
    void recoveredCommittableCanBeCommittedAgainAfterAmbiguousNetworkFailure() throws Exception {
        StarRocksCommittableSerializer serializer = new StarRocksCommittableSerializer();
        StarRocksCommittable restored = serializer.deserialize(1, serializer.serialize(new StarRocksCommittable(transaction())));
        try (MockedConstruction<StreamLoadManagerV2> managers = mockConstruction(StreamLoadManagerV2.class,
                (manager, ctor) -> when(manager.commit(any())).thenReturn(true))) {
            try (StarRocksCommitter committer = new StarRocksCommitter(options(), null)) {
                committer.commit(List.of(request(restored)));
                committer.commit(List.of(request(restored)));
                verify(managers.constructed().get(0), times(2)).commit(restored.getLabelSnapshot());
            }
        }
    }

    @SuppressWarnings("unchecked")
    static Committer.CommitRequest<StarRocksCommittable> request(StarRocksCommittable value) {
        Committer.CommitRequest<StarRocksCommittable> request = mock(Committer.CommitRequest.class);
        when(request.getCommittable()).thenReturn(value);
        return request;
    }
}
