import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { RuleEditorPage, RulesPage } from "./rules"
import { TooltipProvider } from "@/components/ui/tooltip"

const listRules = vi.fn()
const listDatasets = vi.fn()
const listDatasources = vi.fn()
const executeRule = vi.fn()
const syncRule = vi.fn()
const enableRule = vi.fn()
const removeRule = vi.fn()
const updateRule = vi.fn()
const capability = vi.hoisted(() => ({ canManage: true }))

vi.mock("@/app/context", () => ({ useApp: () => ({ resources: { rules: { list: listRules, execute: executeRule, sync: syncRule, enable: enableRule, remove: removeRule, update: updateRule, create: vi.fn() }, datasets: { list: listDatasets }, datasources: { list: listDatasources } }, canManage: capability.canManage }) }))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

const rules = [
  { id: "rule-1", name: "订单金额监控", description: "检查高金额订单", dataset_id: "ds-1", dataset_name: "订单", severity: "high", logic: "AND", enabled: true, conditions: [{ field: "amount", operator: "gt", value: 100 }], anomaly_key_fields: ["order_id"], repeat_push_enabled: false, schedule: { frequency: "day", interval: 1, time: "09:00", start_date: "2026-08-30" }, notification_targets: [{ receive_id_type: "user_id", source: "literal", value: "owner" }], validation_targets: [], deadline_seconds: 86400, validation_method: "pseudo", group_broadcast: { situation: { enabled: false }, timeout: { enabled: false } }, sync_status: "synced" },
  { id: "rule-2", name: "库存阈值", description: "检查库存", dataset_id: "ds-2", dataset_name: "库存", severity: "medium", logic: "OR", enabled: false, conditions: [{ field: "stock", operator: "lt", value: 3 }], anomaly_key_fields: ["sku"], schedule: { frequency: "hour", interval: 2, start_date: "2026-08-30" }, notification_targets: [{ receive_id_type: "user_id", source: "literal", value: "owner" }], validation_targets: [], deadline_seconds: 3600, validation_method: "pseudo", group_broadcast: { situation: { enabled: false }, timeout: { enabled: false } }, sync_status: "pending" }
]

function renderPage(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>
  )
}

