import { describe, expect, it } from "vitest"
import { businessKeyText, csvText, formatDateTime, valueText } from "./format"

describe("format helpers", () => {
  it("escapes commas, quotes and newlines in CSV", () => {
    expect(csvText([{ name: "a,b", note: "x\"y\nz" }])).toBe('\uFEFFname,note\r\n"a,b","x""y\nz"')
  })

  it("neutralizes spreadsheet formulas without corrupting negative numbers", () => {
    expect(csvText([{ formula: "=SUM(1,2)", command: "\t +cmd", debit: -7 }])).toBe(
      '\uFEFFformula,command,debit\r\n"\'=SUM(1,2)",\'\t +cmd,-7',
    )
  })

  it("neutralizes formulas after leading whitespace and control characters without rewriting the cell", () => {
    expect(csvText([
      { value: " =1" },
      { value: "\n+cmd" },
      { value: "\t-1" },
      { value: "\u0000@cmd" },
    ])).toBe("\uFEFFvalue\r\n' =1\r\n\"'\n+cmd\"\r\n'\t-1\r\n'\u0000@cmd")
    expect(csvText([{ value: -7 }])).toBe("\uFEFFvalue\r\n-7")
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
