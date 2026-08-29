# 异常监控平台

Sentinel 是基于 FastAPI 的数据异常监控平台。平台元数据保存在容器 MySQL 的 `zev_abnormal_app`，车辆温度业务数据保存在 `test_260828`；Kafka 承接推送任务，DolphinScheduler 负责编排，StarRocks 保留为空的数据服务供后续使用。

本文档面向 Windows 本地开发环境，所有命令均在项目根目录执行。

## 环境要求

- Windows 与 Docker Desktop
- Python：`D:\PythonVenv\Scripts\python.exe`
- Node.js 20+

```powershell
& 'D:\PythonVenv\Scripts\python.exe' -m pip install -r backend\requirements.txt
```

## 配置

根目录 `.env` 保存本机凭据且被 Git 忽略，`.env.example` 是模板。初始化脚本只补充配置；已有数据库密码、Fernet 密钥、会话密钥和内部令牌必须保留。

```powershell
& 'D:\PythonVenv\Scripts\python.exe' backend\scripts\bootstrap_env.py
```

关键数据库配置：

```dotenv
MYSQL_VERSION=8.4.8
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=zev_abnormal_app
MYSQL_USER=sentinel_app
MYSQL_PASSWORD=<本机密码>
DATABASE_URL=mysql+pymysql://sentinel_app:<本机密码>@127.0.0.1:3306/zev_abnormal_app?charset=utf8mb4
```

`MYSQL_ROOT_PASSWORD` 只允许存放在 `.env`。不要提交 `.env`、飞书凭据、数据库备份或运行日志。

## 数据库布局

| 服务 | 数据库 | 账号 | 用途 |
| --- | --- | --- | --- |
| MySQL `127.0.0.1:3306` | `zev_abnormal_app` | `sentinel_app` | 平台元数据，可读写 |
| MySQL `127.0.0.1:3306` | `test_260828` | `sentinel_app` | 车辆温度业务数据，只读 |
| StarRocks `127.0.0.1:9030` | 无预置业务库 | `root` | 保留服务能力 |
| PostgreSQL（Docker 网络） | `dolphinscheduler` | `dolphinscheduler` | DolphinScheduler 元数据 |

平台仅保留 `test_260828` 数据源、`配送车辆温度` 数据集和同名规则。旧塔斯汀演示造数及平台种子入口默认停用，避免重新创建已删除的数据。

## 首次启动

Compose 项目名固定为 `zev-own-abnormal`，MySQL 是默认服务。Kafka、StarRocks 和 DolphinScheduler 使用显式外部卷名称复用当前本机数据；迁移或排障时不得删除这些卷。

```powershell
docker compose config --quiet
docker compose up -d --wait --wait-timeout 600
& 'D:\PythonVenv\Scripts\python.exe' backend\scripts\bootstrap_host_mysql.py
Push-Location backend
& 'D:\PythonVenv\Scripts\python.exe' -m alembic -c alembic.ini upgrade head
Pop-Location
```

初始化脚本幂等创建 `zev_abnormal_app`、`test_260828` 和 `sentinel_app` 权限，不会造数或输出凭据。

## 部署验收

```powershell
docker compose ps -a
$containerIds = docker compose ps -aq
docker inspect $containerIds --format '{{.Name}} restart={{.RestartCount}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}} oom={{.State.OOMKilled}} exit={{.State.ExitCode}}'
Push-Location backend
& 'D:\PythonVenv\Scripts\python.exe' -m alembic -c alembic.ini current
& 'D:\PythonVenv\Scripts\python.exe' -m alembic -c alembic.ini heads
Pop-Location
```

验收标准：

- 所有常驻容器名称以 `zev-own-abnormal-` 开头且为 `healthy`，schema initializer 为 `Exited (0)`。
- MySQL 仅有 `zev_abnormal_app`、`test_260828` 和系统库。
- `sentinel_app` 可读写系统库、可查询 `test_260828.car_temperature`，但不能写业务库。
- StarRocks 中不存在旧 `tastien_ads`。
- Alembic current 与 head 一致，车辆温度数据源、数据集、规则和历史记录可用。

备份保存在仓库外，不要移动到项目目录。日常停止只使用 `docker compose down`，不要附加 `-v`。

## 日常启动

### 1. 启动 Docker 基础设施

```powershell
docker compose up -d --wait --wait-timeout 600
```

### 2. 启动 Sentinel

在一个 PowerShell 终端运行：

```powershell
& .\backend\start.ps1
```

启动脚本会先检查重复运行和端口占用，执行 Alembic 迁移，再以热重载模式启动 FastAPI。后端健康检查通过后，自动启动已配置的飞书长连接，无需再开一个终端。迁移失败或后端在 60 秒内未就绪时停止本次启动。

启动日志中的本机访问地址为 <http://127.0.0.1:8000>。实际仍监听 `0.0.0.0:8000`，以便 Docker 中的调度服务通过 `host.docker.internal:8000` 访问后端。

