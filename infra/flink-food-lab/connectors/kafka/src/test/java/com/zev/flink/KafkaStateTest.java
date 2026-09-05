package com.zev.flink;

import org.apache.flink.connector.kafka.source.KafkaSource;
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer;
import org.apache.flink.connector.kafka.source.split.KafkaPartitionSplit;
import org.apache.flink.connector.kafka.source.split.KafkaPartitionSplitSerializer;
import org.apache.flink.api.common.serialization.SimpleStringSchema;
import org.apache.flink.api.connector.source.Boundedness;
import org.apache.flink.table.factories.Factory;
import org.apache.kafka.common.TopicPartition;
import org.junit.jupiter.api.Test;
import java.util.ServiceLoader;
import java.util.Set;
import java.util.stream.Collectors;
import static org.junit.jupiter.api.Assertions.*;

class KafkaStateTest {
    @Test void checkpointPreservesPartitionAndExactResumeOffsets() throws Exception {
        var serializer = new KafkaPartitionSplitSerializer();
        var split = new KafkaPartitionSplit(new TopicPartition("orders-cdc", 2), 1701, 1880);
        var restored = serializer.deserialize(serializer.getVersion(), serializer.serialize(split));
        assertEquals(split, restored);
        assertEquals(1701, restored.getStartingOffset());
        assertEquals(1880, restored.getStoppingOffset().orElseThrow());
    }
    @Test void unboundedSourceRetainsNoStoppingOffset() throws Exception {
        var serializer = new KafkaPartitionSplitSerializer();
        var split = new KafkaPartitionSplit(new TopicPartition("orders-cdc", 0), 0);
        assertTrue(serializer.deserialize(serializer.getVersion(), serializer.serialize(split)).getStoppingOffset().isEmpty());
        var source = KafkaSource.<String>builder().setBootstrapServers("localhost:9092")
            .setTopics("orders-cdc").setGroupId("isolated-test")
            .setStartingOffsets(OffsetsInitializer.earliest())
            .setValueOnlyDeserializer(new SimpleStringSchema()).build();
        assertEquals(Boundedness.CONTINUOUS_UNBOUNDED, source.getBoundedness());
    }
    @Test void sqlFactoriesAreDiscoverableOnFlink23() {
        Set<String> names = ServiceLoader.load(Factory.class).stream().map(p -> p.get().factoryIdentifier()).collect(Collectors.toSet());
        assertTrue(names.contains("kafka"));
        assertTrue(names.contains("upsert-kafka"));
    }
}
