ARG FLINK_IMAGE=flink:2.3.0-java17@sha256:53eb8f289313d1a03e6800d37bc2dd916bbb5341961543285bf933aa27e63e5e
FROM ${FLINK_IMAGE}

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl default-mysql-client socat jq \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=flink:flink lib/ /opt/flink/lib/
RUN cd /opt/flink/lib && sha256sum --check SHA256SUMS

USER flink