未配置飞书 App ID 和 Secret 时跳过长连接；配置不完整、连接失败或飞书进程退出时会明确提示，后端继续运行。只有日志显示“飞书连接成功，卡片回调已在线”才表示连接成功。网络断线由 SDK 自动重连；飞书进程退出后不会自动重新拉起，可排查后独立启动，或重启统一入口。

统一入口和飞书入口均有单实例锁；后端热重载不会重复启动飞书。Windows 子服务使用隐藏的独立控制台，避免 Uvicorn 重载信号误停其他服务，日志仍汇总到启动终端。运行中每 5 秒检查后端健康状态，连续异常 60 秒则停止本次启动的服务，允许正常热重载期间的短暂中断。如果已有独立飞书实例，统一入口会跳过，不接管该实例。首次从旧启动方式切换时，先停止原后端和原飞书进程，避免端口占用及旧版进程尚未持有单实例锁。

### 3. 独立启动飞书长连接（仅排障时需要）

需要单独排查飞书连接，或在飞书进程退出后恢复回调时，可在另一个终端运行：

```powershell
& 'D:\PythonVenv\Scripts\python.exe' .\飞书长连接启动\飞书长连接启动.py
```

长连接进程会读取根目录 `.env`，且不会覆盖终端中显式设置的环境变量。飞书开放平台需使用长连接订阅 `p2.card.action.trigger`。

## Kafka

### 定位与部署方式

Kafka 是异常推送管线的任务缓冲层，不负责保存异常业务明细。异常与持久推送任务先在 MySQL 的同一个事务中落库；后台任务随后只把推送任务 ID、类型和管线代际写入 Kafka，再由消费端为每条消息启动 DolphinScheduler 的 `sentinel-anomaly-push` 工作流。这样即使 Kafka、DolphinScheduler 或飞书暂时不可用，异常记录和待发送任务仍可保留并在恢复后继续处理。

本地环境使用 Kafka `4.3.1` 的单节点 KRaft 模式，Broker 和 Controller 位于同一容器，不依赖 ZooKeeper。数据存放在 Docker 卷 `kafka-data` 中：

| 使用方 | Bootstrap Server | 说明 |
| --- | --- | --- |
| Windows 宿主机上的 Sentinel | `localhost:9092` | `.env.example` 中的默认地址 |
| Docker 网络内的其他容器 | `kafka:29092` | 仅在 Compose 的 `infra` 网络内使用 |

项目默认只使用一条专用推送通道：

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `KAFKA_ANOMALY_PUSH_TOPIC` | `sentinel-anomaly-push` | 保存待派发的异常通知、互动校验和群聊播报任务 ID |
| `KAFKA_ANOMALY_PUSH_GROUP` | `sentinel-anomaly-push-dispatcher` | Sentinel 后台消费者的消费组 |

消息不包含异常业务明细、飞书凭据或内部令牌；完整状态以 MySQL 中的持久推送任务为准。Kafka 消费位点只表示消息已经成功交给 DolphinScheduler，不等同于飞书已经发送成功。

### 查看健康状态和积压

以下命令均在项目根目录的 PowerShell 中执行。

查看 Kafka 容器和健康状态：

```powershell
docker compose ps kafka
docker compose exec kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:29092 --list
```

查看专用 topic 的分区、副本和配置：

```powershell
docker compose exec kafka /opt/kafka/bin/kafka-topics.sh `
  --bootstrap-server kafka:29092 `
  --describe `
  --topic sentinel-anomaly-push
```

查看消费组位点和积压量；输出中的 `LAG` 是尚未被该消费组确认的消息数：

```powershell
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh `
  --bootstrap-server kafka:29092 `
  --describe `
  --group sentinel-anomaly-push-dispatcher
```

如果修改过 `.env` 中的 topic 或消费组名称，请把命令中的默认值替换为实际配置。首次还没有消费者位点时，消费组查询可能提示组不存在，这不代表 Kafka 容器不健康。

### Kafka 故障排查

按以下顺序定位问题：

