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

  it("refreshes shared record caches but not the old detail after its route is replaced", async () => {
    records.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 20 })
    recordCounts.mockResolvedValue(0)
    let finish: ((value: unknown) => void) | undefined
    recordDetail.mockImplementation((id: string) => Promise.resolve({ id, severity: "high", status: "pending", business_key_summary: id, data: {}, validation_requests: [], deliveries: [], delivery_diagnostics: [], push_jobs: [] }))
    recordStatus.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    toastSuccess.mockClear()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateQueries = vi.spyOn(client, "invalidateQueries")
    const page = render(<QueryClientProvider client={client}><RecordsPage detailId="old" navigate={vi.fn()} /></QueryClientProvider>)

    await screen.findByRole("button", { name: "已解决" })
    fireEvent.click(screen.getByRole("button", { name: "已解决" }))
    await waitFor(() => expect(recordStatus).toHaveBeenCalledWith("old", "resolved"))
    page.rerender(<QueryClientProvider client={client}><RecordsPage detailId="new" navigate={vi.fn()} /></QueryClientProvider>)
    await screen.findByText("new")
    finish?.({ id: "old" })
    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["records"] })
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["record-counts"] })
    })
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["record", "old"] })
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("renders mapped Chinese detail tables for validation, push jobs, deliveries, and timeline", async () => {
    records.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 20 })
    recordCounts.mockResolvedValue(0)
    recordDetail.mockResolvedValue({
      id: "detail-1",
      severity: "high",
      status: "pending",
      business_key_summary: "order_id: ORDER-99",
      data: { amount: 999 },
      validation_requests: [{ recipient_user_id: "validator-1", delivery_status: "sent", delivery_attempts: 2, message_id: "validation-message", last_error: "", delivered_at: "2026-08-30T01:00:00Z" }],
      push_jobs: [
        { id: "push-1", kind: "group_broadcast", status: "partial_failed", publish_attempts: 2, dispatch_attempts: 1, next_attempt_at: "2026-08-30T02:00:00Z", error: "queue timeout" },
        { id: "push-2", kind: "notification", status: "sent", publish_attempts: 1, dispatch_attempts: 1 },
        { id: "push-3", kind: "validation", status: "pending", publish_attempts: 1, dispatch_attempts: 0 },
      ],
      deliveries: [{ kind: "notification", status: "failed", attempts: 3, recipient: "ou-notification", message_id: "delivery-message", error: "network error" }],
      delivery_diagnostics: [],
      timeline: [{ type: "resolved", description: "人工关闭", created_at: "2026-08-30T03:00:00Z" }],
    })

    renderPage(<RecordsPage detailId="detail-1" navigate={vi.fn()} />)

    expect(await screen.findByRole("columnheader", { name: "校验对象" })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "推送类型" })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "接收对象" })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "事件说明" })).toBeInTheDocument()
    expect(screen.getByText("validator-1")).toBeInTheDocument()
    expect(screen.getByText("群广播")).toBeInTheDocument()
    expect(screen.getByText("通知推送")).toBeInTheDocument()
    expect(screen.getByText("校验推送")).toBeInTheDocument()
    expect(screen.queryByText("group_broadcast")).not.toBeInTheDocument()
    expect(screen.queryByText("notification")).not.toBeInTheDocument()
    expect(screen.queryByText("validation")).not.toBeInTheDocument()
    expect(screen.getByText("ou-notification")).toBeInTheDocument()
    expect(screen.getByText("人工关闭")).toBeInTheDocument()
    expect(screen.queryByText("publish_attempts")).not.toBeInTheDocument()
    expect(screen.queryByText("recipient_user_id")).not.toBeInTheDocument()
  })
})
