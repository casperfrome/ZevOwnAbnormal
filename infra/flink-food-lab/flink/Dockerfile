ARG FLINK_IMAGE=flink:1.20.4-scala_2.12-java17
FROM ${FLINK_IMAGE}

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl default-mysql-client socat \
    && rm -rf /var/lib/apt/lists/*

ADD --chown=flink:flink https://repo1.maven.org/maven2/org/apache/flink/flink-sql-connector-kafka/3.3.0-1.20/flink-sql-connector-kafka-3.3.0-1.20.jar /opt/flink/lib/
ADD --chown=flink:flink https://repo1.maven.org/maven2/com/starrocks/flink-connector-starrocks/1.2.14_flink-1.20/flink-connector-starrocks-1.2.14_flink-1.20.jar /opt/flink/lib/

USER flink
