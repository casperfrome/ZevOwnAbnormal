# Sentinel 前端

Sentinel 数据异常监控平台的静态前端，使用 HTML、CSS 和原生 JavaScript，无运行时框架和构建步骤。所有业务数据通过同源 `/api/v1` 接口读取并持久化到后端；不是内存模拟应用。

## 启动

按照项目根目录 README 配置并启动后端，然后访问 http://localhost:8000。后端同时托管此目录的静态文件。单独运行静态 HTTP 服务或直接打开 HTML 文件不能提供登录、数据库和异常处理功能。

默认进入异常记录页。登录后可以管理数据源、数据集、规则、异常记录及记录组，查看真实总览统计。测试页可以发送真实飞书测试消息；发送前必须确认接收者及范围。

## 模块

- `scripts/data.js`：API 请求、认证状态、数据映射和页面缓存。
- `scripts/components.js`：弹窗、抽屉、表格、提示和共享展示工具。
- `scripts/datasource.js`、`dataset.js`、`rules.js`：连接管理、只读 SQL 查询与异常规则配置。
- `scripts/records.js`、`anomaly_groups.js`：异常状态、分组、投递诊断与导出。
- `scripts/overview.js`：后端提供的每日新增异常、最近异常和规则排行；无统计口径的健康指标显示“暂无数据”。
- `scripts/app.js`：路由、登录界面和全局搜索。
- `styles/`：设计令牌、布局和组件样式。

数据源编辑时类型不可变，密码留空表示保留原密码。SQL 保存与预览分别反馈结果；预览失败不表示已经保存的数据被撤回。异常导出和查询结果导出均生成真实 CSV 文件。

## 回归测试

需要 Node.js 20 或以上。以下命令在本目录执行：

```powershell
npm ci
npx playwright install chromium
npm test
```

测试固定使用 Playwright 1.62.1，默认启动其配套 Chromium。可显式选择已有浏览器，不依赖固定安装位置：

```powershell
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
npm test
```

清除该变量后恢复默认浏览器。测试使用受控 API 响应或页面内测试数据，不连接真实飞书、Kafka 或业务数据源。JavaScript 语法检查：

```powershell
Get-ChildItem scripts\*.js | ForEach-Object { node --check $_.FullName }
```

前端直接由浏览器加载脚本，不需执行打包命令。样式和业务功能变动应同时验证桌面及窄屏布局，浏览器测试应检查页面错误和实际交互结果。
