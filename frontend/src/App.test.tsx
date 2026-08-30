import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import App from "./App"

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
  })

  it("shows a real pending-record count and never a decorative dot", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith("/auth/me")) return json({ id: "u3", login_name: "operator", display_name: "值班员", is_superuser: false })
      if (path.includes("/anomalies?page=1&page_size=1&status_filter=pending")) return json({ items: [], total: 3, page: 1, page_size: 1 })
      return json([])
    }))
    render(<App />)
    expect(await screen.findByText("值班员")).toBeInTheDocument()
    expect(await screen.findByText("3")).toBeInTheDocument()
    expect(screen.queryByText("•")).not.toBeInTheDocument()
  })
})