describe("rule pages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capability.canManage = true
    listRules.mockResolvedValue(rules)
    listDatasets.mockResolvedValue([
      {
        id: "ds-1",
        name: "订单",
        datasource_id: "source-1",
        sql: "select * from orders",
        fields: [
          { name: "order_id", type: "VARCHAR" },
          { name: "amount", type: "DECIMAL" },
          { name: "limit", type: "DECIMAL" },
          { name: "reviewer_id", type: "VARCHAR" }
        ]
      },
      {
        id: "ds-2",
        name: "库存",
        datasource_id: "source-1",
        sql: "select * from stock",
        fields: [
          { name: "sku", type: "VARCHAR" },
          { name: "stock", type: "INTEGER" }
        ]
      }
    ])
    listDatasources.mockResolvedValue([{ id: "source-1", name: "生产库", type: "mysql", host: "db", port: 3306, database: "app", username: "reader", ssl: false }])
  })

  it("filters the operational list and keeps pending state scoped to the selected action", async () => {
    let finishExecute: ((value: unknown) => void) | undefined
    let finishEnable: ((value: unknown) => void) | undefined
    executeRule.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishExecute = resolve
        })
    )
    enableRule.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishEnable = resolve
        })
    )
    renderPage(<RulesPage navigate={vi.fn()} />)

    expect(await screen.findByText("规则总数")).toBeInTheDocument()
    expect(screen.getByText("2", { selector: ".metric-number" })).toBeInTheDocument()
    const search = screen.getByRole("searchbox", { name: "搜索异常规则" })
    fireEvent.change(search, { target: { value: "库存" } })
    expect(screen.queryByText("订单金额监控")).not.toBeInTheDocument()
    expect(screen.getAllByText("库存阈值").length).toBeGreaterThan(0)
    fireEvent.change(search, { target: { value: "" } })

    const row = screen.getByRole("row", { name: /订单金额监控/ })
    const execute = within(row).getByRole("button", { name: "立即执行 订单金额监控" })
    const sync = within(row).getByRole("button", { name: "同步调度 订单金额监控" })
    await userEvent.click(execute)
    expect(execute).toBeDisabled()
    expect(sync).not.toBeDisabled()
    await userEvent.hover(sync)
    expect(await screen.findByRole("tooltip")).toHaveTextContent("同步调度")
    finishExecute?.({ new_anomalies: 0 })
    await waitFor(() => expect(execute).not.toBeDisabled())

    const toggle = within(row).getByRole("switch", { name: "启用/停用 订单金额监控" })
    await userEvent.click(toggle)
    expect(toggle).toBeDisabled()
    expect(enableRule).toHaveBeenCalledWith("rule-1", false)
    finishEnable?.({ ...rules[0], enabled: false })
    await waitFor(() => expect(toggle).not.toBeDisabled())
  })

  it("keeps the rule list readable while hiding every write control from an analyst", async () => {
    capability.canManage = false
    renderPage(<RulesPage navigate={vi.fn()} />)

    expect((await screen.findAllByText("订单金额监控")).length).toBeGreaterThan(0)
    expect(screen.getAllByText("检查高金额订单").length).toBeGreaterThan(0)
    expect(screen.queryByRole("button", { name: "新建规则" })).not.toBeInTheDocument()
    expect(screen.queryByRole("switch", { name: "启用/停用 订单金额监控" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "立即执行 订单金额监控" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "同步调度 订单金额监控" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "编辑 订单金额监控" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "删除 订单金额监控" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^订单金额监控$/ })).not.toBeInTheDocument()
  })

  it("offers readable mobile rule cards with reachable management actions", async () => {
    enableRule.mockResolvedValue({ ...rules[0], enabled: false })
    renderPage(<RulesPage navigate={vi.fn()} />)
    const cards = await screen.findByRole("region", { name: "规则卡片列表" })
    expect(within(cards).getByText("订单金额监控")).toBeInTheDocument()
    expect(within(cards).getByText("每日 09:00")).toBeInTheDocument()
    expect(within(cards).getByRole("button", { name: "立即执行 订单金额监控" })).toBeInTheDocument()

    const enabledToggle = within(cards).getByRole("switch", { name: "启用/停用 订单金额监控" })
    const disabledToggle = within(cards).getByRole("switch", { name: "启用/停用 库存阈值" })
    expect(enabledToggle).toBeChecked()
    expect(disabledToggle).not.toBeChecked()

    await userEvent.click(enabledToggle)
    expect(enableRule).toHaveBeenCalledWith("rule-1", false)
    await userEvent.click(disabledToggle)
    expect(enableRule).toHaveBeenCalledWith("rule-2", true)
  })

  it("restores focus to the rule delete button after cancellation", async () => {
    renderPage(<RulesPage navigate={vi.fn()} />)
    const row = await screen.findByRole("row", { name: /订单金额监控/ })
    const remove = within(row).getByRole("button", { name: "删除 订单金额监控" })
    await userEvent.click(remove)
    await userEvent.click(await screen.findByRole("button", { name: "取消" }))
    await waitFor(() => expect(remove).toHaveFocus())
  })

  it("guards duplicate synchronization while leaving unrelated rule actions available", async () => {
    let finishSync: ((value: unknown) => void) | undefined
    syncRule.mockImplementation(() => new Promise((resolve) => { finishSync = resolve }))
    renderPage(<RulesPage navigate={vi.fn()} />)

    const row = await screen.findByRole("row", { name: /订单金额监控/ })
    const sync = within(row).getByRole("button", { name: "同步调度 订单金额监控" })
    const execute = within(row).getByRole("button", { name: "立即执行 订单金额监控" })
    const remove = within(row).getByRole("button", { name: "删除 订单金额监控" })

    await userEvent.click(sync)
    expect(sync).toBeDisabled()
    expect(execute).not.toBeDisabled()
    expect(remove).not.toBeDisabled()
    fireEvent.click(sync)
    expect(syncRule).toHaveBeenCalledTimes(1)
    expect(syncRule).toHaveBeenCalledWith("rule-1")

    finishSync?.({ ...rules[0], sync_status: "synced" })
    await waitFor(() => expect(sync).not.toBeDisabled())
  })

  it("guards duplicate deletion while the confirmed request is pending", async () => {
    let finishDelete: ((value: unknown) => void) | undefined
    removeRule.mockImplementation(() => new Promise((resolve) => { finishDelete = resolve }))
    renderPage(<RulesPage navigate={vi.fn()} />)

    const row = await screen.findByRole("row", { name: /订单金额监控/ })
    const remove = within(row).getByRole("button", { name: "删除 订单金额监控" })
    const execute = within(row).getByRole("button", { name: "立即执行 订单金额监控" })
    await userEvent.click(remove)
    await userEvent.click(await screen.findByRole("button", { name: "确认删除" }))

    await waitFor(() => expect(remove).toBeDisabled())
    expect(execute).not.toBeDisabled()
    fireEvent.click(remove)
    expect(removeRule).toHaveBeenCalledTimes(1)
    expect(removeRule).toHaveBeenCalledWith("rule-1")

    finishDelete?.(undefined)
    await waitFor(() => expect(remove).not.toBeDisabled())
  })

  it("localizes every current rule synchronization status", async () => {
    listRules.mockResolvedValue([rules[0], rules[1], { ...rules[0], id: "rule-3", name: "同步异常规则", sync_status: "sync_error", sync_error: "调度服务不可用" }])

    renderPage(<RulesPage navigate={vi.fn()} />)

    expect((await screen.findAllByText("已同步")).length).toBeGreaterThan(0)
    expect(screen.getAllByText("待同步").length).toBeGreaterThan(0)
    expect(screen.getAllByText("同步失败").length).toBeGreaterThan(0)
    expect(screen.queryByText("synced")).not.toBeInTheDocument()
    expect(screen.queryByText("sync_error")).not.toBeInTheDocument()
  })

  it("replaces all editor ownership when navigating directly from rule A to rule B", async () => {
    const navigate = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const view = render(<QueryClientProvider client={client}><TooltipProvider><RuleEditorPage id="rule-1" navigate={navigate} /></TooltipProvider></QueryClientProvider>)

    await screen.findByRole("heading", { name: "编辑异常规则" })
    fireEvent.change(screen.getByLabelText("规则名称"), { target: { value: "规则 A 未保存草稿" } })
    await userEvent.click(screen.getByLabelText("关联数据集"))
    await userEvent.click(await screen.findByRole("option", { name: "库存" }))
    await userEvent.click(screen.getByRole("tab", { name: "2 触发条件" }))
    await userEvent.click(screen.getByRole("button", { name: "保存规则" }))
    expect(await screen.findByText("请选择有效的条件字段")).toBeInTheDocument()
    view.rerender(<QueryClientProvider client={client}><TooltipProvider><RuleEditorPage id="rule-2" navigate={navigate} /></TooltipProvider></QueryClientProvider>)

    await waitFor(() => expect(screen.getByLabelText("规则名称")).toHaveValue("库存阈值"))
    expect(screen.getByRole("tab", { name: "1 基本信息" })).toHaveAttribute("data-state", "active")
    expect(screen.queryByText("请选择有效的条件字段")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "保存规则" }))
    await waitFor(() => expect(updateRule).toHaveBeenCalledWith("rule-2", expect.objectContaining({ name: "库存阈值", datasetId: "ds-2" })))
  })

  it.each([
    ["规则", listRules],
    ["数据集", listDatasets],
    ["数据源", listDatasources],
  ])("shows a retryable error when the %s query fails", async (label, queryMock) => {
    queryMock.mockRejectedValueOnce(new Error(`${label}加载失败`))
    renderPage(<RuleEditorPage id="rule-1" navigate={vi.fn()} />)

    expect(await screen.findByText(`${label}加载失败`)).toBeInTheDocument()
    expect(screen.queryByText("未找到该规则")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "重试" }))
    expect(await screen.findByRole("heading", { name: "编辑异常规则" })).toBeInTheDocument()
  })

  it("opens the owning tab and focuses the first invalid condition field", async () => {
    const invalidRule = { ...rules[0], conditions: [{ field: "", operator: "gt", value: "100" }] }
    listRules.mockResolvedValue([invalidRule])
    renderPage(<RuleEditorPage id="rule-1" navigate={vi.fn()} />)

    await screen.findByRole("heading", { name: "编辑异常规则" })
    expect(screen.getByRole("tab", { name: "1 基本信息" })).toHaveAttribute("data-state", "active")
    await userEvent.click(screen.getByRole("button", { name: "保存规则" }))

    const conditionTab = screen.getByRole("tab", { name: "2 触发条件" })
    await waitFor(() => expect(conditionTab).toHaveAttribute("data-state", "active"))
    await waitFor(() => expect(screen.getByLabelText("条件 1 字段")).toHaveFocus())
    expect(updateRule).not.toHaveBeenCalled()
  })

  it("clears incompatible dataset field references while preserving literal operand drafts", async () => {
    listRules.mockResolvedValue([{ ...rules[0], conditions: [{ field: "amount", operator: "between", value: "10", upper_value: "30", value_source: "field", value_field: "limit", upper_value_source: "field", upper_value_field: "amount" }] }])
    renderPage(<RuleEditorPage id="rule-1" navigate={vi.fn()} />)

    await screen.findByRole("heading", { name: "编辑异常规则" })
    await userEvent.click(screen.getByLabelText("关联数据集"))
    await userEvent.click(await screen.findByRole("option", { name: "库存" }))
    await userEvent.click(screen.getByRole("tab", { name: "2 触发条件" }))

    expect(screen.getByLabelText("条件 1 字段")).toHaveTextContent("请选择")
    const lowerSource = screen.getByRole("radiogroup", { name: "条件 1 比较值来源" })
    const upperSource = screen.getByRole("radiogroup", { name: "条件 1 上界来源" })
    await userEvent.click(within(lowerSource).getByText("固定值"))
    await userEvent.click(within(upperSource).getByText("固定值"))
    expect(screen.getByLabelText("条件 1 比较值")).toHaveValue("10")
    expect(screen.getByLabelText("条件 1 上界")).toHaveValue("30")
  })

  it("preserves an unfinished comma-delimited notification draft while structuring targets", async () => {
    renderPage(<RuleEditorPage id="rule-1" navigate={vi.fn()} />)
    await screen.findByRole("heading", { name: "编辑异常规则" })
    await userEvent.click(screen.getByRole("tab", { name: "6 私聊通知" }))

    const input = screen.getByLabelText("固定 user_id")
    await userEvent.clear(input)
    await userEvent.type(input, "alpha, beta")

    expect(input).toHaveValue("alpha, beta")
  })

  it("rejects a nonnumeric literal for a numeric comparison and focuses its input", async () => {
    renderPage(<RuleEditorPage id="rule-1" navigate={vi.fn()} />)
    await screen.findByRole("heading", { name: "编辑异常规则" })
    await userEvent.click(screen.getByRole("tab", { name: "2 触发条件" }))
    const operand = screen.getByLabelText("条件 1 比较值")
    await userEvent.clear(operand)
    await userEvent.type(operand, "not-a-number")

    await userEvent.click(screen.getByRole("button", { name: "保存规则" }))

    expect(await screen.findByText("当前运算符需要数值比较值")).toBeInTheDocument()
    await waitFor(() => expect(operand).toHaveFocus())
    expect(updateRule).not.toHaveBeenCalled()
  })

  it("rejects an incomplete Markdown link and focuses the private template", async () => {
    renderPage(<RuleEditorPage id="rule-1" navigate={vi.fn()} />)
    await screen.findByRole("heading", { name: "编辑异常规则" })
    await userEvent.click(screen.getByRole("tab", { name: "6 私聊通知" }))
    const template = screen.getByLabelText("私聊消息模板")
    fireEvent.change(template, { target: { value: "[查看说明](" } })

    await userEvent.click(screen.getByRole("button", { name: "保存规则" }))

    expect(await screen.findByText("超链接格式不完整")).toBeInTheDocument()
    await waitFor(() => expect(template).toHaveFocus())
    expect(updateRule).not.toHaveBeenCalled()
  })

  it("rejects a non-Feishu webhook and focuses the broadcast input", async () => {
    renderPage(<RuleEditorPage id="rule-1" navigate={vi.fn()} />)
    await screen.findByRole("heading", { name: "编辑异常规则" })
    await userEvent.click(screen.getByRole("tab", { name: "7 群广播" }))
    const webhook = screen.getByLabelText("群机器人 Webhook")
    await userEvent.type(webhook, "https://example.com/hook")

    await userEvent.click(screen.getByRole("button", { name: "保存规则" }))

    expect(await screen.findByText("群机器人 webhook 必须是飞书官方 HTTPS 地址")).toBeInTheDocument()
    await waitFor(() => expect(webhook).toHaveFocus())
    expect(updateRule).not.toHaveBeenCalled()
  })

  it("keeps an incomplete notification field row visible and focuses its inline error", async () => {
    renderPage(<RuleEditorPage id="rule-1" navigate={vi.fn()} />)
    await screen.findByRole("heading", { name: "编辑异常规则" })
    await userEvent.click(screen.getByRole("tab", { name: "6 私聊通知" }))
    await userEvent.click(screen.getByRole("button", { name: "添加字段目标" }))

    await userEvent.click(screen.getByRole("button", { name: "保存规则" }))

    const row = screen.getByTestId("notification-target-row-1")
    expect(within(row).getByText("字段目标需要选择字段")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText("字段目标 1 字段")).toHaveFocus())
    expect(updateRule).not.toHaveBeenCalled()
  })

  it("keeps an incomplete validation literal target visible and focuses its input", async () => {
    listRules.mockResolvedValue([{ ...rules[0], validation_targets: [{ source: "literal", value: "" }] }])
    renderPage(<RuleEditorPage id="rule-1" navigate={vi.fn()} />)
    await screen.findByRole("heading", { name: "编辑异常规则" })

    await userEvent.click(screen.getByRole("button", { name: "保存规则" }))

    const tab = screen.getByRole("tab", { name: "5 实时校验" })
    await waitFor(() => expect(tab).toHaveAttribute("data-state", "active"))
    expect(screen.getByText("固定验证目标需要填写 value")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText("固定验证 user_id")).toHaveFocus())
    expect(updateRule).not.toHaveBeenCalled()
  })

  it("keeps an incomplete broadcast field target visible and focuses its row", async () => {
    listRules.mockResolvedValue([{ ...rules[0], group_broadcast: { situation: { enabled: false, mention_targets: [{ source: "field", field: "" }] }, timeout: { enabled: false, mention_targets: [] } } }])
    renderPage(<RuleEditorPage id="rule-1" navigate={vi.fn()} />)
    await screen.findByRole("heading", { name: "编辑异常规则" })

    await userEvent.click(screen.getByRole("button", { name: "保存规则" }))

    const tab = screen.getByRole("tab", { name: "7 群广播" })
    await waitFor(() => expect(tab).toHaveAttribute("data-state", "active"))
    const row = screen.getByTestId("situation-target-row-0")
    expect(within(row).getByText("字段 @ 目标需要选择字段")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText("异常情况播报字段目标 1")).toHaveFocus())
    expect(updateRule).not.toHaveBeenCalled()
  })
})
