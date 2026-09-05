# Kafka connector for Flink 2.3.0

Local coordinates: `com.zev.flink:flink-connector-kafka:5.0.0-flink-2.3.0-zev.1`.
The `sql` classifier is the self-contained connector installed in the Flink image.
This is a local build, not an Apache connector release.

Source: Apache Flink Kafka connector v5.0.0 (published upstream line `5.0.0-2.2`), commit
`2960af0eb26dfac3e224f5edf1db6f867888c62f`. The build downloads the pinned source
archive and checks SHA-256 before extraction. Its original LICENSE and NOTICE
are included in both artifacts. The source compiles directly against Flink 2.3.0;
no source patch is required. Kafka clients remain at the upstream 4.2.0 version.

Run `./build.ps1` with JDK 25 at `D:\jdk25`. The compiler uses `--release 17`.
Use `-MavenRepository <absolute-path>` for an isolated dependency cache.
The build installs the normal Java artifact and the shaded SQL artifact.
Kafka, Jackson, and Commons Lang are relocated in the SQL artifact to isolate
their versions from application libraries. Flink runtime dependencies remain provided.

Tests cover source construction, checkpoint offset serialization, and SQL factory
discovery. Full CDC, SQL, restart, and result checks run against the lab infrastructure.
