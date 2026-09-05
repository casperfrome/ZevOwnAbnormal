/* Licensed under the Apache License, Version 2.0. See LICENSE. */
package com.starrocks.connector.flink.table.source;

import org.apache.flink.table.connector.ChangelogMode;
import org.apache.flink.table.connector.source.DynamicTableSource;
import org.apache.flink.table.connector.source.ScanTableSource;
import org.apache.flink.table.connector.source.SourceProvider;
import org.apache.flink.table.connector.source.abilities.SupportsProjectionPushDown;
import org.apache.flink.table.types.DataType;
import org.apache.flink.table.types.logical.RowType;

/** Reads physical table rows once; Flink executes filters, aggregates, joins, CTEs and limits. */
public final class StarRocksDynamicTableSource implements ScanTableSource, SupportsProjectionPushDown {
    private final StarRocksSourceOptions options;
    private DataType producedType;

    public StarRocksDynamicTableSource(StarRocksSourceOptions options, DataType producedType) {
        this.options = options;
        this.producedType = producedType;
        ((RowType) producedType.getLogicalType()).getChildren().forEach(JdbcRowConverter::validate);
    }

    @Override
    public ChangelogMode getChangelogMode() { return ChangelogMode.insertOnly(); }

    @Override
    public ScanRuntimeProvider getScanRuntimeProvider(ScanContext context) {
        return SourceProvider.of(new StarRocksJdbcSource(options, (RowType) producedType.getLogicalType()), 1);
    }

    @Override
    public DynamicTableSource copy() { return new StarRocksDynamicTableSource(options.copy(), producedType); }

    @Override
    public String asSummaryString() { return "StarRocks bounded JDBC source"; }

    @Override
    public boolean supportsNestedProjection() { return false; }

    @Override
    public void applyProjection(int[][] projectedFields, DataType producedDataType) {
        producedType = producedDataType;
    }
}
