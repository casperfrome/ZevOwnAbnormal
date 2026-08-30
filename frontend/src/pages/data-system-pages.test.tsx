import { StrictMode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { DatasetsPage, DatasetEditorPage } from "./datasets"
import { DatasourcesPage } from "./datasources"
import { OverviewPage } from "./overview"
import { AccountPage, AccountsPage, TestsPage } from "./system"
import { ApiError } from "@/api/client"
import { TooltipProvider } from "@/components/ui/tooltip"

const state = vi.hoisted(() => ({
  user: { id: "admin", login_name: "admin", display_name: "管理员", job_title: "运维", is_superuser: true, is_active: true },
  canManage: true,
  setUser: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  resources: {
    datasets: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), validate: vi.fn(), preview: vi.fn(), execute: vi.fn() },
    datasources: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), test: vi.fn(), testConfig: vi.fn() },
    overview: vi.fn(),
    tests: { feishu: vi.fn() },
    pushes: { recover: vi.fn(), clear: vi.fn(), abort: vi.fn() },
    account: { profile: vi.fn(), credentials: vi.fn() },
    accounts: { list: vi.fn(), create: vi.fn(), update: vi.fn(), password: vi.fn(), remove: vi.fn() },
  },
}))

vi.mock("@/app/context", () => ({ useApp: () => ({ resources: state.resources, user: state.user, setUser: state.setUser, canManage: state.canManage }) }))
vi.mock("sonner", () => ({ toast: { success: state.toastSuccess, error: state.toastError, warning: vi.fn() } }))

function renderPage(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}><TooltipProvider>{node}</TooltipProvider></QueryClientProvider>)
}

function renderStrictPage(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<StrictMode><QueryClientProvider client={client}><TooltipProvider>{node}</TooltipProvider></QueryClientProvider></StrictMode>)
}

const source = { id: "source-1", name: "生产库", type: "mysql", host: "db.internal", port: 3306, database: "orders", username: "reader", ssl: true, status: "error", error_message: "连接超时", has_password: true }
const datasets = [
  { id: "dataset-1", name: "订单明细", description: "高金额订单", datasource_id: "source-1", datasource_name: "生产库", sql: "SELECT * FROM orders", fields: [{ name: "order_id" }], row_count: 2 },
  { id: "dataset-2", name: "库存快照", description: "门店库存", datasource_id: "source-1", datasource_name: "生产库", sql: "SELECT * FROM stock", fields: [], row_count: 0 },
]

beforeEach(() => {
  vi.clearAllMocks()
  state.user = { id: "admin", login_name: "admin", display_name: "管理员", job_title: "运维", is_superuser: true, is_active: true }
  state.canManage = true
  state.resources.datasets.list.mockResolvedValue(datasets)
  state.resources.datasources.list.mockResolvedValue([source])
  state.resources.accounts.list.mockResolvedValue([
    state.user,
    { id: "u2", login_name: "analyst", display_name: "王小明", job_title: "分析师", is_superuser: false, is_active: true },
  ])
  state.resources.datasets.create.mockResolvedValue(datasets[0])
  state.resources.datasets.update.mockResolvedValue(datasets[0])
  state.resources.datasources.create.mockResolvedValue(source)
  state.resources.datasources.update.mockResolvedValue(source)
  state.resources.datasources.testConfig.mockResolvedValue({ ok: true })
})

