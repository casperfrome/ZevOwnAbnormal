import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { RecordsPage } from "./records"
import { GroupsPage } from "./groups"

const records = vi.fn()
const groups = vi.fn()

vi.mock("@/app/context", () => ({
  useApp: () => ({
    resources: {
      records: { list: records, detail: vi.fn(), status: vi.fn(), bulkStatus: vi.fn(), export: vi.fn() },
      groups: { list: groups, detail: vi.fn() },
      rules: { list: vi.fn().mockResolvedValue([{ id: "rule-1", name: "订单金额监控" }]) },
    },
  }),
}))

function renderPage(page: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{page}</QueryClientProvider>)
}

describe("monitor pages", () => {
  it("renders readable record business data in the dense operational table", async () => {
    records.mockResolvedValue({
      items: [{ id: "rec-1", business_key: { order_id: "ORDER-42" }, business_key_summary: "order_id: ORDER-42", anomaly_key: "order_id: ORDER-42", rule_name: "订单金额监控", severity: "high", status: "pending", detected_at: "2026-08-30T01:00:00Z", assignee: "王敏", data: { amount: 999 } }],
      total: 1, page: 1, page_size: 20,
    })

    renderPage(<RecordsPage navigate={vi.fn()} />)

    expect((await screen.findAllByText("order_id: ORDER-42")).length).toBeGreaterThan(0)
    expect(screen.getByRole("columnheader", { name: "异常字段 / 值" })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "处理人" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /待处理/ })).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: /查看 rec-1 详情/ }).length).toBeGreaterThan(0)
  })

  it("opens a group from the complete keyboard-operable row and shows its operational summary", async () => {
    groups.mockResolvedValue({
      items: [{ id: "group-1", rule_name: "订单金额监控", scanned_rows: 120, matched_rows: 8, new_anomalies: 3, pending_count: 2, processing_count: 1, resolved_count: 4, timed_out_count: 1, situation_broadcast_status: "sent", timeout_broadcast_status: "waiting", last_detected_at: "2026-08-30T01:00:00Z" }],
      total: 1, page: 1, page_size: 20,
    })
    const navigate = vi.fn()

    renderPage(<GroupsPage navigate={navigate} />)

    const [row] = await screen.findAllByRole("button", { name: /订单金额监控/ })
    expect(row).toHaveAttribute("tabindex", "0")
    expect(screen.getAllByText("120 / 8 / 3").length).toBeGreaterThan(0)
    fireEvent.keyDown(row, { key: "Enter" })
    expect(navigate).toHaveBeenCalledWith("#anomaly-groups/group-1")
  })
})
