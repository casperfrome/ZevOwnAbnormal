# Sentinel 塔斯汀数据异常监控平台

Sentinel 是一个基于 FastAPI 的数据异常监控平台。前端页面由 FastAPI 同源提供，平台元数据存储在 MySQL `app`，门店订单演示数据存储在 MySQL `tastien_prod`，经营指标数据存储在 StarRocks `tastien_ads`，规则调度由 DolphinScheduler 执行。

本文档面向 Windows 本地开发环境，所有命令均在项目根目录 `D:\260809` 下执行。

## 环境要求

- Windows 与 Docker Desktop
- 建议至少 16 GiB 可用内存
- Python 虚拟环境：`D:\PythonVEnv\FirstVEnv\Scripts\python.exe`
- 项目依赖：`backend\requirements.txt`

先安装 Python 依赖：

```powershell
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' -m pip install -r backend\requirements.txt
```

## 配置

项目根目录包含以下配置文件：

- `.env.example`：本地开发配置模板，包含 Docker 镜像版本、端口、资源限制和默认开发凭据。
- `.env`：本机实际配置，由应用与 Docker Compose 读取；该文件已被 Git 忽略，不应提交。
- `backend\scripts\bootstrap_env.py`：生成 `.env`，同时从 `D:\飞书里尔机器人凭证.txt` 读取飞书 App ID 和 App Secret，并随机生成加密密钥、会话密钥和内部令牌。

推荐使用初始化脚本生成配置：

```powershell
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' backend\scripts\bootstrap_env.py
```

运行前需确保 `D:\飞书里尔机器人凭证.txt` 存在，并包含 `App ID` 和 `App Secret`。脚本会覆盖根目录现有的 `.env`，但不会复制或修改原凭证文件。

脚本会同时生成同值的 `SENTINEL_INTERNAL_TOKEN` 与 `INTERNAL_EXECUTION_TOKEN`。当前 Docker Compose 通过兼容变量向 DolphinScheduler Worker 传递令牌；两者不同会导致调度回调认证失败。以下尖括号内容仅为说明，配置时请替换为实际令牌，不要原样复制：

```dotenv
SENTINEL_INTERNAL_TOKEN=<脚本生成的令牌>
INTERNAL_EXECUTION_TOKEN=<与上一行完全相同的令牌>
```

如需手动配置，可从模板创建 `.env`：

```powershell
Copy-Item .env.example .env
```

手动配置时，至少核对以下变量：

| 类别 | 变量 | 说明 |
| --- | --- | --- |
| 应用数据库 | `DATABASE_URL` | Sentinel 元数据库连接地址 |
| 数据源加密 | `DATASOURCE_ENCRYPTION_KEY` | 必须替换模板占位值，且必须是有效 Fernet 密钥 |
| 登录会话 | `SESSION_SECRET` | 必须替换模板占位值 |
| 内部调用 | `SENTINEL_INTERNAL_TOKEN` | FastAPI 与飞书长连接使用的主令牌 |
| 内部调用 | `INTERNAL_EXECUTION_TOKEN` | 当前 Docker Compose 传给 DolphinScheduler Worker 的兼容变量，值必须与 `SENTINEL_INTERNAL_TOKEN` 相同 |
| 管理员 | `SUPERADMIN_USERNAME`、`SUPERADMIN_PASSWORD` | Sentinel 登录账号和密码 |
| 飞书 | `FEISHU_APP_ID`、`FEISHU_APP_SECRET` | 使用飞书通知或长连接时必填 |
| 服务地址 | `SENTINEL_PUBLIC_BASE_URL` | 卡片详情链接地址，真实验收时必须能从接收者设备访问 |
| 服务地址 | `SENTINEL_API_BASE_URL` | 飞书长连接进程访问 FastAPI 的地址 |
| 推送队列 | `KAFKA_BOOTSTRAP_SERVERS`、`KAFKA_ANOMALY_PUSH_TOPIC`、`KAFKA_ANOMALY_PUSH_GROUP` | 异常推送 Kafka 地址、专用 topic 与消费组 |
| 调度平台 | `DOLPHINSCHEDULER_URL`、`DOLPHINSCHEDULER_USERNAME`、`DOLPHINSCHEDULER_PASSWORD` | DolphinScheduler API 连接配置 |