describe("data pages", () => {
  it("keeps dataset and datasource inventories read-only for an analyst", async () => {
    state.canManage = false
    const datasetView = renderPage(<DatasetsPage navigate={vi.fn()} />)

    expect((await screen.findAllByText("订单明细")).length).toBeGreaterThan(0)
    expect(screen.queryByRole("button", { name: "新建数据集" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "编辑 订单明细" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "删除 订单明细" })).not.toBeInTheDocument()

    datasetView.unmount()
    renderPage(<DatasourcesPage />)
    expect((await screen.findAllByText("生产库")).length).toBeGreaterThan(0)
    expect(screen.queryByRole("button", { name: "新建数据源" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "测试 生产库" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "编辑 生产库" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "删除 生产库" })).not.toBeInTheDocument()
  })
  it("searches datasets and keeps a confirmed delete single-flight", async () => {
    let finishDelete: (() => void) | undefined
    state.resources.datasets.remove.mockImplementation(() => new Promise<void>((resolve) => { finishDelete = resolve }))
    renderPage(<DatasetsPage navigate={vi.fn()} />)

    fireEvent.change(await screen.findByRole("searchbox", { name: "搜索数据集" }), { target: { value: "库存" } })
    expect(screen.queryByText("订单明细")).not.toBeInTheDocument()
    const row = screen.getByRole("row", { name: /库存快照/ })
    const remove = within(row).getByRole("button", { name: "删除 库存快照" })
    await userEvent.click(remove)
    await userEvent.click(await screen.findByRole("button", { name: "确认删除" }))
    await waitFor(() => expect(remove).toBeDisabled())
    fireEvent.click(remove)
    expect(state.resources.datasets.remove).toHaveBeenCalledTimes(1)
    finishDelete?.()
    await waitFor(() => expect(remove).not.toBeDisabled())
  })

  it("uses server SQL validation and renders a single-flight execution preview", async () => {
    let finishPreview: ((value: unknown) => void) | undefined
    state.resources.datasets.validate.mockResolvedValue({ valid: true, normalized_sql: "SELECT 1" })
    state.resources.datasets.preview.mockImplementation(() => new Promise((resolve) => { finishPreview = resolve }))
    renderPage(<DatasetEditorPage navigate={vi.fn()} />)

    await screen.findByRole("heading", { name: "新建数据集" })
    await userEvent.click(screen.getByRole("combobox"))
    await userEvent.click(await screen.findByRole("option", { name: "生产库" }))
    fireEvent.change(screen.getByLabelText("SQL"), { target: { value: "SELECT 1" } })
    await userEvent.click(screen.getByRole("button", { name: "校验 SQL" }))
    expect(state.resources.datasets.validate).toHaveBeenCalledWith("SELECT 1")
    const preview = screen.getByRole("button", { name: /执行预览/ })
    await userEvent.click(preview)
    expect(preview).toBeDisabled()
    fireEvent.click(preview)
    expect(state.resources.datasets.preview).toHaveBeenCalledTimes(1)
    finishPreview?.({ fields: [{ name: "order_id" }, { name: "amount" }], rows: [["A-1", 9]], row_count: 1, elapsed_ms: 3 })
    expect(await screen.findByRole("columnheader", { name: "order_id" })).toBeInTheDocument()
    expect(screen.getByText("A-1")).toBeInTheDocument()
  })

  it("resets editor ownership on an A to B deep-link change and ignores the late A preview", async () => {
    const sourceB = { ...source, id: "source-2", name: "库存库", status: "online", error_message: undefined }
    const datasetA = { ...datasets[0], id: "dataset-a", name: "数据集 A", datasource_id: source.id, sql: "SELECT 'A'" }
    const datasetB = { ...datasets[1], id: "dataset-b", name: "数据集 B", datasource_id: sourceB.id, datasource_name: sourceB.name, sql: "SELECT 'B'" }
    state.resources.datasets.list.mockResolvedValue([datasetA, datasetB])
    state.resources.datasources.list.mockResolvedValue([source, sourceB])
    let finishA: ((value: unknown) => void) | undefined
    state.resources.datasets.preview.mockImplementation(() => new Promise((resolve) => { finishA = resolve }))
    state.resources.datasets.update.mockResolvedValue(datasetB)
    const navigate = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const view = render(<QueryClientProvider client={client}><DatasetEditorPage id="dataset-a" navigate={navigate} /></QueryClientProvider>)

    expect(await screen.findByLabelText("名称")).toHaveValue("数据集 A")
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "A 的未保存草稿" } })
    await userEvent.click(screen.getByRole("button", { name: /执行预览/ }))
    view.rerender(<QueryClientProvider client={client}><DatasetEditorPage id="dataset-b" navigate={navigate} /></QueryClientProvider>)

    await waitFor(() => expect(screen.getByLabelText("名称")).toHaveValue("数据集 B"))
    expect(screen.getByLabelText("SQL")).toHaveValue("SELECT 'B'")
    expect(screen.getByText("尚未预览")).toBeInTheDocument()
    finishA?.({ fields: [{ name: "late_a" }], rows: [["A-LATE"]], row_count: 1 })
    await waitFor(() => expect(screen.queryByText("A-LATE")).not.toBeInTheDocument())

    await userEvent.click(screen.getByRole("button", { name: "保存数据集" }))
    await waitFor(() => expect(state.resources.datasets.update).toHaveBeenCalledWith("dataset-b", { name: "数据集 B", description: "门店库存", datasourceId: "source-2", sql: "SELECT 'B'" }))
    expect(navigate).toHaveBeenCalledWith("#datasets")
  })

  it("keeps dataset preview, toast and navigation live through StrictMode effect replay", async () => {
    state.resources.datasets.preview.mockResolvedValue({ fields: [{ name: "ok" }], rows: [[1]], row_count: 1 })
    const navigate = vi.fn()
    renderStrictPage(<DatasetEditorPage id="dataset-1" navigate={navigate} />)

    await screen.findByDisplayValue("订单明细")
    await userEvent.click(screen.getByRole("button", { name: /执行预览/ }))
    expect(await screen.findByRole("columnheader", { name: "ok" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "保存数据集" }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("#datasets"))
    expect(state.toastSuccess).toHaveBeenCalledWith("数据集已更新")
  })

  it("searches datasources, exposes connection errors and guards saved tests", async () => {
    let finishTest: (() => void) | undefined
    state.resources.datasources.test.mockImplementation(() => new Promise((resolve) => { finishTest = () => resolve({ ok: true }) }))
    renderPage(<DatasourcesPage />)

    expect((await screen.findAllByText("连接超时")).length).toBeGreaterThan(0)
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索数据源" }), { target: { value: "无匹配" } })
    expect(screen.queryByText("生产库")).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索数据源" }), { target: { value: "生产" } })
    const row = screen.getByRole("row", { name: /生产库/ })
    const test = within(row).getByRole("button", { name: "测试 生产库" })
    await userEvent.click(test)
    expect(test).toBeDisabled()
    fireEvent.click(test)
    expect(state.resources.datasources.test).toHaveBeenCalledTimes(1)
    finishTest?.()
    await waitFor(() => expect(test).not.toBeDisabled())
  })

  it("offers readable mobile dataset and datasource cards with reachable actions", async () => {
    const datasetView = renderPage(<DatasetsPage navigate={vi.fn()} />)
    const datasetCards = await screen.findByRole("region", { name: "数据集卡片列表" })
    expect(within(datasetCards).getByText("订单明细")).toBeInTheDocument()
    expect(within(datasetCards).getByRole("button", { name: "编辑 订单明细" })).toBeInTheDocument()
    datasetView.unmount()

    renderPage(<DatasourcesPage />)
    const sourceCards = await screen.findByRole("region", { name: "数据源卡片列表" })
    expect(within(sourceCards).getByText("db.internal:3306")).toBeInTheDocument()
    expect(within(sourceCards).getByRole("button", { name: "测试 生产库" })).toBeInTheDocument()
  })

  it("labels dataset and datasource icon actions with hover and focus tooltips", async () => {
    const user = userEvent.setup()
    const datasetView = renderPage(<DatasetsPage navigate={vi.fn()} />)
    const datasetRow = await screen.findByRole("row", { name: /订单明细/ })
    await user.hover(within(datasetRow).getByRole("button", { name: "编辑 订单明细" }))
    expect(await screen.findByRole("tooltip", { name: "编辑 订单明细" })).toBeInTheDocument()
    datasetView.unmount()

    renderPage(<DatasourcesPage />)
    const sourceRow = await screen.findByRole("row", { name: /生产库/ })
    fireEvent.focus(within(sourceRow).getByRole("button", { name: "测试 生产库" }))
    expect(await screen.findByRole("tooltip", { name: "测试 生产库" })).toBeInTheDocument()
  })

  it("restores datasource dialog focus to its edit trigger on Escape", async () => {
    renderPage(<DatasourcesPage />)
    const row = await screen.findByRole("row", { name: /生产库/ })
    const edit = within(row).getByRole("button", { name: "编辑 生产库" })
    await userEvent.click(edit)
    expect(await screen.findByRole("dialog", { name: "编辑数据源" })).toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(edit).toHaveFocus())
  })

  it("offers only backend datasource literals and sends the selected create/test payload", async () => {
    renderPage(<DatasourcesPage />)
    await screen.findAllByText("生产库")
    await userEvent.click(screen.getByRole("button", { name: "新建数据源" }))
    await userEvent.click(screen.getByRole("combobox", { name: "数据库类型" }))
    expect(await screen.findByRole("option", { name: "MySQL" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "StarRocks" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "PostgreSQL" })).not.toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "ClickHouse" })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("option", { name: "StarRocks" }))
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "分析库" } })
    fireEvent.change(screen.getByLabelText("主机"), { target: { value: "sr.internal" } })
    fireEvent.change(screen.getByLabelText("数据库"), { target: { value: "ads" } })
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "reader" } })
    await userEvent.click(screen.getByRole("button", { name: "测试配置" }))
    expect(state.resources.datasources.testConfig).toHaveBeenCalledWith(expect.objectContaining({ type: "starrocks", port: 9030 }))
    await userEvent.click(screen.getByRole("button", { name: "保存" }))
    expect(state.resources.datasources.create).toHaveBeenCalledWith(expect.objectContaining({ type: "starrocks", port: 9030 }))
  })

  it("keeps datasource dialogs and toast ownership live through StrictMode effect replay", async () => {
    renderStrictPage(<DatasourcesPage />)
    await screen.findAllByText("生产库")
    const row = screen.getByRole("row", { name: /生产库/ })
    await userEvent.click(within(row).getByRole("button", { name: "编辑 生产库" }))
    expect(await screen.findByRole("dialog", { name: "编辑数据源" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "测试配置" }))
    await waitFor(() => expect(state.toastSuccess).toHaveBeenCalledWith("配置连接成功"))
    expect(screen.getByRole("dialog", { name: "编辑数据源" })).toBeInTheDocument()
  })
})

