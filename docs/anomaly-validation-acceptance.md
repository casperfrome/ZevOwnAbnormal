# 异常实时校验：部署、诊断与人工验收

本文面向部署人员和验收人员。自动化测试和诊断命令不会读取、打印或写入任何凭证，也不会主动向飞书发送消息。启动真实服务时，应用会按正常运行要求从环境读取凭证。真实消息 smoke 必须在执行当时再次获得外部副作用授权；没有该授权时，只运行自动化测试和本地诊断。

## 1. 配置边界

从 `.env.example` 复制本地 `.env`，不要提交 `.env`。以下值用途不同：

- `SENTINEL_PUBLIC_BASE_URL`：写入飞书卡片“查看异常详情”深链的浏览器地址。真实验收必须是接收者设备可访问的完整 `http://` 或 `https://` 地址；`localhost`/`127.0.0.1` 仅适合浏览器与 Sentinel 在同一台机器上的本地验证。生产建议使用 HTTPS。`#records/<uuid>` 是浏览器 fragment，不会随 HTTP 请求发送给服务器；反向代理只需正确提供 SPA 根文档、静态资源和 API，无需配置带 `#` 的服务端路由。
- `SENTINEL_API_BASE_URL`：飞书长连接进程调用 FastAPI 的服务端地址。长连接和 FastAPI 同机时可保持 `http://127.0.0.1:8000`，不要求暴露到公网。
- `INTERNAL_EXECUTION_TOKEN` / `SENTINEL_INTERNAL_TOKEN`：FastAPI 与长连接进程使用的同一共享令牌；`bootstrap_env.py` 会为两者写入同一个随机值。不要将值写入命令历史、日志或文档。
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET`：同一飞书应用的凭证。不要用命令打印它们。
- `VALIDATION_TIMEOUT_SCAN_INTERVAL_SECONDS`：超时扫描与卡片收敛周期，默认 `60` 秒。
- `VALIDATION_MAINTENANCE_BATCH_SIZE`：每轮初始投递和终态卡片收敛的最大候选数，默认 `50`；未完成项留待下一轮。
- `FEISHU_HTTP_TIMEOUT_SECONDS`：单次飞书 HTTP 调用超时，默认 `10` 秒；维护轮次可在每次外部调用之间取消。
- `AUTO_LOGIN`：生产默认 `false`。`/auth/me` 必须验证签名 cookie/JWT 及当前数据库用户，管理写操作还要求当前用户是超级管理员。公共卡片深链也要求先建立登录会话。

不要用通用环境转储、shell tracing 或调试代理检查这些设置。启动器会在连接前只报告缺失的变量名，不会打印变量值。

## 2. 迁移与启动

安装依赖后，必须先从 `20260809_0001` 升级到当前 `head`：

```powershell
Push-Location backend
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' -m alembic -c alembic.ini current
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' -m alembic -c alembic.ini upgrade head
Pop-Location
```

正式数据库升级前先备份。历史规则迁移后保持 `validation_enabled=false`，历史异常不补建校验截止时间。

演示数据兼容说明：`generate_demo_data.py` 会通过 `information_schema.columns` 检查旧版
`ads_store_daily_operation`，必要时提交 StarRocks `ADD COLUMN manager_user_id`，等待异步 schema change
可见后才使用显式列名写入。轮询会检查 `SHOW ALTER TABLE COLUMN FROM tastien_ads`；任务进入
`CANCELLED`/`FAILED` 时立即报告任务 ID、状态和 StarRocks 返回的原因，超时时也附带最近任务状态。
三张 `ads_*_daily_operation` 表是此生成器的专用完整输出，所以每次运行（包括不带 `--reset`）都会先仅清空
这三张表再写入一套确定数据，避免 Duplicate Key 表保留旧 12 列行或叠加重复 snapshot；其他表不会被清空。
`--reset` 仍额外负责删除并重建整个 demo 数据库。

`seed_platform.py` 只在 datasource 的名称、类型、主机、端口、数据库、用户、SSL、密码占位和描述均匹配
seed 指纹时创建 demo Dataset/规则；更新时还要求 Dataset 精确匹配旧 demo SQL/字段。即使 SQL/字段看似旧版，
同名自定义 datasource 也只提示并跳过创建或迁移。规则只有在 demo 特征匹配、`enabled=false`、实时校验未启用且目标为空时才会
自动加入字段 target；启用中的规则只提示先停用核对，不改 validation 配置。

可用一次性 SQLite 文件验证完整 `0001 -> head` 链，不触碰正式数据库：

```powershell
$acceptanceDb = Join-Path $env:TEMP ("sentinel-migration-" + [guid]::NewGuid().ToString('N') + '.sqlite')
$previousDatabaseUrl = $env:DATABASE_URL
try {
  $env:DATABASE_URL = 'sqlite+pysqlite:///' + ($acceptanceDb -replace '\\', '/')
  Push-Location backend
  & 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' -m alembic -c alembic.ini upgrade 20260809_0001
  if ($LASTEXITCODE -ne 0) { throw 'Alembic 0001 migration failed' }
  & 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' -m alembic -c alembic.ini upgrade head
  if ($LASTEXITCODE -ne 0) { throw 'Alembic head migration failed' }
  & 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' -m alembic -c alembic.ini current
  if ($LASTEXITCODE -ne 0) { throw 'Alembic current check failed' }
  Pop-Location
} finally {
  $env:DATABASE_URL = $previousDatabaseUrl
  if ((Get-Location).Path -like '*\backend') { Pop-Location }
}
Write-Host "一次性迁移数据库保留在: $acceptanceDb"
```

`20260809_0001` 已冻结为原始平台表定义，后续模型只由后续 revision 引入。正式 MySQL 升级前，可在明确允许
启动本地 Docker 容器时运行下面的可丢弃 MySQL 8.4 门禁；它不会连接正式数据库，也不会使用真实凭证：

```powershell
$gateName = 'sentinel-mysql-migration-' + [guid]::NewGuid().ToString('N')
$previousDatabaseUrl = $env:DATABASE_URL
$pushedBackend = $false
try {
  docker run --detach --rm --name $gateName `
    --env MYSQL_ALLOW_EMPTY_PASSWORD=yes --env MYSQL_DATABASE=app `
    --publish 127.0.0.1::3306 mysql:8.4.10 | Out-Null
  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    docker exec $gateName mysqladmin ping --silent 2>$null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $ready) { throw 'Disposable MySQL did not become ready' }
  $binding = (docker port $gateName 3306/tcp | Select-Object -First 1).Trim()
  $gatePort = $binding.Substring($binding.LastIndexOf(':') + 1)
  $env:DATABASE_URL = "mysql+pymysql://root@127.0.0.1:$gatePort/app?charset=utf8mb4"
  Push-Location backend
  $pushedBackend = $true
  & 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' -m alembic -c alembic.ini upgrade head
  if ($LASTEXITCODE -ne 0) { throw 'MySQL Alembic upgrade failed' }
  & 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' -m alembic -c alembic.ini current
  if ($LASTEXITCODE -ne 0) { throw 'MySQL Alembic current check failed' }
} finally {
  if ($pushedBackend) { Pop-Location }
  $env:DATABASE_URL = $previousDatabaseUrl
  if (docker inspect $gateName 2>$null) { docker rm --force $gateName | Out-Null }
}
```

启动 FastAPI（脚本会先执行 `alembic upgrade head`）：

```powershell
& .\backend\start.ps1
```

另一个终端中确认健康检查；只显示公开健康状态，不显示配置：

```powershell
Invoke-RestMethod 'http://127.0.0.1:8000/api/v1/health'
```

随后启动飞书长连接；启动器自动读取仓库根 `.env`，且不覆盖终端显式环境变量：

```powershell
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' .\飞书长连接启动\飞书长连接启动.py
```

启动器会在建立 WebSocket 前检查四个必需变量，并注册 `p2.card.action.trigger`。内部 API 或网络错误只返回通用错误卡片，不会终止长连接进程。

## 3. 飞书应用配置

在飞书开放平台进入同一个应用：

1. 在“事件与回调/事件配置”选择“使用长连接接收事件”。
2. 添加卡片回传交互事件 `p2.card.action.trigger`，保存并发布所需应用版本。
3. 确认应用具备向目标用户发送消息及更新卡片所需权限，并已安装到验收组织。
4. 不要为这条链路额外配置公网回调 URL；SDK 长连接接收事件后，会调用 `SENTINEL_API_BASE_URL/api/internal/feishu/card-actions`。

`SENTINEL_PUBLIC_BASE_URL` 不负责接收飞书回调，但卡片接收者必须能从自己的网络打开 `${SENTINEL_PUBLIC_BASE_URL}/#records/<uuid>`，并先通过部署登录流程（`POST /api/v1/auth/login`）建立有效会话；深链不会自动授予超级管理员身份。人工 smoke 前，应从目标用户实际使用的浏览器或外部网络访问该地址及 `/api/v1/health`，不能只在服务端本机验证。

