import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { DatasetsPage, DatasetEditorPage } from "./datasets"
import { DatasourcesPage } from "./datasources"
import { OverviewPage } from "./overview"
import { AccountPage, AccountsPage, TestsPage } from "./system"

const state = vi.hoisted(() => ({
  user: { id: "admin", login_name: "admin", display_name: "管理员", job_title: "运维", is_superuser: true, is_active: true },
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

vi.mock("@/app/context", () => ({ useApp: () => ({ resources: state.resources, user: state.user, setUser: state.setUser }) }))
vi.mock("sonner", () => ({ toast: { success: state.toastSuccess, error: state.toastError, warning: vi.fn() } }))

function renderPage(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

const source = { id: "source-1", name: "生产库", type: "mysql", host: "db.internal", port: 3306, database: "orders", username: "reader", ssl: true, status: "error", error_message: "连接超时", has_password: true }
const datasets = [
  { id: "dataset-1", name: "订单明细", description: "高金额订单", datasource_id: "source-1", datasource_name: "生产库", sql: "SELECT * FROM orders", fields: [{ name: "order_id" }], row_count: 2 },
  { id: "dataset-2", name: "库存快照", description: "门店库存", datasource_id: "source-1", datasource_name: "生产库", sql: "SELECT * FROM stock", fields: [], row_count: 0 },
]

beforeEach(() => {
  vi.clearAllMocks()
  state.user = { id: "admin", login_name: "admin", display_name: "管理员", job_title: "运维", is_superuser: true, is_active: true }
  state.resources.datasets.list.mockResolvedValue(datasets)
  state.resources.datasources.list.mockResolvedValue([source])
  state.resources.accounts.list.mockResolvedValue([
    state.user,
    { id: "u2", login_name: "analyst", display_name: "王小明", job_title: "分析师", is_superuser: false, is_active: true },
  ])
})

describe("data pages", () => {
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

  it("searches datasources, exposes connection errors and guards saved tests", async () => {
    let finishTest: (() => void) | undefined
    state.resources.datasources.test.mockImplementation(() => new Promise((resolve) => { finishTest = () => resolve({ ok: true }) }))
    renderPage(<DatasourcesPage />)

    expect(await screen.findByText("连接超时")).toBeInTheDocument()
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索数据源" }), { target: { value: "无匹配" } })
    expect(screen.queryByText("生产库")).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索数据源" }), { target: { value: "生产" } })
    const test = screen.getByRole("button", { name: "测试 生产库" })
    await userEvent.click(test)
    expect(test).toBeDisabled()
    fireEvent.click(test)
    expect(state.resources.datasources.test).toHaveBeenCalledTimes(1)
    finishTest?.()
    await waitFor(() => expect(test).not.toBeDisabled())
  })
})

describe("overview and system pages", () => {
  it("uses authoritative overview data with 7/30/90 ranges and zero-safe Beijing charts", async () => {
    state.resources.overview.mockImplementation((days: number) => Promise.resolve({
      days, timezone: "Asia/Shanghai",
      stats: { pending_records: 2, processing_records: 1, timed_out_records: 0, resolved_records: 8, active_rules: 3, total_rules: 4, online_datasources: 1, total_datasources: 2 },
      trend: [{ date: "2026-08-29", count: 0 }, { date: "2026-08-30", count: 0 }],
      severity_distribution: [{ severity: "high", count: 0 }],
      recent_anomalies: [{ id: "a1", rule_name: "真实异常", dataset_name: "订单", severity: "high", status: "pending", detected_at: "2026-08-30T00:00:00Z" }],
      top_rules: [{ id: "r1", name: "真实规则", dataset_name: "订单", anomaly_count: 12 }],
    }))
    renderPage(<OverviewPage />)

    expect(await screen.findByText("真实异常")).toBeInTheDocument()
    expect(screen.getByText("真实规则")).toBeInTheDocument()
    expect(screen.getAllByText(/北京时间/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/健康度|87|92%/)).not.toBeInTheDocument()
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
})

describe("account pages", () => {
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
})
