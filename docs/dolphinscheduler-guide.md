# DolphinScheduler 使用指南

本文档介绍本地 DolphinScheduler 界面、它与 Sentinel 业务对象的关系，以及日常查看和故障处理方法。内容以仓库当前使用的 DolphinScheduler `3.4.1` 为准；中英文界面的菜单名称可能略有差异，本文同时给出常见中英文名称。

## 访问与配置

完成 `docker compose up -d --wait --wait-timeout 600` 后访问：

- 界面：<http://localhost:12345/dolphinscheduler/ui>
- 本地开发用户名：`admin`
- 本地开发密码：`dolphinscheduler123`
- Sentinel 默认项目：`sentinel-mvp`

以上账号只来自 `.env.example` 的本地开发默认值，不得用于生产环境。DolphinScheduler 自身的 PostgreSQL 账号与界面登录账号相互独立。

Sentinel 通过 DolphinScheduler OpenAPI 自动维护项目、工作流和定时配置，相关环境变量如下：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `DOLPHINSCHEDULER_URL` | `http://localhost:12345/dolphinscheduler` | Sentinel 调用 DolphinScheduler API 的根地址 |
| `DOLPHINSCHEDULER_USERNAME` | `admin` | API 登录用户 |
| `DOLPHINSCHEDULER_PASSWORD` | `dolphinscheduler123` | API 登录密码 |
| `DOLPHINSCHEDULER_TENANT` | `default` | 工作流实例使用的租户 |
| `DOLPHINSCHEDULER_PROJECT` | `sentinel-mvp` | Sentinel 自动创建和维护的项目 |
| `TIMEZONE` | `Asia/Shanghai` | 规则定时的时区 |
| `RECONCILE_ON_STARTUP` | `true` | Sentinel 启动时重新同步所有已启用规则 |

DolphinScheduler Worker 通过 `SENTINEL_API_BASE_URL` 回调 Sentinel，并在请求头中携带内部令牌。当前 Docker Compose 从 `INTERNAL_EXECUTION_TOKEN` 向 Worker 注入 `SENTINEL_INTERNAL_TOKEN`；两者必须与 Sentinel 使用的主内部令牌保持一致。Worker 运行在容器内时，`127.0.0.1` 指向 Worker 容器自身，不能用于访问宿主机上的 Sentinel；本地 Docker Desktop 环境应使用 `http://host.docker.internal:8000`，并在修改 `.env` 后重新创建 Worker 容器。不要在界面、日志、截图或文档中暴露实际令牌。

## 界面导航

登录后进入“项目管理（Project Management）”，选择 `sentinel-mvp`。日常排查主要使用以下页面：

| 页面 | 常见路径 | 在本项目中的用途 |
| --- | --- | --- |
| 工作流定义 | 项目管理 → `sentinel-mvp` → 工作流定义（Workflow Definition） | 查看 Sentinel 自动创建的规则工作流和异常推送共享工作流 |
| 定时管理 | 项目管理 → `sentinel-mvp` → 定时管理（Schedule） | 查看每条规则同步后的 Quartz 定时表达式、启停状态和有效期 |
| 工作流实例 | 项目管理 → `sentinel-mvp` → 工作流实例（Workflow Instance） | 查看每次规则检测或异常推送的执行状态、开始时间和结束时间 |
| 任务实例 | 项目管理 → `sentinel-mvp` → 任务实例（Task Instance） | 查看具体 Shell 任务、重试次数、Worker 和任务日志 |
| 监控中心 | 监控中心（Monitoring） | 查看 Master、Worker、数据库和注册中心等组件是否在线 |

不同语言包或窗口宽度下，部分入口可能收纳在左侧项目菜单或实例详情页中。定位时优先使用工作流名称、任务名称、实例 ID 和执行时间搜索。

## 与 Sentinel 业务的关系

DolphinScheduler 在项目中承担两项不同职责：按规则定时触发异常检测，以及为 Kafka 中的每条持久推送任务创建隔离的发送实例。

