import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import App from "./App"
import { StatusBadge } from "./components/shared"

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))

describe("application shell", () => {
  beforeEach(() => { window.location.hash = "#overview" })

  it("shows the login boundary and authenticates", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => json({ detail: "未登录" }, 401))
      .mockImplementationOnce(() => json({ id: "u1", login_name: "admin", display_name: "管理员", is_superuser: true }))
      .mockImplementation(() => json({ stats: {} }))
    vi.stubGlobal("fetch", fetchMock)
    render(<App />)
    expect(await screen.findByRole("heading", { name: "登录 ZevOwnAbnormal" })).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText("登录名"), "admin")
    await userEvent.type(screen.getByLabelText("密码"), "secret")
    await userEvent.click(screen.getByRole("button", { name: "登录" }))
    expect(await screen.findByText("管理员")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /账号管理/ })).toBeInTheDocument()
  })

  it("hides administrator navigation for regular users", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith("/auth/me")) return json({ id: "u2", login_name: "analyst", display_name: "分析师", is_superuser: false })
      return json({ stats: {} })
    }))
    render(<App />)
    await waitFor(() => expect(screen.getByText("分析师")).toBeInTheDocument())
    expect(screen.queryByRole("link", { name: /账号管理/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /系统测试/ })).not.toBeInTheDocument()
  })

  it.each(["tests", "accounts"])("redirects regular users from #%s to a coherent records route", async (restrictedRoute) => {
    window.location.hash = `#${restrictedRoute}`
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith("/auth/me")) return json({ id: "u2", login_name: "analyst", display_name: "分析师", is_superuser: false })
      if (path.includes("/anomalies")) return json({ items: [], total: 0, page: 1, page_size: 20 })
      return json([])
    }))

    render(<App />)

    expect(await screen.findByRole("heading", { name: "异常记录" })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe("#records"))
    expect(within(screen.getByRole("navigation", { name: "breadcrumb" })).getByRole("link", { name: "异常记录" })).toHaveAttribute("aria-current", "page")
  })

  it("shows a numeric pending-record badge when the count is positive", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith("/auth/me")) return json({ id: "u3", login_name: "operator", display_name: "值班员", is_superuser: false })
      if (path.includes("/anomalies?page=1&page_size=1&status_filter=pending")) return json({ items: [], total: 3, page: 1, page_size: 1 })
      return json([])
    }))
    render(<App />)
    expect(await screen.findByText("值班员")).toBeInTheDocument()
    expect(await screen.findByLabelText("3 条待处理异常")).toHaveTextContent(/^3$/)
  })

  it("hides the pending-record badge when the count is zero", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith("/auth/me")) return json({ id: "u3", login_name: "operator", display_name: "值班员", is_superuser: false })
      if (path.includes("/anomalies?page=1&page_size=1&status_filter=pending")) return json({ items: [], total: 0, page: 1, page_size: 1 })
      return json([])
    }))
    render(<App />)
    expect(await screen.findByText("值班员")).toBeInTheDocument()
    expect(screen.queryByLabelText(/条待处理异常/)).not.toBeInTheDocument()
  })

  it("shows tooltips for icon-only shell controls", async () => {
    const user = userEvent.setup()
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith("/auth/me")) return json({ id: "u4", login_name: "operator", display_name: "值班员", is_superuser: false })
      if (String(input).includes("/anomalies?page=1&page_size=1&status_filter=pending")) return json({ items: [], total: 0, page: 1, page_size: 1 })
      return json([])
    }))
    render(<App />)
    await screen.findByText("值班员")
    await user.hover(screen.getByRole("button", { name: "打开导航" }))
    expect(await screen.findByRole("tooltip", { name: "打开导航" })).toBeInTheDocument()
    fireEvent.focus(screen.getByRole("button", { name: "打开全局搜索" }))
    expect(await screen.findByRole("tooltip", { name: "打开全局搜索" })).toBeInTheDocument()
  })

  it("renders Chinese labels for current delivery statuses", () => {
    render(<div>{["in_transit", "waiting", "waiting_delivery", "none", "partial_failed"].map((value) => <StatusBadge key={value} value={value} />)}</div>)
    expect(screen.getByText("传输中")).toBeInTheDocument()
    expect(screen.getByText("等待处理")).toBeInTheDocument()
    expect(screen.getByText("等待投递")).toBeInTheDocument()
    expect(screen.getByText("未推送")).toBeInTheDocument()
    expect(screen.getByText("部分失败")).toBeInTheDocument()
  })
})
