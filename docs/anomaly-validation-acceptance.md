# 异常实时校验：部署、诊断与人工验收

本文面向部署人员和验收人员。自动化测试和诊断命令不会读取、打印或写入任何凭证，也不会主动向飞书发送消息。启动真实服务时，应用会按正常运行要求从环境读取凭证。真实消息 smoke 必须在执行当时再次获得外部副作用授权；没有该授权时，只运行自动化测试和本地诊断。

## 1. 配置边界

从 `.env.example` 复制本地 `.env`，不要提交 `.env`。以下值用途不同：

- `SENTINEL_PUBLIC_BASE_URL`：写入飞书卡片“查看异常详情”深链的浏览器地址。真实验收必须是接收者设备可访问的完整 `http://` 或 `https://` 地址；`localhost`/`127.0.0.1` 仅适合浏览器与 Sentinel 在同一台机器上的本地验证。生产建议使用 HTTPS，反向代理必须同时提供 SPA 和 `/#records/<uuid>` 路由。
- `SENTINEL_API_BASE_URL`：飞书长连接进程调用 FastAPI 的服务端地址。长连接和 FastAPI 同机时可保持 `http://127.0.0.1:8000`，不要求暴露到公网。
- `INTERNAL_EXECUTION_TOKEN`：长连接调用内部回调 API 的共享令牌。FastAPI 与长连接进程必须一致；不要将值写入命令历史、日志或文档。
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET`：同一飞书应用的凭证。不要用命令打印它们。
- `VALIDATION_TIMEOUT_SCAN_INTERVAL_SECONDS`：超时扫描与卡片收敛周期，默认 `60` 秒。

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

启动 FastAPI（脚本会先执行 `alembic upgrade head`）：

```powershell
& .\backend\start.ps1
```

另一个终端中确认健康检查；只显示公开健康状态，不显示配置：

```powershell
Invoke-RestMethod 'http://127.0.0.1:8000/api/v1/health'
```

随后启动飞书长连接：

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

`SENTINEL_PUBLIC_BASE_URL` 不负责接收飞书回调，但卡片接收者必须能从自己的网络打开 `${SENTINEL_PUBLIC_BASE_URL}/#records/<uuid>`。人工 smoke 前，应从目标用户实际使用的浏览器或外部网络访问该地址及 `/api/v1/health`，不能只在服务端本机验证。

## 4. 无外部副作用的自动验收

以下测试在 HTTP 边界使用本地 fake/mock，不会向真实飞书发送消息：

```powershell
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' -m pytest backend\tests tests -q

$env:NODE_PATH = 'C:\Users\Lenovo\AppData\Local\OpenAI\Codex\runtimes\cua_node\e0c305cbb434431d\bin\node_modules'
Push-Location frontend
node --test
Pop-Location

& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' -m compileall -q backend tests 飞书长连接启动
Get-ChildItem frontend -Recurse -Filter '*.js' -File | ForEach-Object { node --check $_.FullName }
```

若工作区内置 Playwright 路径随 Codex 版本改变，应通过桌面应用加载工作区依赖后再运行前端测试；不要联网安装未锁定的临时版本。

回归覆盖索引：

| 验收行为 | 自动化证据 |
| --- | --- |
| 多接收人、字段目标缺失/空值、去重 | `backend/tests/test_validation_service.py::test_snapshot_creates_ordered_unique_requests_and_suppresses_matching_legacy_text` |
| 投递三次重试、幂等键、远端结果不确定 | `test_delivery_retries_real_feishu_gateway_and_persists_success`、`test_delivery_retry_uses_stable_remote_idempotency_key`、`test_lost_sent_commit_becomes_uncertain_after_dedupe_window_without_resend` |
| 回调篡改、message/anomaly 关系、操作者不匹配 | `backend/tests/test_validation_api.py::test_feishu_callback_returns_safe_transport_errors_for_bad_relationships` |
| 空内容、超长内容 | `backend/tests/test_validation_service.py::test_invalid_submission_text_is_rejected_without_resolving` 与 API 空内容回归 |
| 重复回调、多人首胜 | `test_duplicate_winner_is_idempotent_nonwinner_is_resolved_and_record_cannot_reopen`、`test_concurrent_callbacks_persist_exactly_one_winner` |
| 超时幂等、迟交、超时/提交竞态 | `test_timeout_is_idempotent_and_late_submission_resolves`、`test_expiration_cannot_overwrite_a_concurrent_resolution` |
| 管理员解决与竞态保护 | `test_named_admin_can_manually_resolve`、`backend/tests/test_validation_api.py::test_manual_resolution_uses_authenticated_admin_not_forged_assignee` |
| 卡片关闭失败重试与收敛 | `test_card_patch_failure_is_retryable_and_does_not_rollback_resolution`、`test_timed_out_card_reconciliation_converges_after_one_success` |
| 深链先渲染列表再开详情 | `frontend/tests/anomaly_validation_ui.test.js` 的 `deep record hash renders the records list before opening its detail` |
| 长连接订阅、标准化与错误隔离 | `tests/test_feishu_long_connection.py` |

## 5. 真实消息人工 smoke（必须再次授权）

仅当凭证已配置、应用权限已发布、公共深链已从目标用户网络验证，并且执行当时明确授权发送真实飞书消息后，才执行本节。验收目标为 `user_id=753f6bdf`；该值只用于本次人工验收，不写入 seed、生产默认值或自动化脚本。

1. 启动 FastAPI 和长连接，确认两者无配置错误。
2. 在规则页面复制或新建一条临时规则，保持规则停用，开启“实时校验”，超时可设为便于观察的值。
3. 添加一个“固定 user_id”目标 `753f6bdf`。不要把该值放入飞书普通通知目标，避免同一用户收到重复的旧文本通知。
4. 再次确认本次真实发送已获授权，然后启用或手动执行临时规则，使其命中一行演示数据。
5. 确认只收到一张交互卡片，卡片包含异常描述、规则、数据集、严重程度、截止时间和详情深链。
6. 打开深链，确认页面进入异常记录列表后自动打开正确 UUID 的详情抽屉。
7. 先提交空白内容，确认出现安全错误提示且异常未解决；再提交 1-1000 字说明，确认异常只产生一条正式 submission，并显示解决人、文本和时间。
8. 重复点击原卡片，确认结果幂等且不会覆盖首次文本。若配置第二位验收人，第二位在首胜后提交应收到“已处理”结果。
9. 观察所有已发送卡片最终变为只读解决态；临时网络失败时，后台扫描应在后续周期重试关闭。
10. 停用临时规则并记录异常 UUID、卡片 `message_id`、时间线和最终状态。记录标识即可，不复制凭证、内部令牌或完整回调载荷。

未获得真实发送授权时，到第 3 步为止并保持规则停用；报告“外部副作用未执行”，不能以自动化通过替代真实飞书到达性结论。
