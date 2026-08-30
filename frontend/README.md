# ZevOwnAbnormal 前端

React + TypeScript + Vite + Tailwind CSS v4 + shadcn/ui 前端。业务数据全部来自同源 `/api/v1`；TanStack Query 负责缓存、失效和请求取消。路由保留 Hash 格式，可直接访问 `#records/{id}`、`#anomaly-groups/{id}`、`#rules/{id}/edit` 与 `#datasets/{id}/edit`。

## 环境与启动

需要 Node.js 20 或以上。首次安装依赖：

```powershell
cd frontend
npm ci
```

开发模式（API 代理到 `127.0.0.1:8000`）：

```powershell
npm run dev
```

项目统一启动脚本 `backend/start.ps1` 会在 `node_modules` 已存在时先执行 `npm run build`，再启动后端；它不会联网安装依赖。依赖缺失时会明确提示执行 `npm ci`。FastAPI 只托管生产目录 `frontend/dist`，该目录被 Git 忽略。

## 目录

- `src/api/`：类型化客户端、资源接口、401 单次登出和请求取消。
- `src/components/ui/`：shadcn Radix Nova 组件。
- `src/components/shared.tsx`：页面标题、状态、搜索和指标卡。
- `src/pages/`：异常、规则、数据集、数据源、总览、测试与账号页面。
- `src/index.css`：暖白画布、深色侧栏、靛蓝主色和珊瑚异常色语义令牌。

## 质量检查

```powershell
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run build
```

Playwright 首次运行前执行 `npx playwright install chromium`。单元与组件测试使用 Vitest、React Testing Library 和受控 API 响应，不连接真实飞书、Kafka 或业务数据源。