describe("overview and system pages", () => {
  it("shows top rules without editor deep links to an analyst", async () => {
    state.canManage = false
    state.resources.overview.mockResolvedValue({ stats: {}, trend: [], recent_anomalies: [], top_rules: [{ id: "rule-1", name: "只读规则", dataset_name: "订单", anomaly_count: 2 }] })

    renderPage(<OverviewPage />)

    expect(await screen.findByText("只读规则")).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /只读规则/ })).not.toBeInTheDocument()
  })

  it("uses authoritative overview data with 7/30/90 ranges and zero-safe Beijing charts", async () => {
    state.resources.overview.mockImplementation((days: number) => Promise.resolve({
      days, timezone: "Asia/Shanghai",
      trend: [{ date: "2026-08-29", count: 0 }, { date: "2026-08-30", count: 0 }],
      stats: { pending_records: 2, processing_records: 1, timed_out_records: 0, resolved_records: 8, active_rules: 3, total_rules: 4, online_datasources: 1, total_datasources: 2, high_anomalies: 5 },
      recent_anomalies: [{ id: "a1", rule_name: "真实异常", dataset_name: "订单", severity: "high", status: "pending", detected_at: "2026-08-30T00:00:00Z" }],
      top_rules: [{ id: "r1", name: "真实规则", dataset_name: "订单", anomaly_count: 12 }],
    }))
    renderPage(<OverviewPage />)

    expect(await screen.findByText("真实异常")).toBeInTheDocument()
    expect(screen.getByText("真实规则")).toBeInTheDocument()
    expect(screen.getAllByText(/北京时间/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/健康度|87|92%/)).not.toBeInTheDocument()
    expect(screen.getByText("暂无严重级别分布数据")).toBeInTheDocument()
    expect(screen.getByText(/高风险未解决 5/)).toBeInTheDocument()
    expect(document.body.innerHTML).not.toMatch(/NaN|Infinity/)
    await userEvent.click(screen.getByRole("button", { name: "7 天" }))
    await waitFor(() => expect(state.resources.overview).toHaveBeenLastCalledWith(14, expect.anything()))
    expect(screen.getByRole("button", { name: "90 天" })).toBeInTheDocument()
  })

  it("confirms administrative push recovery, blocks duplicates and reports the server summary", async () => {
    let finishRecover: ((value: unknown) => void) | undefined
    state.resources.pushes.recover.mockImplementation(() => new Promise((resolve) => { finishRecover = resolve }))
    renderPage(<TestsPage />)

    await userEvent.click(screen.getByRole("button", { name: "恢复待推送" }))
    expect(state.resources.pushes.recover).not.toHaveBeenCalled()
    await userEvent.click(await screen.findByRole("button", { name: "确认恢复" }))
    const recover = screen.getByRole("button", { name: "恢复待推送" })
    expect(recover).toBeDisabled()
    fireEvent.click(recover)
    expect(state.resources.pushes.recover).toHaveBeenCalledTimes(1)
    finishRecover?.({ status: "completed", requeued_jobs: 3, skipped_jobs: 2, requeued_by_kind: { notification: 1, validation: 1, group_broadcast: 1 }, errors: [] })
    expect(await screen.findByText(/已重新入队 3 个任务/)).toBeInTheDocument()
  })

  it("renders structured partial recovery counts and stage errors from a 502 response", async () => {
    state.resources.pushes.recover.mockRejectedValue(new ApiError("请求失败（502）", 502, {
      status: "partial_failed", checks: { kafka: "unhealthy", dolphinscheduler: "healthy" }, requeued_jobs: 0, skipped_jobs: 2,
      errors: [{ stage: "kafka", message: "broker unavailable" }],
    }))
    renderPage(<TestsPage />)

    await userEvent.click(screen.getByRole("button", { name: "恢复待推送" }))
    await userEvent.click(await screen.findByRole("button", { name: "确认恢复" }))
    expect(await screen.findByText("失败推送部分失败")).toBeInTheDocument()
    expect(screen.getByText(/已重新入队 0 个任务，跳过 2 个任务/)).toBeInTheDocument()
    expect(screen.getByText(/kafka：broker unavailable/)).toBeInTheDocument()
  })

  it("renders structured partial abort counts and stage errors from a 502 response", async () => {
    state.resources.pushes.abort.mockRejectedValue(new ApiError("请求失败（502）", 502, {
      status: "partial_failed", aborted_jobs: 4, stopped_ds_instances: 1,
      errors: [{ stage: "dolphinscheduler", message: "stop failed" }],
    }))
    renderPage(<TestsPage />)

    await userEvent.click(screen.getByRole("button", { name: "中止全部推送" }))
    await userEvent.click(await screen.findByRole("button", { name: "确认中止" }))
    expect(await screen.findByText("推送积压部分失败")).toBeInTheDocument()
    expect(screen.getByText(/已中止 4 个任务，停止 1 个调度实例/)).toBeInTheDocument()
    expect(screen.getByText(/dolphinscheduler：stop failed/)).toBeInTheDocument()
  })

  it("does not expose the admin-only Feishu test to a non-admin reader", () => {
    state.user = { ...state.user, is_superuser: false }
    renderPage(<TestsPage />)
    expect(screen.getByText("需要超级管理员权限")).toBeInTheDocument()
    expect(screen.queryByText("飞书测试消息")).not.toBeInTheDocument()
  })
})

