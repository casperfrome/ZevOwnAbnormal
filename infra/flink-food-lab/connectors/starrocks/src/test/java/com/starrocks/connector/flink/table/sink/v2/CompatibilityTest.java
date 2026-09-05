/* Licensed under the Apache License, Version 2.0. See LICENSE. */
package com.starrocks.connector.flink.table.sink.v2;

import com.alibaba.fastjson.JSON;
import com.starrocks.connector.flink.row.sink.StarRocksSerializerFactory;
import com.starrocks.connector.flink.row.sink.StarRocksTableRowTransformer;
import com.starrocks.connector.flink.table.sink.StarRocksDynamicTableSinkFactory;
import com.starrocks.connector.flink.table.sink.StarRocksSinkOptions;
import com.starrocks.connector.flink.table.sink.StarRocksSinkFactory;
import com.starrocks.data.load.stream.StreamLoadUtils;
import org.apache.flink.api.connector.sink2.Sink;
import org.apache.flink.api.connector.sink2.SupportsCommitter;
import org.apache.flink.api.connector.sink2.SupportsWriterState;
import org.apache.flink.configuration.ConfigOption;
import org.apache.flink.table.api.DataTypes;
import org.apache.flink.table.catalog.ResolvedSchema;
import org.apache.flink.table.data.GenericRowData;
import org.apache.flink.table.factories.DynamicTableSinkFactory;
import org.apache.flink.table.factories.FactoryUtil;
import org.apache.flink.types.RowKind;
import org.apache.flink.util.InstantiationUtil;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class CompatibilityTest {
    @Test
    void explicitV2CannotSilentlyDowngradeSqlExactlyOnceToNontransactionalLoad() throws Exception {
        StarRocksSinkOptions options = RecoveryTest.options();
        try (org.mockito.MockedStatic<StreamLoadUtils> utils = mockStatic(StreamLoadUtils.class)) {
            utils.when(() -> StreamLoadUtils.isStarRocksSupportTransactionLoad(
                    options.getLoadUrlList(), options.getConnectTimeout(), options.getUsername(), options.getPassword()))
                    .thenReturn(false);
            IllegalStateException failure = assertThrows(IllegalStateException.class,
                    () -> StarRocksSinkFactory.createSink(options, (ResolvedSchema) null, null));
            assertTrue(failure.getMessage().contains("transaction stream load"));
        }
    }

    @Test
    void javaFacadeIsSerializableWithoutContactingBackend() throws Exception {
        Sink<String> sink = com.starrocks.connector.flink.StarRocksSink.sink(RecoveryTest.options());
        assertInstanceOf(SupportsWriterState.class, sink);
        assertInstanceOf(SupportsCommitter.class, sink);
        assertNotNull(InstantiationUtil.deserializeObject(InstantiationUtil.serializeObject(sink), getClass().getClassLoader()));
    }

    @Test
    void sqlFactoryIsDiscoverableAndAcceptsAllUpstreamSinkOptions() throws Exception {
        DynamicTableSinkFactory factory = FactoryUtil.discoverFactory(getClass().getClassLoader(), DynamicTableSinkFactory.class, "starrocks");
        assertInstanceOf(StarRocksDynamicTableSinkFactory.class, factory);
        Set<ConfigOption<?>> accepted = new HashSet<>(factory.requiredOptions());
        accepted.addAll(factory.optionalOptions());
        for (Field field : StarRocksSinkOptions.class.getFields()) {
            if (ConfigOption.class.isAssignableFrom(field.getType())) {
                assertTrue(accepted.contains(field.get(null)), "SQL factory omitted " + field.getName());
            }
        }
    }

    @Test
    void primaryKeyJsonRowsEncodeDeletesAndConfigurableUpdateBefore() {
        StarRocksSinkOptions options = StarRocksSinkOptions.builder()
                .withProperty("sink.properties.format", "json").build();
        options.enableUpsertDelete();
        ResolvedSchema schema = ResolvedSchema.physical(new String[]{"id"}, new org.apache.flink.table.types.DataType[]{DataTypes.BIGINT()});
        StarRocksTableRowTransformer transformer = new StarRocksTableRowTransformer(null);
        transformer.setTableSchema(schema);
        transformer.setStarRocksColumns(Map.of());
        RowDataSerializationSchema serializer = new RowDataSerializationSchema("db", "tbl", true, false,
                StarRocksSerializerFactory.createSerializer(options, new String[]{"id"}), transformer);
        serializer.open(null, null);
        GenericRowData record = GenericRowData.of(42L);
        record.setRowKind(RowKind.DELETE);
        assertEquals(1, JSON.parseObject(serializer.serialize(record).getRow()).getIntValue("__op"));
        record.setRowKind(RowKind.UPDATE_BEFORE);
        assertEquals(1, JSON.parseObject(serializer.serialize(record).getRow()).getIntValue("__op"));
        record.setRowKind(RowKind.UPDATE_AFTER);
        assertEquals(0, JSON.parseObject(serializer.serialize(record).getRow()).getIntValue("__op"));
        RowDataSerializationSchema ignoreBefore = new RowDataSerializationSchema("db", "tbl", true, true,
                StarRocksSerializerFactory.createSerializer(options, new String[]{"id"}), transformer);
        ignoreBefore.open(null, null);
        record.setRowKind(RowKind.UPDATE_BEFORE);
        assertNull(ignoreBefore.serialize(record));
    }
}
