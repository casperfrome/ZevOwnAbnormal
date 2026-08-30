import { describe, expect, it } from "vitest"
import { businessKeyText, csvText, formatDateTime, valueText } from "./format"

describe("format helpers", () => {
  it("escapes commas, quotes and newlines in CSV", () => {
    expect(csvText([{ name: "a,b", note: "x\"y\nz" }])).toBe('\uFEFFname,note\r\n"a,b","x""y\nz"')
  })

  it("formats absent dates consistently", () => {
    expect(formatDateTime()).toBe("—")
  })

  it("summarizes object business keys in a stable field order", () => {
    expect(businessKeyText({ shop_id: 7, order_id: "A-42", nested: { channel: "web" } })).toBe("nested: {\"channel\":\"web\"} · order_id: A-42 · shop_id: 7")
  })

  it("keeps generic detail values JSON-safe", () => {
    expect(valueText({ id: "A-42", amount: 9 })).toBe('{"id":"A-42","amount":9}')
  })
})
