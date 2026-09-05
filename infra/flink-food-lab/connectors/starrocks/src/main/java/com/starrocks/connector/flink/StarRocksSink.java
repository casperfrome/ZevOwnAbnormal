/* Licensed under the Apache License, Version 2.0. See LICENSE. */
package com.starrocks.connector.flink;

import com.starrocks.connector.flink.table.sink.StarRocksSinkOptions;
import com.starrocks.connector.flink.table.sink.v2.StringRecordSerializationSchema;
import org.apache.flink.api.connector.sink2.Sink;

/** Public DataStream API for Flink 2.3. Attach with {@code stream.sinkTo(sink(options))}. */
public final class StarRocksSink {
    private StarRocksSink() {}

    /** Creates a sink without contacting StarRocks; connections open on the workers. */
    public static Sink<String> sink(StarRocksSinkOptions options) {
        return new com.starrocks.connector.flink.table.sink.v2.StarRocksSink<>(
                options,
                new StringRecordSerializationSchema(options.getDatabaseName(), options.getTableName()),
                null);
    }
}