## 4. 无外部副作用的自动验收

以下测试在 HTTP 边界使用本地 fake/mock，不会向真实飞书发送消息：

```powershell
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' -m pytest backend\tests tests -q

# Codex 桌面开发环境：先使用 “Load workspace dependencies” 加载内置 Playwright。
# 标准开发环境：按团队锁定的 Node 依赖安装流程提供 playwright，然后确认：
node -e "require.resolve('playwright'); console.log('Playwright dependency ready')"
Push-Location frontend
node --test
Pop-Location

& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' -m compileall -q backend tests 飞书长连接启动
Get-ChildItem frontend -Recurse -Filter '*.js' -File | ForEach-Object { node --check $_.FullName }
```

不要把 Codex 用户名、runtime hash 或绝对 `node_modules` 路径写入项目文档，也不要联网安装未锁定的临时版本。

回归覆盖索引：

| 验收行为 | 自动化证据 |
| --- | --- |
| 多接收人、空字段值、去重 | `backend/tests/test_validation_service.py::test_snapshot_creates_ordered_unique_requests_and_suppresses_matching_legacy_text` |
| 数据行完全缺少目标字段 | `backend/tests/test_validation_service.py::test_missing_row_field_target_creates_no_validation_request` |
| 投递三次重试、幂等键、远端结果不确定 | `test_delivery_retries_real_feishu_gateway_and_persists_success`、`test_delivery_retry_uses_stable_remote_idempotency_key`、`test_lost_sent_commit_becomes_uncertain_after_dedupe_window_without_resend` |
| 回调篡改、message/anomaly 关系、操作者不匹配 | `backend/tests/test_validation_api.py::test_feishu_callback_returns_safe_transport_errors_for_bad_relationships` |
| 空内容、超长内容 | `backend/tests/test_validation_service.py::test_invalid_submission_text_is_rejected_without_resolving` 与 API 空内容回归 |
| 重复回调、多人首胜 | `test_duplicate_winner_is_idempotent_nonwinner_is_resolved_and_record_cannot_reopen`、`test_concurrent_callbacks_persist_exactly_one_winner` |
| 超时幂等、迟交、超时/提交竞态 | `test_timeout_is_idempotent_and_late_submission_resolves`、`test_expiration_cannot_overwrite_a_concurrent_resolution` |
| 管理员解决与竞态保护 | `test_named_admin_can_manually_resolve`、`backend/tests/test_validation_api.py::test_manual_resolution_uses_authenticated_admin_not_forged_assignee` |
| 卡片关闭失败重试与收敛 | `test_card_patch_failure_is_retryable_and_does_not_rollback_resolution`、`test_timed_out_card_reconciliation_converges_after_one_success` |
| 有效深链实际拉取并打开详情；未知 UUID 提示且保留列表 | `frontend/tests/anomaly_validation_ui.test.js` 的两条 real `records.js` deep-link 回归 |
| 长连接订阅、标准化与错误隔离 | `tests/test_feishu_long_connection.py` |