```text
规则配置 ──同步──> sentinel-rule-{规则 UUID} ──定时回调──> Sentinel 规则执行接口

异常入库 ──> 持久推送任务 ──> Kafka ──派发──> sentinel-anomaly-push
                                              └──回调──> Sentinel 推送接口 ──> 飞书
```

### 规则检测工作流

每条 Sentinel 规则对应一个工作流：

- 工作流名称：`sentinel-rule-{规则 UUID}`，完整 UUID 与 Sentinel 数据库中的规则 ID 一致。
- Shell 任务名称：`detect-{规则 UUID 前 8 位}`。
- 任务行为：调用 `POST /api/internal/rules/{rule_id}/execute`，实际查询数据源、判断异常、持久化记录和创建推送任务的逻辑仍在 Sentinel 内执行。
- 调度来源：DolphinScheduler 定时触发的执行批次在 Sentinel 中记录为 `dolphinscheduler`；从 Sentinel 页面点击手动执行的批次记录为 `manual`。
- 执行策略：同一工作流使用 `SERIAL_DISCARD`，避免上一实例未结束时堆叠同一规则的新实例。
- 失败策略：Shell 任务超时为 300 秒，失败后重试 1 次，间隔 1 分钟。

Sentinel 保存 DolphinScheduler 返回的工作流 Code 和定时 ID。规则操作与调度对象的关系如下：

| Sentinel 操作 | DolphinScheduler 结果 |
| --- | --- |
| 新建并启用规则 | 创建或更新工作流和定时，并把工作流与定时上线 |
| 修改规则 | 规则先进入待同步状态；执行“同步”后更新工作流说明和定时配置 |
| 启用规则 | 同步工作流及定时并把定时上线；同步失败时规则会回退为禁用并记录错误 |
| 禁用或删除规则 | 将对应定时下线，保留历史实例供审计 |
| Sentinel 启动且 `RECONCILE_ON_STARTUP=true` | 重新同步当前所有已启用规则 |

规则的频率、间隔、开始日期、结束日期和时区会转换成 DolphinScheduler 的 Quartz Cron 定时。业务人员应在 Sentinel 中修改这些配置，不要直接编辑 DolphinScheduler 定时。

### 异常推送共享工作流

所有普通通知、互动校验和群聊播报共用一个工作流：

- 工作流名称：`sentinel-anomaly-push`。
- Shell 任务名称：`send-anomaly-push`。
- 工作流实例启动参数：`push_job_id`，值为 MySQL 中的持久推送任务 ID。
- 任务行为：调用 `POST /api/internal/anomaly-pushes/${push_job_id}/execute`，由 Sentinel 读取完整业务数据、控制幂等与租约并发送飞书消息。
- 执行策略：`PARALLEL`，允许不同推送任务并发执行。

Sentinel 后台消费者读取 Kafka 后，先成功启动 DolphinScheduler 工作流实例，再提交 Kafka 消费位点。因此 Kafka 的消费成功只说明任务已交给调度系统；最终是否发送成功，应以 Sentinel 推送任务状态和 DolphinScheduler 任务日志为准。

应用的推送后台循环会幂等创建或更新该共享工作流并使其上线。恢复推送管线时也会重新核对工作流定义。

## 日常使用

### 查看规则为什么没有按时执行

1. 在 Sentinel 规则页面确认规则已启用，且同步状态为成功；记录规则 UUID、计划执行时间和时区。
2. 打开 `sentinel-mvp` 的“工作流定义”，搜索 `sentinel-rule-{规则 UUID}`，确认工作流为上线状态。
3. 打开“定时管理”，按工作流名称或工作流 Code 筛选，确认定时为上线状态、Cron、开始时间、结束时间和时区符合 Sentinel 配置。
4. 打开“工作流实例”，按计划时间和工作流名称检查是否生成实例。
5. 若有失败实例，进入实例详情，再打开 `detect-{前 8 位}` 任务实例的日志，检查 Worker 是否能访问 Sentinel 以及 HTTP 返回状态。
6. 回到 Sentinel 查看对应执行批次；DolphinScheduler 成功只表示内部接口返回成功，扫描行数、命中数和新增异常数以 Sentinel 记录为准。

