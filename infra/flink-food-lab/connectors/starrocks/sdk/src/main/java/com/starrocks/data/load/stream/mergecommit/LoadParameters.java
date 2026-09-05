/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package com.starrocks.data.load.stream.mergecommit;

import com.starrocks.data.load.stream.StreamLoadDataFormat;
import com.starrocks.data.load.stream.compress.LZ4FrameCompressionCodec;
import com.starrocks.data.load.stream.properties.StreamLoadTableProperties;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

public class LoadParameters {

    public static final String TIMEOUT = "timeout";
    public static final int DEFAULT_TIMEOUT_SECONDS = 600;

    public static final String ENABLE_MERGE_COMMIT = "enable_merge_commit";
    public static final String MERGE_COMMIT_INTERVAL_MS = "merge_commit_interval_ms";
    public static final String MERGE_COMMIT_PARALLEL = "merge_commit_parallel";
    public static final String MERGE_COMMIT_ASYNC = "merge_commit_async";

    public static Map<String, String> getParameters(StreamLoadTableProperties properties) {
        Map<String, String> parameters = new HashMap<>();
        parameters.putAll(properties.getCommonProperties());
        parameters.putAll(properties.getProperties());
        if (!parameters.containsKey(TIMEOUT)) {
            parameters.put(TIMEOUT, String.valueOf(DEFAULT_TIMEOUT_SECONDS));
        }
        Optional<String> compressionType = properties.getProperty("compression");
        // To enable csv compression, at the connector side, the user need to set two properties:
        // "format = csv" and "compression = <compression type>". It needs to be converted to one
        // header "format = <compression type>" which matches the server usage. In the future, the
        // server will be refactored to configure the compression type in the same way as the connector,
        // and this conversion will be removed.
        if (properties.getDataFormat() instanceof StreamLoadDataFormat.CSVFormat && compressionType.isPresent()) {
            // You can see the format name for different compression types here
            // https://github.com/StarRocks/starrocks/blob/main/be/src/http/action/stream_load.cpp#L96
            if (LZ4FrameCompressionCodec.NAME.equalsIgnoreCase(compressionType.get())) {
                parameters.put("format", "lz4");
            } else {
                throw new UnsupportedOperationException(
                        "CSV format does not support compression type: " + compressionType.get());
            }
        }
        return parameters;
    }
}
