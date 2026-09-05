/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package com.starrocks.connector.flink.table.source;

import org.apache.flink.configuration.ConfigOption;
import org.apache.flink.configuration.ConfigOptions;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.configuration.ReadableConfig;
import org.apache.flink.table.api.ValidationException;

import java.io.Serializable;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/** The options implemented by the bounded JDBC source. */
public final class StarRocksSourceOptions implements Serializable {
    private static final long serialVersionUID = 1L;
    public static final ConfigOption<String> SCAN_URL = ConfigOptions.key("scan-url").stringType().noDefaultValue();
    public static final ConfigOption<String> JDBC_URL = ConfigOptions.key("jdbc-url").stringType().noDefaultValue();
    public static final ConfigOption<String> USERNAME = ConfigOptions.key("username").stringType().noDefaultValue();
    public static final ConfigOption<String> PASSWORD = ConfigOptions.key("password").stringType().noDefaultValue();
    public static final ConfigOption<String> DATABASE_NAME = ConfigOptions.key("database-name").stringType().noDefaultValue();
    public static final ConfigOption<String> TABLE_NAME = ConfigOptions.key("table-name").stringType().noDefaultValue();
    public static final ConfigOption<Integer> SCAN_CONNECT_TIMEOUT = ConfigOptions.key("scan.connect.timeout-ms").intType().defaultValue(1000);
    public static final ConfigOption<Integer> SCAN_BATCH_ROWS = ConfigOptions.key("scan.params.batch-rows").intType().defaultValue(1000);
    public static final ConfigOption<Integer> SCAN_QUERY_TIMEOUT_S = ConfigOptions.key("scan.params.query-timeout-s").intType().defaultValue(600);

    private final ReadableConfig tableOptions;
    private final Map<String, String> tableOptionsMap;

    public StarRocksSourceOptions(ReadableConfig options, Map<String, String> optionsMap) {
        tableOptions = options;
        tableOptionsMap = new HashMap<>(optionsMap);
        Set<String> supported = Set.of("connector", SCAN_URL.key(), JDBC_URL.key(), USERNAME.key(),
                PASSWORD.key(), DATABASE_NAME.key(), TABLE_NAME.key(), SCAN_CONNECT_TIMEOUT.key(),
                SCAN_BATCH_ROWS.key(), SCAN_QUERY_TIMEOUT_S.key());
        for (String key : optionsMap.keySet()) {
            if (!supported.contains(key)) {
                throw new ValidationException("Unsupported StarRocks bounded JDBC source option: " + key);
            }
        }
        for (ConfigOption<?> required : new ConfigOption<?>[]{SCAN_URL, JDBC_URL, USERNAME, PASSWORD, DATABASE_NAME, TABLE_NAME}) {
            if (options.getOptional(required).isEmpty()) {
                throw new ValidationException("Missing StarRocks source option: " + required.key());
            }
        }
        if (getBatchRows() <= 0 || getConnectTimeoutMs() <= 0 || getQueryTimeout() <= 0) {
            throw new ValidationException("StarRocks scan batch rows and timeouts must be positive");
        }
    }

    public String getScanUrl() { return tableOptions.get(SCAN_URL); }
    public String getJdbcUrl() { return tableOptions.get(JDBC_URL); }
    public String getUsername() { return tableOptions.get(USERNAME); }
    public String getPassword() { return tableOptions.get(PASSWORD); }
    public String getDatabaseName() { return tableOptions.get(DATABASE_NAME); }
    public String getTableName() { return tableOptions.get(TABLE_NAME); }
    public int getConnectTimeoutMs() { return tableOptions.get(SCAN_CONNECT_TIMEOUT); }
    public int getBatchRows() { return tableOptions.get(SCAN_BATCH_ROWS); }
    public int getQueryTimeout() { return tableOptions.get(SCAN_QUERY_TIMEOUT_S); }
    public StarRocksSourceOptions copy() {
        return new StarRocksSourceOptions(Configuration.fromMap(tableOptionsMap), tableOptionsMap);
    }
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private final Configuration configuration = new Configuration();
        public Builder withProperty(String key, String value) {
            configuration.setString(key, value);
            return this;
        }
        public StarRocksSourceOptions build() {
            return new StarRocksSourceOptions(configuration, configuration.toMap());
        }
    }
}