手动复制模板后，必须替换 `DATASOURCE_ENCRYPTION_KEY`、`SESSION_SECRET` 和两个值相同的内部令牌占位值。仅在启用飞书通知或长连接时填写真实 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`。

不要将真实飞书凭据、随机密钥或内部令牌写入 README、日志或 Git。

## 本地数据库账号

以下均为仓库内置的本地开发默认值，不应用于生产环境。

| 服务 | 地址 | 数据库 | 用户名 | 密码 | 用途 |
| --- | --- | --- | --- | --- | --- |
| MySQL | `127.0.0.1:3306` | `app` | `app` | `dev_app_password` | Sentinel 平台元数据 |
| MySQL | `127.0.0.1:3306` | `tastien_prod` | `app` | `dev_app_password` | 门店订单演示数据 |
| MySQL | `127.0.0.1:3306` | 全部数据库 | `root` | `dev_root_password` | 本地数据库管理与演示数据初始化 |
| StarRocks | `127.0.0.1:9030` | `tastien_ads` | `root` | 空密码 | 经营 ADS 演示数据 |
| PostgreSQL | `dolphinscheduler-postgresql:5432` | `dolphinscheduler` | `dolphinscheduler` | `dev_dolphinscheduler_password` | DolphinScheduler 内部元数据 |

DolphinScheduler PostgreSQL 默认只在 Docker 网络内使用，没有映射到宿主机端口。

系统页面登录账号与数据库账号相互独立：

| 系统 | 用户名 | 密码 |
| --- | --- | --- |
| Sentinel | `admin` | `Admin@123456` |
| DolphinScheduler | `admin` | `dolphinscheduler123` |

## 首次初始化

完成配置后，启动基础设施并等待所有容器健康：

```powershell
docker compose up -d --wait --wait-timeout 600
```

随后执行数据库迁移、生成演示数据并初始化平台数据：

```powershell
Push-Location backend
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' -m alembic -c alembic.ini upgrade head
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' scripts\generate_demo_data.py --reset
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' scripts\seed_platform.py
Pop-Location
```

默认会生成 12,000 家门店、近 30 天 1,000,000 笔订单，以及约 360,000 行门店日 ADS 数据。查看或调整造数参数：

```powershell
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' backend\scripts\generate_demo_data.py --help
```

`--reset` 会重建 `tastien_prod` 和 `tastien_ads` 演示数据库。执行前请确认其中没有需要保留的数据。

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

启动脚本会先执行 Alembic 迁移，再以热重载模式启动 FastAPI。

### 3. 启动飞书长连接（可选）

需要接收飞书卡片回调时，在另一个终端运行：

```powershell
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' .\飞书长连接启动\飞书长连接启动.py
```

长连接进程会读取根目录 `.env`，且不会覆盖终端中显式设置的环境变量。飞书开放平台需使用长连接订阅 `p2.card.action.trigger`。

## 异常推送链路

普通飞书通知和互动校验卡片统一使用以下链路：

```text
异常入库 → 持久推送任务 → Kafka → DolphinScheduler sentinel-anomaly-push → Sentinel 内部发送接口 → 飞书
```

- 异常与推送任务在同一个数据库事务中创建；Kafka 或 DolphinScheduler 暂时不可用时，异常记录仍会保留，后台恢复后继续处理。
- Kafka 消息只保存任务 ID、类型和管线代际，不包含异常业务明细、飞书凭据或内部令牌。
- 应用启动后会幂等创建 `sentinel-anomaly-push` topic 和同名 DolphinScheduler 共享工作流。规则执行成功表示异常及推送任务已经可靠入库，不表示飞书已即时送达。
- 互动校验的截止时间仍从异常检出时开始计算；失败重试也会重新经过 Kafka 和 DolphinScheduler。

异常记录页右上角的“中止推送”仅对超级管理员开放。确认后会中止并清除操作时尚未发送的专用 DolphinScheduler 实例和 Kafka 积压，并把 Sentinel 中对应投递标记为“已中止”。异常记录不会删除，已经发送或正在等待飞书远端结果的消息无法撤回。操作完成后，新异常会使用新代际继续正常推送。

如果界面提示中止未完全完成，请按提示检查失败阶段后重试：

- `kafka`：确认 `KAFKA_BOOTSTRAP_SERVERS` 可访问，Kafka 容器健康，应用账号具有读取位点、删除记录和提交消费组位点的权限。
- `dolphinscheduler`：确认 API、Master、Worker 健康，配置账号可启动、停止和删除 `sentinel-anomaly-push` 工作流实例。
- `sending`：说明仍有飞书 HTTP 请求结果未落定；旧代际门闩会禁止其失败后再次重试，待请求落定后重新执行中止。

## 访问地址

| 服务 | 地址 |
| --- | --- |
| Sentinel | <http://localhost:8000> |
| DolphinScheduler | <http://localhost:12345/dolphinscheduler/ui> |
| StarRocks FE | <http://localhost:8030> |

## 停止服务

先在运行 Sentinel 和飞书长连接的终端中按 `Ctrl+C`，再停止 Docker 服务：

```powershell
docker compose down
```

该命令会保留数据库和其他服务的数据卷。不要将下面的命令作为日常停止方式：

```powershell
docker compose down -v
```

`-v` 会删除本地 MySQL、StarRocks、Kafka 和 DolphinScheduler 数据卷，其中的数据无法通过 Docker Compose 恢复。

## 注意事项

- 生产和新生成的本地配置默认使用 `AUTO_LOGIN=false`，请通过 Sentinel 登录页建立登录会话。
- 真实环境必须修改所有默认账号、密码和令牌，不要继续使用本文档中的开发凭据。
- `SENTINEL_PUBLIC_BASE_URL` 在飞书真实验收时不能使用仅服务端可见的 `localhost`。
- 真实消息发送属于外部副作用，执行前必须再次确认接收者和发送范围。
- 异常实时校验的迁移、安全诊断和人工验收步骤见 [异常实时校验部署与验收](docs/anomaly-validation-acceptance.md)。
- 前端页面与交互说明见 [前端 README](frontend/README.md)。

## 测试

```powershell
$env:SENTINEL_API_BASE_URL='http://127.0.0.1:8000'
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' -m pytest backend\tests -q
Push-Location frontend
node --test
Pop-Location
Get-ChildItem frontend\scripts\*.js | ForEach-Object { node --check $_.FullName }
docker compose config --quiet
```
