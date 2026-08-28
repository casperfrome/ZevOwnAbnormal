# 规则检测与双播报配置

## 配置语义

- “是否重复推送”默认关闭。开启后，每条命中记录的业务主键增加 `__detected_at`（UTC 微秒时间戳）和 `__occurrence_id`（唯一标识），同一业务记录每次检测都独立推送和计时；消息发送重试不新增异常。原主键值不变，以上两个字段名为系统保留。
- 异常条件的“字段值”读取数据集当前行；SQL True 条件读取 SQL 本次返回的唯一一行，不读取原异常字段。范围上下界可以分别选择具体值或字段值；基线条件的字段值表示当前行的倍数。
- 空值只通过“为空／不为空”判断；普通比较遇到 NULL 返回不匹配，缺失目标字段或类型不兼容会明确报错。
- 情况播报仅包含本批次新增异常，与私聊任务同时入队，无新增异常时不发群消息。每次成功检测仍保存批次。
- 两批检测的时间完全相同时，批次内部时间键按微秒顺延至空位；运行开始时间、异常检测时间和验证截止时间保持原值，两批的任务及播报相互独立。
- 超时播报独立于实时验证。首次推送成功后开始计时，到截止时间后，按轮次汇总原始批次中新到期且未解决的异常，自动艾特其全部验证处理人，并合并额外配置的用户（去重）。任意验证人解决异常后，该异常不再进入新的超时播报。
- 两种播报共用 webhook，分别设置文案、固定用户和字段来源。文案支持现有字段列表和链接参数；留空使用各自默认文案。每条消息最多列出 20 条异常，仅首片艾特用户。
- 超时配置在批次创建时保存快照；之后编辑规则不会改变已有批次。超时消息按生成时的状态固定，发送重试沿用原消息，不追溯撤销已入队消息。

## 接口

规则新增 `repeat_push_enabled`，默认 `false`。条件增加 `value_source` / `value_field` 和 `upper_value_source` / `upper_value_field`；来源为 `literal` 或 `field`，缺省 `literal`，常量仍保存在 `value` / `upper_value`。

```json
{
  "repeat_push_enabled": true,
  "group_broadcast": {
    "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/EXAMPLE",
    "situation": {
      "enabled": true,
      "mention_targets": [],
      "message_template": "新增异常：{订单号列表}"
    },
    "timeout": {
      "enabled": true,
      "mention_targets": [{"source": "literal", "value": "supervisor-user-id"}],
      "message_template": "待处理超时：{订单号列表}"
    }
  }
}
```

旧的 `group_broadcast.enabled`、`mention_targets`、`message_template` 映射为情况播报。接口继续返回这些别名；旧请求不重置超时设置。若超时播报仍开启，关闭实时验证会返回 422，需要同时关闭超时播报。

批次接口增加 `situation_broadcast_status` 和 `timeout_broadcast_status`，`broadcast_status` 保留为情况播报状态。新增状态 `waiting` 表示等待超时，`skipped` 表示无需播报；详情的 `deliveries` 区分 `broadcast_kind`。

SQL 校验结果保存在异常详情的 `last_sql_validation_result`。卡片展示 True 条件、左右实际值、True/False 或执行错误、操作人及时间；失败可继续校验。后台按结果版本同步所有处理人的卡片；成功解决后，迟到的失败不能覆盖成功结果。不会展示整行查询数据、SQL 凭据或内部错误详情。

SQL 内部回调响应增加 `card_update_mode: "versioned"`：响应中的卡片仅为诊断快照，长连接网关只返回 toast，避免迟到的同步回调覆盖新版卡片。回调结束后立即触发独立会话的版本化 PATCH，失败由周期维护重试。此处将原计划的同步卡片回包改为统一 PATCH，以保证所有实际 SQL 卡片更新都经过同一把锁和版本检查；非 SQL 验证保留旧回包行为。

## 升级与验证

先备份元数据库，停止旧应用的调度／推送进程，再执行迁移。先升级并重启飞书长连接网关（识别 versioned 标记，同时兼容旧回包），再部署后端与前端：

```powershell
Push-Location 'D:\AllForCareer\ZevOwnAbnormal\backend'
& 'D:\PythonVenv\Scripts\python.exe' -m alembic upgrade head
Pop-Location
```

新迁移为 `20260828_0012`。旧规则重复推送和超时播报均默认关闭；旧投递保留为情况播报；不为历史异常补发超时消息。已有超时投递时，数据库降级会明确拒绝，避免破坏投递唯一约束；优先保留新增列，仅回滚应用版本。

自动测试使用内存／临时 SQLite 和模拟外部请求，不向飞书发真实消息。Python 一律使用 `D:\PythonVenv\Scripts\python.exe`；前端使用 `node --test`，本机可通过 Codex 提供的 Node 依赖目录设置 `NODE_PATH` 运行 Playwright。

验收场景：重复检测与发送重试分别验证；情况／超时独立文案和艾特；21 条以上分片；同一异常跨批次去重；超时前已解决跳过；字段比较及混合范围；SQL 失败重试、异常返回、并发解决与卡片版本同步。真实飞书验收必须先确认测试群和接收人。

## 严重程度与独立截止时间

- 严重程度仅有低、中、高三级，不附带响应时限；历史 critical 统一归为 high。
- 基本信息中配置收到首次异常推送后的天、小时、分钟、秒，默认 1 天，总时长 1 秒至 30 天。后端与前端字段分别为 `deadline_seconds`、`deadlineSeconds`。
- API 过渡期接受旧请求字段 `validation_timeout_minutes`（仅未提供新字段时换算）；响应只返回新字段。概览新增 `high_anomalies`，`critical_anomalies` 暂作为同值兼容别名。
- 所有新异常保存时限快照。普通通知或校验卡片首次获得飞书发送成功确认后启动截止时间；发送失败、结果未知、排队、群聊汇总均不启动。多接收人、重试及再次命中不顺延同一记录的截止时间；重复推送创建的新记录独立计时。
- 秒级到期检查与网络卡片维护独立运行。`VALIDATION_TIMEOUT_SCAN_INTERVAL_SECONDS=1`，卡片维护使用 `VALIDATION_CARD_SYNC_INTERVAL_SECONDS=60`；实际消息发送仍受队列和飞书耗时影响。
- 超时群播每轮只包含新到期未解决的记录，成员入队标记与投递分片在同一事务中保存。发送失败的其他异常不阻塞本轮；每条异常只进入一次超时播报。

### 升级与回滚

停止旧版应用和推送任务并备份数据库，然后使用指定 Python 环境执行 `alembic upgrade head`，同步部署后端和带新资源版本号的前端，并确认超时扫描环境变量为 1。迁移保留历史截止时间与超时状态；历史无截止时间记录不会追溯启动计时，历史已完成群播不会重新播报。

本次迁移不可无损降级：严重程度已合并，且新的群播轮次与旧版唯一键不兼容。回滚应停止应用并恢复升级前备份及对应代码，不能直接执行 `alembic downgrade`。真实飞书验收需要指定测试接收人。
