import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { RecordsPage } from "./records"
import { GroupsPage } from "./groups"

const records = vi.fn()
const recordCounts = vi.fn()
const recordDetail = vi.fn()
const recordStatus = vi.fn()
const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }))
const groups = vi.fn()

vi.mock("@/app/context", () => ({
  useApp: () => ({
    resources: {
      records: { list: records, count: recordCounts, detail: recordDetail, status: recordStatus, bulkStatus: vi.fn(), export: vi.fn() },
      groups: { list: groups, detail: vi.fn() },
      rules: { list: vi.fn().mockResolvedValue([{ id: "rule-1", name: "订单金额监控" }]) },
    },
  }),
}))

vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: vi.fn() } }))

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
    recordCounts.mockImplementation((filters: { status?: string; severity?: string }) => Promise.resolve(filters.severity === "high" ? 9 : filters.status === "pending" ? 17 : 0))

    renderPage(<RecordsPage navigate={vi.fn()} />)

    expect((await screen.findAllByText("order_id: ORDER-42")).length).toBeGreaterThan(0)
    expect(screen.getByRole("columnheader", { name: "异常字段 / 值" })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "处理人" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /待处理/ })).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: /查看 rec-1 详情/ }).length).toBeGreaterThan(0)
    expect(await screen.findByText("17")).toBeInTheDocument()
    await waitFor(() => expect(records).toHaveBeenCalledWith(expect.objectContaining({ sortKey: "occurredAt" }), expect.anything()))
  })

  it("opens a group from the complete keyboard-operable row and shows its operational summary", async () => {
    groups.mockResolvedValue({
      items: [{ id: "group-1", rule_name: "订单金额监控", scanned_rows: 120, matched_rows: 8, new_anomalies: 3, pending_count: 2, processing_count: 1, resolved_count: 4, timed_out_count: 1, timeout_waiting_count: 5, timeout_waiting_delivery_count: 6, situation_broadcast_status: "sent", timeout_broadcast_status: "waiting", last_detected_at: "2026-08-30T01:00:00Z" }],
      total: 1, page: 1, page_size: 20,
    })
    const navigate = vi.fn()

    renderPage(<GroupsPage navigate={navigate} />)

    const [row] = await screen.findAllByRole("button", { name: /订单金额监控/ })
    expect(row).toHaveAttribute("tabindex", "0")
    expect(screen.getAllByText("120 / 8 / 3").length).toBeGreaterThan(0)
    expect(screen.getAllByText(/超时待播报 5 · 超时待投递 6/).length).toBeGreaterThan(0)
    fireEvent.keyDown(row, { key: "Enter" })
    expect(navigate).toHaveBeenCalledWith("#anomaly-groups/group-1")
  })

  it("does not announce a completed record transition after its route is replaced", async () => {
    records.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 20 })
    recordCounts.mockResolvedValue(0)
    let finish: ((value: unknown) => void) | undefined
    recordDetail.mockImplementation((id: string) => Promise.resolve({ id, severity: "high", status: "pending", business_key_summary: id, data: {}, validation_requests: [], deliveries: [], delivery_diagnostics: [], push_jobs: [] }))
    recordStatus.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    toastSuccess.mockClear()
    const page = renderPage(<RecordsPage detailId="old" navigate={vi.fn()} />)

    await screen.findByRole("button", { name: "已解决" })
    fireEvent.click(screen.getByRole("button", { name: "已解决" }))
    page.rerender(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RecordsPage detailId="new" navigate={vi.fn()} /></QueryClientProvider>)
    finish?.({ id: "old" })
    await waitFor(() => expect(toastSuccess).not.toHaveBeenCalled())
  })
})