### 查看一条异常推送

1. 从 Sentinel 的异常记录或推送状态中取得持久推送任务 ID 和大致派发时间。
2. 在“工作流实例”中筛选 `sentinel-anomaly-push` 和对应时间范围。
3. 打开候选实例，在启动参数或全局参数中核对 `push_job_id`。
4. 进入 `send-anomaly-push` 任务实例查看日志。HTTP `2xx` 表示 Sentinel 已接受并完成该次执行；`401` 通常表示内部令牌不一致；连接失败通常表示 Worker 无法访问 Sentinel；`5xx` 需要结合 Sentinel 日志查看具体发送错误。
5. 最终状态以 Sentinel 的持久推送任务为准。不要仅根据工作流实例颜色判断飞书接收结果。

### 查看任务日志

可以从“工作流实例 → 实例详情 → 任务节点 → 查看日志”进入，也可以在“任务实例”中按任务名称直接搜索。日志中重点关注：

- 实际执行的 Worker 和重试次数；
- `curl` 的 HTTP 状态与响应正文；
- 是否出现连接拒绝、超时或 `401`；
- 实例的启动参数中是否有正确的 `push_job_id`。

任务脚本会从 Worker 容器环境读取回调地址和内部令牌。不要复制或传播可能含凭据的完整环境信息；排障记录只保留必要的状态码、任务 ID 和脱敏错误信息。

### 手动同步与恢复

- 单条规则配置变更后，优先在 Sentinel 规则页面执行“同步”；启用或禁用规则也应从 Sentinel 操作。
- 需要批量核对已启用规则时，在项目根目录运行：

  ```powershell
  & 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' backend\scripts\reconcile_schedules.py
  ```

- Kafka 或 DolphinScheduler 恢复后，使用 Sentinel 异常记录页提供的恢复操作。该操作会先检查 Kafka，再重新初始化 `sentinel-anomaly-push`，最后只重新排队可安全重试的失败任务。
- “中止推送”会停止并删除尚未完成的共享工作流实例、清理 Kafka 积压并把对应持久任务标记为已中止。它不会删除异常记录，也不能撤回已经发送的消息。

手工运行工作流可能产生真实异常记录和飞书消息。除明确的验收或故障演练外，不要直接在 DolphinScheduler 中点击“运行”或“重跑”；业务侧手动执行规则应使用 Sentinel 页面。

## 状态解读

| 现象 | 含义与下一步 |
| --- | --- |
| 工作流或定时不存在 | 规则尚未同步、同步失败，或项目配置不一致；先检查 Sentinel 规则同步错误和 `DOLPHINSCHEDULER_PROJECT` |
| 定时下线 | 对应 Sentinel 规则通常已禁用；若规则显示启用，重新执行同步 |
| 工作流实例一直等待或运行 | 查看 Master/Worker 在线状态、任务实例和 Worker 日志；推送实例还需核对 Sentinel 回调是否可达 |
| Shell 任务返回 `401` | `SENTINEL_INTERNAL_TOKEN` 与 `INTERNAL_EXECUTION_TOKEN` 不一致，修正后重启 Sentinel 和 Worker |
| Shell 任务连接 Sentinel 失败 | Sentinel 未启动，或 Worker 到宿主机的回调地址不可达；确认 `SENTINEL_API_BASE_URL` 不是容器内的 `127.0.0.1`，并核对 `host.docker.internal:8000` 是否可访问 |
| `sentinel-anomaly-push` 大量失败 | 先恢复 DolphinScheduler/Sentinel 回调，再从 Sentinel 页面执行恢复；不要在界面批量重跑历史实例 |
| 工作流成功但没有新异常 | 调度和接口调用成功，但规则可能未命中或异常已被去重；查看 Sentinel 执行批次的扫描、命中和新增数量 |
| Kafka `LAG` 持续增长 | Sentinel 消费循环、DolphinScheduler API 或共享工作流启动异常；联合检查 Sentinel、Kafka 和调度日志 |

