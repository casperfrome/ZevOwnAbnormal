/* Licensed under the Apache License, Version 2.0. See LICENSE. */
package com.starrocks.connector.flink.table.source;

import org.apache.flink.api.common.RuntimeExecutionMode;
import org.apache.flink.configuration.ConfigOption;
import org.apache.flink.configuration.ExecutionOptions;
import org.apache.flink.table.api.ValidationException;
import org.apache.flink.table.connector.source.DynamicTableSource;
import org.apache.flink.table.factories.DynamicTableSourceFactory;
import org.apache.flink.table.factories.FactoryUtil;

import java.util.Set;

/** Bounded JDBC table scans; query operators remain in the Flink planner. */
public final class StarRocksDynamicTableSourceFactory implements DynamicTableSourceFactory {
    @Override
    public String factoryIdentifier() { return "starrocks"; }

    @Override
    public Set<ConfigOption<?>> requiredOptions() {
        return Set.of(StarRocksSourceOptions.JDBC_URL, StarRocksSourceOptions.SCAN_URL,
                StarRocksSourceOptions.USERNAME, StarRocksSourceOptions.PASSWORD,
                StarRocksSourceOptions.DATABASE_NAME, StarRocksSourceOptions.TABLE_NAME);
    }

    @Override
    public Set<ConfigOption<?>> optionalOptions() {
        return Set.of(StarRocksSourceOptions.SCAN_CONNECT_TIMEOUT, StarRocksSourceOptions.SCAN_BATCH_ROWS,
                StarRocksSourceOptions.SCAN_QUERY_TIMEOUT_S);
    }

    @Override
    public DynamicTableSource createDynamicTableSource(Context context) {
        FactoryUtil.TableFactoryHelper helper = FactoryUtil.createTableFactoryHelper(this, context);
        // Do not ignore scan.* predicates, lookup options, or BE scanner options that this transport
        // cannot implement. Unsupported options must fail validation instead of changing results.
        helper.validate();
        if (context.getConfiguration().get(ExecutionOptions.RUNTIME_MODE) != RuntimeExecutionMode.BATCH) {
            throw new ValidationException("The StarRocks JDBC source supports bounded batch queries only; "
                    + "set execution.runtime-mode=batch. Streaming lookups and checkpoint resume are not supported.");
        }
        StarRocksSourceOptions options = new StarRocksSourceOptions(helper.getOptions(), context.getCatalogTable().getOptions());
        return new StarRocksDynamicTableSource(options, context.getCatalogTable().getResolvedSchema().toPhysicalRowDataType());
    }
}