## 5. 真实消息人工 smoke（必须再次授权）

仅当凭证已配置、应用权限已发布、公共深链已从目标用户网络验证，并且执行当时明确授权发送真实飞书消息后，才执行本节。验收目标为 `user_id=753f6bdf`；该值只用于本次人工验收，不写入 seed、生产默认值或自动化脚本。

1. 启动 FastAPI 和长连接，确认两者无配置错误。
2. 从 `GET /api/v1/datasets` 取得准备验收的数据集 UUID，然后用下面的最小完整 payload 新建临时规则。请求明确发送 `enabled:false`；不要依赖服务端替调用方停用，也不要在这一步使用原有启用规则：

   ```json
   {
     "name": "人工验收-实时校验-唯一后缀",
     "description": "仅用于已授权的人工 smoke",
     "dataset_id": "<DATASET_UUID>",
     "severity": "high",
     "logic": "AND",
     "conditions": [{"field": "refund_rate", "operator": "gt", "value": 0.15}],
     "anomaly_key_fields": ["store_id", "metric_date"],
     "schedule": {"frequency": "day", "interval": 1, "time": "09:00", "start_date": "2026-08-22", "end_date": null},
     "notification_targets": [{"receive_id_type": "user_id", "source": "literal", "value": "753f6bdf"}],
     "validation_enabled": true,
     "validation_targets": [{"source": "literal", "value": "753f6bdf"}],
     "validation_timeout_minutes": 1440,
     "enabled": false
   }
   ```

3. `notification_targets` 是必填项。上面的普通通知目标和互动校验目标是同一位固定 `user_id`；服务会抑制这个接收人的重复旧文本通知，只保留互动卡片。本 smoke 不添加第二接收者，也不使用 seed 的 `manager_user_id` 字段 target。
4. 检查 POST 响应并通过 GET/UI 复核：`enabled=false`、普通通知目标恰好一个、校验目标恰好一个，二者都为上述固定 `user_id`。到此仍没有外部发送。
5. 仅在执行当时再次确认本次真实发送已获明确授权，之后才允许发送后续规则 PUT（若部署流程需要）、调用 `/rules/{rule_id}/enable` 或 `/rules/{rule_id}/execute`，使临时规则命中一行演示数据。二次授权前不得调用这些端点。
6. 确认只收到一张交互卡片，卡片包含异常描述、规则、数据集、严重程度、截止时间和详情深链，且没有同一规则的重复普通文本通知。
7. 打开深链，确认页面进入异常记录列表后自动打开正确 UUID 的详情抽屉。
8. 先提交空白内容，确认出现安全错误提示且异常未解决；再提交 1-1000 字说明，确认异常只产生一条正式 submission，并显示解决人、文本和时间。
9. 重复点击原卡片，确认结果幂等且不会覆盖首次文本。本 smoke 始终只配置这一位接收人，不扩展到第二接收者。
10. 观察卡片最终变为只读解决态；临时网络失败时，后台扫描应在后续周期重试关闭。
11. 停用临时规则并记录异常 UUID、卡片 `message_id`、时间线和最终状态。记录标识即可，不复制凭证、内部令牌或完整回调载荷。

未获得真实发送授权时，到第 4 步为止并保持规则停用；报告“外部副作用未执行”，不能以自动化通过替代真实飞书到达性结论。
