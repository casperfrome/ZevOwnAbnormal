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

vi.mock("@/app/context", () => ({
  useApp: () => ({
    resources: {
      rules: { list: listRules, execute: executeRule, sync: syncRule, enable: enableRule, remove: removeRule, update: updateRule, create: vi.fn() },
      datasets: { list: listDatasets },
      datasources: { list: listDatasources },
    },
  }),
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

const rules = [
  { id: "rule-1", name: "订单金额监控", description: "检查高金额订单", dataset_id: "ds-1", dataset_name: "订单", severity: "high", logic: "AND", enabled: true, conditions: [{ field: "amount", operator: "gt", value: 100 }], anomaly_key_fields: ["order_id"], repeat_push_enabled: false, schedule: { frequency: "day", interval: 1, time: "09:00", start_date: "2026-08-30" }, notification_targets: [{ receive_id_type: "user_id", source: "literal", value: "owner" }], validation_targets: [], deadline_seconds: 86400, validation_method: "pseudo", group_broadcast: { situation: { enabled: false }, timeout: { enabled: false } }, sync_status: "synced" },
  { id: "rule-2", name: "库存阈值", description: "检查库存", dataset_id: "ds-2", dataset_name: "库存", severity: "medium", logic: "OR", enabled: false, conditions: [{ field: "stock", operator: "lt", value: 3 }], anomaly_key_fields: ["sku"], schedule: { frequency: "hour", interval: 2, start_date: "2026-08-30" }, notification_targets: [{ receive_id_type: "user_id", source: "literal", value: "owner" }], validation_targets: [], deadline_seconds: 3600, validation_method: "pseudo", group_broadcast: { situation: { enabled: false }, timeout: { enabled: false } }, sync_status: "pending" },
]

function renderPage(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><TooltipProvider>{node}</TooltipProvider></QueryClientProvider>)
}

describe("rule pages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listRules.mockResolvedValue(rules)
    listDatasets.mockResolvedValue([
      { id: "ds-1", name: "订单", datasource_id: "source-1", sql: "select * from orders", fields: [{ name: "order_id", type: "VARCHAR" }, { name: "amount", type: "DECIMAL" }, { name: "limit", type: "DECIMAL" }, { name: "reviewer_id", type: "VARCHAR" }] },
      { id: "ds-2", name: "库存", datasource_id: "source-1", sql: "select * from stock", fields: [{ name: "sku", type: "VARCHAR" }, { name: "stock", type: "INTEGER" }] },
    ])
    listDatasources.mockResolvedValue([{ id: "source-1", name: "生产库", type: "mysql", host: "db", port: 3306, database: "app", username: "reader", ssl: false }])
  })

  it("filters the operational list and keeps pending state scoped to the selected action", async () => {
    let finishExecute: ((value: unknown) => void) | undefined
    executeRule.mockImplementation(() => new Promise((resolve) => { finishExecute = resolve }))
    renderPage(<RulesPage navigate={vi.fn()} />)

    expect(await screen.findByText("规则总数")).toBeInTheDocument()
    expect(screen.getByText("2", { selector: ".metric-number" })).toBeInTheDocument()
    const search = screen.getByRole("searchbox", { name: "搜索异常规则" })
    fireEvent.change(search, { target: { value: "库存" } })
    expect(screen.queryByText("订单金额监控")).not.toBeInTheDocument()
    expect(screen.getByText("库存阈值")).toBeInTheDocument()
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
})
