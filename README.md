# Sentinel 塔斯汀数据异常监控平台 MVP

本项目保留原生 HTML/CSS/JavaScript UI，由 FastAPI 同源提供页面和 `/api/v1`。平台元数据存储在 MySQL `app`，门店订单模拟生产数据存储在 MySQL `tastien_prod`，综合经营 ADS 数据存储在 StarRocks `tastien_ads`，规则调度由 DolphinScheduler 执行。

## 本地环境

- Windows + Docker Desktop（建议可用内存 16 GiB）
- Python：`D:\PythonVEnv\FirstVEnv\Scripts\python.exe`
- FastAPI：<http://localhost:8000>
- DolphinScheduler：<http://localhost:12345/dolphinscheduler/ui>
- StarRocks FE：<http://localhost:8030>

## 首次初始化

以下命令在项目根目录 `D:\260809` 执行。

```powershell
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' -m pip install -r backend\requirements.txt
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' backend\scripts\bootstrap_env.py
docker compose up -d --wait --wait-timeout 600
Push-Location backend
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' -m alembic -c alembic.ini upgrade head
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' scripts\generate_demo_data.py --reset
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' scripts\seed_platform.py
Pop-Location
```

`bootstrap_env.py` 会从 `D:\飞书里尔机器人凭证.txt` 读取 App ID/App Secret，并只写入本地 `.env`；凭证文件不会被复制，`.env` 已被 Git 忽略。重置演示数据库前，造数脚本会明确打印目标数据库。默认生成 12,000 家门店、近 30 天 1,000,000 笔订单和约 360,000 行门店日 ADS 数据。

可用造数参数：

```powershell
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' backend\scripts\generate_demo_data.py --help
```

## 启动

```powershell
& .\backend\start.ps1
```

本地默认 `AUTO_LOGIN=true`，打开 <http://localhost:8000> 后自动登录超级管理员。默认账号为 `admin`；密码由 `.env` 中的 `SUPERADMIN_PASSWORD` 控制。

FastAPI 启动时会幂等核对全部启用规则。也可以单独执行：

```powershell
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' backend\scripts\reconcile_schedules.py
```

## 主要功能

- MySQL、StarRocks 数据源 CRUD、连接测试和 Fernet 密码加密
- 只读单条 `SELECT/WITH` 数据集校验、真实执行、字段识别和最多 200 行预览
- 11 种异常操作符、AND/OR、空值、between 和历史基线
- DolphinScheduler 工作流与 Schedule 创建、启停、重试同步和启动核对
- 活动异常去重、解决后重新告警、逐行源数据和状态时间线
- 飞书固定或字段接收者、投递幂等、失败重试和 message_id 持久化
- 异常分页筛选、批量状态、详情和 CSV 导出，以及真实总览统计

飞书凭证文件不包含接收者 ID。最终消息验收时，请在规则页面填写真实 `open_id`、`union_id`、`user_id`、`email` 或 `chat_id`，再启用或立即执行规则。

## 测试

```powershell
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' -m pytest backend\tests -q
Push-Location frontend
node --test
Pop-Location
Get-ChildItem frontend\scripts\*.js | ForEach-Object { node --check $_.FullName }
docker compose config --quiet
```

停止服务但保留数据：

```powershell
docker compose down
```

`docker compose down -v` 会不可恢复地删除本地 MySQL、StarRocks、Kafka 和 DolphinScheduler 数据卷，不应作为日常停止命令。
