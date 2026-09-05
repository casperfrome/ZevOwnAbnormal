/* Licensed under the Apache License, Version 2.0. See LICENSE. */
package com.starrocks.data.load.stream;

import com.starrocks.data.load.stream.properties.StreamLoadProperties;
import com.starrocks.data.load.stream.properties.StreamLoadTableProperties;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;

/** Exercises the actual vendored SDK HTTP protocol, without an external StarRocks service. */
class TransactionRecoveryProtocolTest {
    @ParameterizedTest
    @ValueSource(strings = {"VISIBLE", "COMMITTED", "PREPARED", "UNKNOWN"})
    void repeatedCommitChecksServerTransactionState(String state) throws Exception {
        AtomicInteger commits = new AtomicInteger();
        AtomicInteger stateReads = new AtomicInteger();
        AtomicReference<String> committedLabel = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            String path = exchange.getRequestURI().getPath();
            String body = "{}";
            if (path.equals("/api/transaction/commit")) {
                commits.incrementAndGet();
                committedLabel.set(exchange.getRequestHeaders().getFirst("label"));
                // FE can report TXN_NOT_EXISTS after a completed transaction or an expired one.
                body = "{\"Status\":\"TXN_NOT_EXISTS\",\"Message\":\"repeated commit\"}";
            } else if (path.equals("/api/db/get_load_state")) {
                stateReads.incrementAndGet();
                body = "{\"status\":\"OK\",\"state\":\"" + state + "\"}";
            }
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.start();
        TransactionStreamLoader loader = new TransactionStreamLoader(false);
        try {
            String host = "http://127.0.0.1:" + server.getAddress().getPort();
            StreamLoadProperties properties = StreamLoadProperties.builder().loadUrls(new String[]{host})
                    .username("test").password("").version("3.5.0").connectTimeout(1000).socketTimeout(1000)
                    .defaultTableProperties(StreamLoadTableProperties.builder().database("db").table("tbl")
                            .streamLoadDataFormat(StreamLoadDataFormat.JSON).build()).build();
            loader.start(properties, mock(StreamLoadManager.class));
            StreamLoadSnapshot.Transaction transaction = new StreamLoadSnapshot.Transaction("db", "tbl", "prepared-42");
            if (state.equals("VISIBLE") || state.equals("COMMITTED")) {
                assertTrue(loader.commit(transaction));
            } else {
                assertThrows(RuntimeException.class, () -> loader.commit(transaction));
            }
            assertEquals(1, commits.get());
            assertEquals(1, stateReads.get());
            assertEquals("prepared-42", committedLabel.get());
        } finally {
            loader.close();
            server.stop(0);
        }
    }
}
