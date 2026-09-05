/* Licensed under the Apache License, Version 2.0. See LICENSE. */
package com.starrocks.connector.flink.table.sink.v2;

import com.starrocks.connector.flink.table.data.DefaultStarRocksRowData;
import com.starrocks.connector.flink.table.data.StarRocksRowData;
import org.apache.flink.api.common.serialization.SerializationSchema;

/** Passes already serialized JSON/CSV strings to the stream-load SDK. */
public final class StringRecordSerializationSchema implements RecordSerializationSchema<String> {
    private static final long serialVersionUID = 1L;
    private final String database;
    private final String table;

    public StringRecordSerializationSchema(String database, String table) {
        this.database = database;
        this.table = table;
    }

    @Override
    public void open(SerializationSchema.InitializationContext context, StarRocksSinkContext sinkContext) {}

    @Override
    public StarRocksRowData serialize(String record) {
        return record == null ? null : new DefaultStarRocksRowData(null, database, table, record);
    }

    @Override
    public void close() {}
}
