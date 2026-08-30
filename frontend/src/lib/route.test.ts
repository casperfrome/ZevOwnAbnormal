import { describe, expect, it } from "vitest"

import { parseHashRoute } from "@/lib/route"

describe("parseHashRoute", () => {
  it("keeps record and anomaly-group deep links addressable", () => {
    expect(parseHashRoute("#records/record%201")).toEqual({
      page: "records",
      detailId: "record 1",
    })
    expect(parseHashRoute("#anomaly-groups/run-1")).toEqual({
      page: "anomaly-groups",
      detailId: "run-1",
    })
  })

  it("recognizes dedicated rule and dataset editors", () => {
    expect(parseHashRoute("#rules/new")).toEqual({ page: "rule-editor", mode: "new" })
    expect(parseHashRoute("#rules/rule-1/edit")).toEqual({
      page: "rule-editor",
      mode: "edit",
      entityId: "rule-1",
    })
    expect(parseHashRoute("#datasets/dataset-1/edit")).toEqual({
      page: "dataset-editor",
      mode: "edit",
      entityId: "dataset-1",
    })
  })

  it("falls back to records for unknown routes", () => {
    expect(parseHashRoute("#unknown")).toEqual({ page: "records" })
  })
})
