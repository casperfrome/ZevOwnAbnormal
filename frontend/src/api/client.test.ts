import { afterEach, describe, expect, it, vi } from "vitest"

import { ApiClient, ApiError } from "@/api/client"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ApiClient", () => {
  it("prefixes API paths and sends JSON with same-origin credentials", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "rule-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const client = new ApiClient()
    await expect(client.request("/rules", { method: "POST", body: { name: "测试规则" } })).resolves.toEqual({ id: "rule-1" })

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/rules", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({ name: "测试规则" }),
    }))
  })

  it("notifies one unauthorized transition for concurrent current-session 401 responses", async () => {
    const unauthorized = vi.fn()
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "登录已过期" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })))

    const client = new ApiClient({ onUnauthorized: unauthorized })
    const results = await Promise.allSettled([
      client.request("/rules"),
      client.request("/datasets"),
    ])

    expect(results.every((result) => result.status === "rejected")).toBe(true)
    expect(unauthorized).toHaveBeenCalledTimes(1)
    expect(results[0]).toMatchObject({ reason: expect.any(ApiError) })
  })

  it("returns blobs without attempting JSON parsing", async () => {
    const blob = new Blob(["id,name\n1,异常"], { type: "text/csv" })
    vi.stubGlobal("fetch", vi.fn(async () => new Response(blob, { status: 200 })))

    const client = new ApiClient()
    await expect(client.request("/anomalies/export", { responseType: "blob" })).resolves.toEqual(blob)
  })
})
