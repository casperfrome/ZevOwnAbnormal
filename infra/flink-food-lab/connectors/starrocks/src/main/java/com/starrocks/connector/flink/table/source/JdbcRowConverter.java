/* Licensed under the Apache License, Version 2.0. See LICENSE. */
package com.starrocks.connector.flink.table.source;

import org.apache.flink.table.api.ValidationException;
import org.apache.flink.table.data.DecimalData;
import org.apache.flink.table.data.GenericRowData;
import org.apache.flink.table.data.StringData;
import org.apache.flink.table.data.TimestampData;
import org.apache.flink.table.types.logical.DecimalType;
import org.apache.flink.table.types.logical.LogicalType;
import org.apache.flink.table.types.logical.RowType;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;

final class JdbcRowConverter {
    private JdbcRowConverter() {}

    static void validate(LogicalType type) {
        switch (type.getTypeRoot()) {
            case CHAR: case VARCHAR: case BOOLEAN: case TINYINT: case SMALLINT: case INTEGER:
            case BIGINT: case FLOAT: case DOUBLE: case DECIMAL: case DATE: case TIME_WITHOUT_TIME_ZONE:
            case TIMESTAMP_WITHOUT_TIME_ZONE: case TIMESTAMP_WITH_LOCAL_TIME_ZONE: case BINARY: case VARBINARY:
                return;
            default: throw new ValidationException("Unsupported StarRocks JDBC source type: " + type);
        }
    }

    static GenericRowData read(ResultSet result, RowType rowType) throws SQLException {
        GenericRowData row = new GenericRowData(rowType.getFieldCount());
        for (int i = 0; i < rowType.getFieldCount(); i++) {
            row.setField(i, readField(result, i + 1, rowType.getTypeAt(i)));
        }
        return row;
    }

    private static Object readField(ResultSet result, int index, LogicalType type) throws SQLException {
        if (result.getObject(index) == null) { return null; }
        switch (type.getTypeRoot()) {
            case CHAR: case VARCHAR: return StringData.fromString(result.getString(index));
            case BOOLEAN: return result.getBoolean(index);
            case TINYINT: return result.getByte(index);
            case SMALLINT: return result.getShort(index);
            case INTEGER: return result.getInt(index);
            case BIGINT: return result.getLong(index);
            case FLOAT: return result.getFloat(index);
            case DOUBLE: return result.getDouble(index);
            case DECIMAL:
                DecimalType decimalType = (DecimalType) type;
                DecimalData value = DecimalData.fromBigDecimal(result.getBigDecimal(index), decimalType.getPrecision(), decimalType.getScale());
                if (value == null) { throw new SQLException("Decimal overflow at column " + index + " for " + type); }
                return value;
            case DATE: return Math.toIntExact(LocalDate.parse(result.getString(index)).toEpochDay());
            case TIME_WITHOUT_TIME_ZONE: return (int) (LocalTime.parse(result.getString(index)).toNanoOfDay() / 1_000_000);
            case TIMESTAMP_WITHOUT_TIME_ZONE:
                // Preserve the database wall-clock value, independent of the worker JVM timezone.
                return TimestampData.fromLocalDateTime(LocalDateTime.parse(result.getString(index).replace(' ', 'T')));
            case TIMESTAMP_WITH_LOCAL_TIME_ZONE: return TimestampData.fromInstant(result.getTimestamp(index).toInstant());
            case BINARY: case VARBINARY: return result.getBytes(index);
            default: throw new SQLException("Unsupported StarRocks JDBC source type: " + type);
        }
    }
}
