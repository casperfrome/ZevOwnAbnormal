/* Licensed under the Apache License, Version 2.0. See LICENSE. */
package com.starrocks.connector.flink.table.source;

import org.apache.flink.configuration.Configuration;
import org.apache.flink.table.api.EnvironmentSettings;
import org.apache.flink.table.api.TableEnvironment;
import org.apache.flink.types.Row;
import org.apache.flink.util.CloseableIterator;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** Executes real Flink batch plans and the JDBC reader against a relational fixture. */
class BoundedSqlQueryTest {
    @Test
    @Timeout(180)
    void countProjectionNullsPrecisionCteAggregationAndJoinExecuteInFlink() throws Exception {
        String url = "jdbc:h2:mem:source_query;MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1";
        Class.forName("org.h2.Driver");
        try (Connection connection = DriverManager.getConnection(url, "sa", ""); Statement statement = connection.createStatement()) {
            statement.execute("CREATE SCHEMA IF NOT EXISTS lab");
            statement.execute("CREATE TABLE lab.orders(order_id VARCHAR, amount DECIMAL(12,2), event_time TIMESTAMP(3), event_date DATE, topic_partition INT, topic_offset BIGINT, status VARCHAR)");
            statement.execute("INSERT INTO lab.orders VALUES ('o1',12.34,TIMESTAMP '2026-09-05 12:34:56.789',DATE '2026-09-05',0,2147483648,'paid'),('o2',37.66,TIMESTAMP '2026-09-05 13:00:00.123',DATE '2026-09-05',1,9223372036854775806,'paid'),('o3',NULL,NULL,NULL,NULL,NULL,NULL)");
            statement.execute("CREATE TABLE lab.links(order_id VARCHAR, channel VARCHAR)");
            statement.execute("INSERT INTO lab.links VALUES ('o1','app'),('o2','web')");
            statement.execute("CREATE TABLE lab.empty_orders AS SELECT * FROM lab.orders WHERE 1=0");
        }
        Configuration config = new Configuration();
        config.setString("parallelism.default", "1");
        config.setString("table.exec.resource.default-parallelism", "1");
        config.setString("execution.runtime-mode", "batch");
        TableEnvironment tables = TableEnvironment.create(EnvironmentSettings.newInstance().inBatchMode().withConfiguration(config).build());
        String schema = "order_id STRING,amount DECIMAL(12,2),event_time TIMESTAMP(3),event_date DATE,topic_partition INT,topic_offset BIGINT,status STRING";
        tables.executeSql("CREATE TEMPORARY TABLE orders(" + schema + ") WITH (" + options(url, "orders") + ")");
        tables.executeSql("CREATE TEMPORARY TABLE empty_orders(" + schema + ") WITH (" + options(url, "empty_orders") + ")");
        tables.executeSql("CREATE TEMPORARY TABLE links(order_id STRING,channel STRING) WITH (" + options(url, "links") + ")");

        assertEquals(3L, query(tables, "SELECT COUNT(*) FROM orders").get(0).getField(0));
        assertEquals(0L, query(tables, "SELECT COUNT(*) FROM empty_orders").get(0).getField(0));
        List<Row> projection = query(tables, "SELECT order_id,amount,event_time,event_date,topic_partition,topic_offset FROM orders WHERE order_id='o1'");
        assertEquals(1, projection.size());
        Row first = projection.get(0);
        assertEquals(new BigDecimal("12.34"), first.getField(1));
        assertEquals(LocalDateTime.of(2026,9,5,12,34,56,789_000_000), first.getField(2));
        assertEquals(LocalDate.of(2026,9,5), first.getField(3));
        assertEquals(0, first.getField(4));
        assertEquals(2147483648L, first.getField(5));
        Row nullable = query(tables, "SELECT amount,event_time,event_date,topic_partition,topic_offset,status FROM orders WHERE order_id='o3'").get(0);
        for (int i = 0; i < nullable.getArity(); i++) { assertNull(nullable.getField(i)); }
        assertEquals(2L, query(tables, "SELECT COUNT(*) FROM orders WHERE status <> 'cancelled'").get(0).getField(0));
        Row aggregate = query(tables, "WITH paid AS (SELECT status,amount FROM orders WHERE status='paid') SELECT status,SUM(amount),COUNT(*) FROM paid GROUP BY status").get(0);
        assertEquals("paid", aggregate.getField(0));
        assertEquals(0, new BigDecimal("50.00").compareTo((BigDecimal) aggregate.getField(1)));
        assertEquals(2L, aggregate.getField(2));
        assertEquals(2L, query(tables, "SELECT COUNT(*) FROM orders o JOIN links l ON o.order_id=l.order_id").get(0).getField(0));
        assertEquals(1, query(tables, "SELECT order_id FROM orders LIMIT 1").size());

        tables.executeSql("CREATE TEMPORARY TABLE rejected(" + schema + ") WITH (" + options(url, "orders") + ",'scan.filter'='order_id=42')");
        Exception invalid = assertThrows(Exception.class, () -> tables.executeSql("SELECT COUNT(*) FROM rejected"));
        assertTrue(invalid.toString().contains("source") || invalid.toString().contains("Unsupported"));
    }

    private static String options(String url, String table) {
        return "'connector'='starrocks','jdbc-url'='" + url + "','scan-url'='unused:8030','database-name'='lab','table-name'='" + table + "','username'='sa','password'='','scan.params.batch-rows'='2'";
    }

    private static List<Row> query(TableEnvironment tables, String sql) throws Exception {
        List<Row> result = new ArrayList<>();
        try (CloseableIterator<Row> rows = tables.executeSql(sql).collect()) { rows.forEachRemaining(result::add); }
        return result;
    }
}