describe("account pages", () => {
  it("offers readable mobile account cards with reachable actions", async () => {
    renderPage(<AccountsPage />)
    const cards = await screen.findByRole("region", { name: "账号卡片列表" })
    expect(within(cards).getByText("王小明")).toBeInTheDocument()
    expect(within(cards).getByRole("button", { name: "重置密码 王小明" })).toBeInTheDocument()
  })

  it("shows account action tooltips and restores focus after editor and reset dialogs", async () => {
    const user = userEvent.setup()
    renderPage(<AccountsPage />)
    const row = await screen.findByRole("row", { name: /王小明/ })
    const edit = within(row).getByRole("button", { name: "编辑 王小明" })
    await user.hover(edit)
    expect(await screen.findByRole("tooltip", { name: "编辑 王小明" })).toBeInTheDocument()
    await user.click(edit)
    await user.keyboard("{Escape}")
    await waitFor(() => expect(edit).toHaveFocus())

    const reset = within(row).getByRole("button", { name: "重置密码 王小明" })
    fireEvent.focus(reset)
    expect(await screen.findByRole("tooltip", { name: "重置密码 王小明" })).toBeInTheDocument()
    await user.click(reset)
    await user.click(await screen.findByRole("button", { name: "取消" }))
    await waitFor(() => expect(reset).toHaveFocus())
  })
  it("updates profile and omits a blank credential password with separate pending guards", async () => {
    let finishProfile: ((value: unknown) => void) | undefined
    state.resources.account.profile.mockImplementation(() => new Promise((resolve) => { finishProfile = resolve }))
    state.resources.account.credentials.mockResolvedValue({ ...state.user, login_name: "admin-new" })
    renderPage(<AccountPage />)

    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "新管理员" } })
    const profile = screen.getByRole("button", { name: "保存资料" })
    await userEvent.click(profile)
    expect(profile).toBeDisabled()
    fireEvent.click(profile)
    expect(state.resources.account.profile).toHaveBeenCalledTimes(1)
    finishProfile?.({ ...state.user, display_name: "新管理员" })
    await waitFor(() => expect(profile).not.toBeDisabled())

    fireEvent.change(screen.getByLabelText("登录名"), { target: { value: "admin-new" } })
    await userEvent.click(screen.getByRole("button", { name: "更新凭据" }))
    expect(state.resources.account.credentials).toHaveBeenCalledWith({ login_name: "admin-new" })
  })

  it("keeps account context and toast updates live through StrictMode effect replay", async () => {
    const updated = { ...state.user, display_name: "严格模式管理员" }
    state.resources.account.profile.mockResolvedValue(updated)
    renderStrictPage(<AccountPage />)
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: updated.display_name } })
    await userEvent.click(screen.getByRole("button", { name: "保存资料" }))
    await waitFor(() => expect(state.setUser).toHaveBeenCalledWith(updated))
    expect(state.toastSuccess).toHaveBeenCalledWith("个人资料已保存")
  })

  it("lets administrators search, edit status and role, reset passwords and delete accounts", async () => {
    state.resources.accounts.update.mockResolvedValue({})
    state.resources.accounts.password.mockResolvedValue(undefined)
    state.resources.accounts.remove.mockResolvedValue(undefined)
    renderPage(<AccountsPage />)

    fireEvent.change(await screen.findByRole("searchbox", { name: "搜索账号" }), { target: { value: "王小明" } })
    expect(screen.queryByText("管理员", { selector: "td" })).not.toBeInTheDocument()
    const row = screen.getByRole("row", { name: /王小明/ })
    await userEvent.click(within(row).getByRole("button", { name: "编辑 王小明" }))
    await userEvent.click(await screen.findByRole("switch", { name: "超级管理员" }))
    await userEvent.click(screen.getByRole("button", { name: "保存更改" }))
    expect(state.resources.accounts.update).toHaveBeenCalledWith("u2", expect.objectContaining({ is_superuser: true }))

    await userEvent.click(within(row).getByRole("button", { name: "重置密码 王小明" }))
    fireEvent.change(await screen.findByLabelText("重置后的新密码"), { target: { value: "reset-secret" } })
    await userEvent.click(screen.getByRole("button", { name: "确认重置" }))
    expect(state.resources.accounts.password).toHaveBeenCalledWith("u2", "reset-secret")

    await userEvent.click(within(row).getByRole("button", { name: "删除 王小明" }))
    await userEvent.click(await screen.findByRole("button", { name: "确认删除" }))
    expect(state.resources.accounts.remove).toHaveBeenCalledWith("u2")
  })

  it("protects the current administrator from self-demotion and deletion", async () => {
    renderPage(<AccountsPage />)

    const row = await screen.findByRole("row", { name: /@admin/ })
    expect(within(row).getByRole("button", { name: "删除 管理员" })).toBeDisabled()
    await userEvent.click(within(row).getByRole("button", { name: "编辑 管理员" }))
    expect(await screen.findByRole("switch", { name: "超级管理员" })).toBeDisabled()
    expect(screen.getByRole("switch", { name: "账号启用" })).toBeDisabled()
  })

  it("updates AppContext when the current administrator identity is edited", async () => {
    const updated = { ...state.user, display_name: "平台管理员", login_name: "platform-admin" }
    state.resources.accounts.update.mockResolvedValue(updated)
    renderPage(<AccountsPage />)
    const row = await screen.findByRole("row", { name: /@admin/ })
    await userEvent.click(within(row).getByRole("button", { name: "编辑 管理员" }))
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: updated.display_name } })
    fireEvent.change(screen.getByLabelText("登录名"), { target: { value: updated.login_name } })
    await userEvent.click(screen.getByRole("button", { name: "保存更改" }))
    await waitFor(() => expect(state.setUser).toHaveBeenCalledWith(updated))
  })
})
