import { describe, expect, it } from "vitest"
import { clampColumnWidth, readColumnWidths } from "./column-widths"

describe("persistent column widths", () => {
  it("clamps columns to an accessible minimum", () => expect(clampColumnWidth(40)).toBe(96))
  it("ignores malformed persisted values", () => expect(readColumnWidths("not-json")).toEqual({}))
  it("restores numeric persisted widths", () => expect(readColumnWidths('{"title":260,"status":"bad"}')).toEqual({ title: 260 }))
})