1. `docker compose ps kafka` 确认容器为 `healthy`；否则运行 `docker compose logs --tail 200 kafka` 查看启动、磁盘和 KRaft 日志。
2. 用 topic 列表命令确认 Broker 可访问，再检查 `.env` 中 `KAFKA_BOOTSTRAP_SERVERS` 是否为宿主机可访问的 `localhost:9092`。
3. 确认 `sentinel-anomaly-push` 存在；Sentinel 启动后的推送后台循环会幂等创建该 topic。
4. 查看消费组的 `LAG`。持续增长通常表示 Sentinel 推送循环未运行、DolphinScheduler 不可用，或工作流启动持续失败。
5. 同时检查 Sentinel 日志中的“Kafka → DolphinScheduler 异常推送周期执行失败”，并按 [DolphinScheduler 使用指南](docs/dolphinscheduler-guide.md#故障排查) 查看工作流与任务实例。

不要手工删除 topic、重置消费组位点或清空 `kafka-data` 卷来处理普通积压，这些操作可能导致重复派发或丢失尚未调度的消息。需要停止所有未发送任务时，使用 Sentinel 异常记录页的“中止推送”；需要在依赖恢复后重试失败任务时，使用页面上的恢复操作。

## 异常推送链路

普通飞书通知和互动校验卡片统一使用以下链路：

```text
异常入库 → 持久推送任务 → Kafka → DolphinScheduler sentinel-anomaly-push → Sentinel 内部发送接口 → 飞书
```

- 异常与推送任务在同一个数据库事务中创建；Kafka 或 DolphinScheduler 暂时不可用时，异常记录仍会保留，后台恢复后继续处理。
- Kafka 消息只保存任务 ID、类型和管线代际，不包含异常业务明细、飞书凭据或内部令牌。
- 应用启动后会幂等创建 `sentinel-anomaly-push` topic 和同名 DolphinScheduler 共享工作流。规则执行成功表示异常及推送任务已经可靠入库，不表示飞书已即时送达。
- 互动校验的截止时间仍从异常检出时开始计算；失败重试也会重新经过 Kafka 和 DolphinScheduler。

DolphinScheduler 中两类工作流的命名、实例参数、日志查看和日常操作见 [DolphinScheduler 使用指南](docs/dolphinscheduler-guide.md)。

异常记录页右上角的“中止推送”仅对超级管理员开放。确认后会中止并清除操作时尚未发送的专用 DolphinScheduler 实例和 Kafka 积压，并把 Sentinel 中对应投递标记为“已中止”。异常记录不会删除，已经发送或正在等待飞书远端结果的消息无法撤回。操作完成后，新异常会使用新代际继续正常推送。

如果界面提示中止未完全完成，请按提示检查失败阶段后重试：

- `kafka`：确认 `KAFKA_BOOTSTRAP_SERVERS` 可访问，Kafka 容器健康，应用账号具有读取位点、删除记录和提交消费组位点的权限。
- `dolphinscheduler`：确认 API、Master、Worker 健康，配置账号可启动、停止和删除 `sentinel-anomaly-push` 工作流实例。
- `sending`：说明仍有飞书 HTTP 请求结果未落定；旧代际门闩会禁止其失败后再次重试，待请求落定后重新执行中止。

## 访问地址

| 服务 | 地址 |
| --- | --- |
| Sentinel | <http://localhost:8000> |
| Kafka Broker | `localhost:9092`（无 Web 管理界面） |
| DolphinScheduler | <http://localhost:12345/dolphinscheduler/ui> |
| StarRocks FE | <http://localhost:8030> |

## 停止服务

先在运行统一启动脚本的终端中按 `Ctrl+C`。启动管理器会停止本次启动的后端、热重载子进程及飞书长连接，正常退出等待最多 10 秒，超时后仅终止所属进程树。独立启动的飞书实例需在其原终端单独停止。随后停止 Docker 服务：

```powershell
docker compose down
```

该命令会保留数据库和其他服务的数据卷。不要将下面的命令作为日常停止方式：

```powershell
docker compose down -v
```

`-v` 会删除容器 MySQL 数据卷；其他基础设施卷由 Compose 作为外部卷复用。任何情况下都不要把 `down -v` 作为日常停止命令。

## 注意事项

- 生产和新生成的本地配置默认使用 `AUTO_LOGIN=false`，请通过 Sentinel 登录页建立登录会话。
- 真实环境必须修改所有默认账号、密码和令牌，不要继续使用本文档中的开发凭据。
- `SENTINEL_PUBLIC_BASE_URL` 在飞书真实验收时不能使用仅服务端可见的 `localhost`。
- 真实消息发送属于外部副作用，执行前必须再次确认接收者和发送范围。
- 异常实时校验的迁移、安全诊断和人工验收步骤见 [异常实时校验部署与验收](docs/anomaly-validation-acceptance.md)。
- DolphinScheduler 界面、工作流与项目业务关系、日志查看及故障处理见 [DolphinScheduler 使用指南](docs/dolphinscheduler-guide.md)。
- 前端页面与交互说明见 [前端 README](frontend/README.md)。

## 测试

```powershell
$env:SENTINEL_API_BASE_URL='http://127.0.0.1:8000'
& 'D:\PythonVenv\Scripts\python.exe' -m pytest backend\tests tests -q
Push-Location frontend
npm ci
npx playwright install chromium
npm test
Pop-Location
Get-ChildItem frontend\scripts\*.js | ForEach-Object { node --check $_.FullName }
docker compose config --quiet
```

测试使用 Node.js 20+ 和固定的 Playwright 1.62.1。需要使用已有浏览器时，通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定路径，详见前端 README。登录会话由服务端校验 24 小时有效期；升级前不含过期时间的旧会话需要重新登录。
