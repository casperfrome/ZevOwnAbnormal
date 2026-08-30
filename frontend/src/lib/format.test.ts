import { describe, expect, it } from "vitest"
import { csvText, formatDateTime } from "./format"

describe("format helpers", () => {
  it("escapes commas, quotes and newlines in CSV", () => {
    expect(csvText([{ name: "a,b", note: "x\"y\nz" }])).toBe('\uFEFFname,note\r\n"a,b","x""y\nz"')
  })

  it("formats absent dates consistently", () => {
    expect(formatDateTime()).toBe("—")
  })
})
