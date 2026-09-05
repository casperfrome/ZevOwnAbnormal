# Flink 2.3.0 Food Lab

本目录提供 `zev-own-abnormal` 共享基础设施中的 Flink 2.3.0 集群，包含 JobManager、
TaskManager、SQL Gateway，以及 MySQL → Debezium → Kafka → Flink → StarRocks 数仓链路。
学习台和 `Flink260904` 的 Java/SQL 作业使用同一套集群、不同 topic 和结果表。

## 开发和运行环境

| 用途 | 版本 |
| --- | --- |
| Windows 开发、Maven 构建 | JDK 25.0.2，`D:\jdk25` |
| Java 编译目标 | `--release 17` |
| Flink 容器 | Flink 2.3.0、Java 17，固定镜像摘要 |
| Python 脚本 | `D:\PythonVenv\Scripts\python.exe` |

JDK 25 编译 Java 17 字节码，提交给 Java 17 容器运行。构建脚本只调整自身进程的
`JAVA_HOME` 和 `PATH`，不会更改 Windows 全局配置。

TaskManager 提供 6 个槽位，进程内存 2 GiB，容器上限 2.5 GiB。数仓默认并行度 3，
门店作业并行度 1；剩余容量用于学习台的 SQL Gateway 查询。Java 与 SQL 门店作业仍应二选一。

## 构建与首次启动

在 `D:\AllForCareer\ZevOwnAbnormal` 执行：

```powershell
$env:JAVA_HOME = 'D:\jdk25'
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
mvn -version
& .\infra\flink-food-lab\flink\build.ps1
docker compose config --quiet
```

构建器先安装本地连接器，再生成共享 Flink 镜像，不会启动、停止作业或清理数据。
使用 `-MavenRepository 'D:\isolated-maven-cache'` 可验证独立依赖缓存构建。
`-EnvironmentFile` 可指定基础设施环境文件；其中的 Flink 镜像设置必须与本版本一致。

之后执行 `& 'D:\AllForCareer\flink学习\scripts\start.ps1'` 启动。首次启动会建立学习台专用 schema、
CDC connector 和作业；已有环境按记录的同版本保存点恢复。
`& 'D:\AllForCareer\flink学习\scripts\start.ps1' -Build` 可显式在启动前构建镜像，运行中的作业应先正常停止。

## 连接器维护

- Kafka：`com.zev.flink:flink-connector-kafka:5.0.0-flink-2.3.0-zev.1`，
  Java 作业使用普通 JAR，集群使用 `sql` classifier 的自包含 JAR。
- StarRocks：`com.zev.flink:flink-connector-starrocks:1.2.15-flink-2.3.0-zev.1`，
  提供公共 Sink V2 和 SQL 工厂，使用 Stream Load 事务保证 exactly-once。

这些是本项目维护的源码构建制品，不是官方发布的 Flink 2.3 连接器。
上游固定提交、许可证、实现调整和测试说明分别见 `connectors/kafka/README.md`
及 `connectors/starrocks/README.md`。`connectors/build-connectors.ps1` 统一构建并安装，
输出至被 Git 忽略的 `flink/lib/`；Docker 构建会验证 SHA-256 清单。
不要把其他版本的连接器手工复制进运行中的容器。

## 数据与状态

MySQL 使用 `flink_food_lab`；学习台消费 `flink-food-lab-orders-cdc`，维护五张
ODS/DWD/DWS/ADS 表。门店练习使用 `flink-food-lab-fake-data-260904-cdc` 和两张
`flink_test_260904*` 结果表。两者都写入 `flink_food_lab_warehouse`。
Sentinel 与 DolphinScheduler 的数据不属于实验重建范围。

普通停止使用学习台 `scripts/stop.ps1` 的 stop-with-savepoint；保存点失败时中止停机。
普通启动、停止不清理 MySQL、Kafka、StarRocks 或持久卷。保存点缺失或恢复失败时
保留数据并报错，明确确认重建后才清空学习台五张派生表并重放 Kafka。
重放要求 topic 历史完整，不能用从中途开始的 CDC 恢复累计状态。
禁止使用 `docker compose down -v` 清理共享环境。

## 验证

```powershell
Invoke-RestMethod http://127.0.0.1:8081/overview
Invoke-RestMethod http://127.0.0.1:8083/v1/info
& 'D:\AllForCareer\flink学习\scripts\verify.ps1'
```

版本必须为 2.3.0，作业与算子为 RUNNING，checkpoint 持续完成。学习台验证脚本默认
保留当前批次；只有专用测试环境才使用 `-AllowDataReset` 开启实验重置 E2E。
门店 Java/SQL 必须分别测试并核对相同 event-time 窗口，不得同时写入相同结果表。

Flink 的 [Java 兼容要求](https://nightlies.apache.org/flink/flink-docs-release-2.3/docs/deployment/java_compatibility/)、
[checkpoint](https://nightlies.apache.org/flink/flink-docs-release-2.3/docs/ops/state/checkpoints/)
和 [保存点](https://nightlies.apache.org/flink/flink-docs-release-2.3/docs/ops/state/savepoints/) 文档适用于本环境。