## 故障排查

### 1. 检查组件健康

```powershell
docker compose ps dolphinscheduler-api dolphinscheduler-master dolphinscheduler-worker
docker compose logs --tail 200 dolphinscheduler-api
docker compose logs --tail 200 dolphinscheduler-master
docker compose logs --tail 200 dolphinscheduler-worker
```

API 提供登录和 OpenAPI，Master 负责编排实例，Worker 执行 Shell 任务。任一核心组件不健康都可能导致同步、定时或回调失败。还可在界面的“监控中心”核对 Master 和 Worker 是否在线。

### 2. 检查 Sentinel 到 DolphinScheduler

- 浏览器能打开界面但 Sentinel 同步失败时，核对 `DOLPHINSCHEDULER_URL` 是否包含 `/dolphinscheduler`，并检查 API 用户名和密码。
- 确认 `sentinel-mvp` 项目存在；项目名被修改后，Sentinel 会按配置创建另一个项目。
- 查看 Sentinel 日志中的 API 路径、状态码和脱敏错误，不要把真实密码或会话信息复制到工单。

### 3. 检查 Worker 到 Sentinel

- 本地 Docker Desktop 部署应让 Worker 通过 `http://host.docker.internal:8000` 访问宿主机上的 Sentinel。根目录 `.env` 若显式配置了 `SENTINEL_API_BASE_URL`，该值会覆盖 Compose 的默认回退值。
- 确认 Sentinel 已监听 `8000` 端口，且防火墙没有阻止 Docker Desktop 到宿主机的访问。
- `401` 时核对两个内部令牌，连接错误时核对回调地址，`5xx` 时查看 Sentinel 同时间段日志。

### 4. 检查 Kafka 到 DolphinScheduler 推送链路

按 [README 的 Kafka 故障排查](../README.md#kafka-故障排查) 查看 Broker、topic 和消费组积压。Kafka 消费组位点已前进但推送未完成时，继续查看 `sentinel-anomaly-push` 工作流实例；位点未前进时，优先查看 Sentinel 的推送后台循环日志。

### 5. 安全恢复

依赖恢复后从 Sentinel 页面执行恢复，由系统重新校验 Kafka 与共享工作流并筛选可重试任务。不要通过删除 DolphinScheduler 历史实例、批量重跑、重置 Kafka 位点或删除数据卷来恢复，这些操作绕过 Sentinel 的幂等、租约和管线代际保护。

## 自动管理边界

`sentinel-mvp` 中以下对象由 Sentinel 自动维护：

- `sentinel-rule-{规则 UUID}` 工作流及其定时；
- `sentinel-anomaly-push` 共享工作流；
- 其中的 `detect-*` 和 `send-anomaly-push` Shell 任务。

不要在 DolphinScheduler 界面中对这些对象执行改名、删除、复制替换、修改脚本、修改租户或 Worker Group、调整失败重试、手工上下线定时等操作。下一次规则同步、应用启动协调或推送恢复可能覆盖手工修改；更严重时会造成规则不再执行、重复推送或内部认证失败。

允许的日常操作以只读查看为主：筛选定义与实例、查看定时、查看任务参数和日志、确认组件健康。需要改变业务行为时始终从 Sentinel 页面或项目配置发起。

## 停止与数据保留

日常停止使用：

```powershell
docker compose down
```

该命令保留 DolphinScheduler 的 PostgreSQL、ZooKeeper、资源和日志卷。不要使用 `docker compose down -v` 处理调度故障；`-v` 会删除 DolphinScheduler、Kafka、MySQL 和 StarRocks 的本地数据卷，历史定义与实例无法通过 Compose 恢复。
