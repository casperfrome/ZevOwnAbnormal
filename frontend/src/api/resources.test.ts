import { describe, expect, it, vi } from "vitest"

import { ApiClient } from "./client"
import type { Rule } from "./types"
import { createResources, datasourceUpdatePayload, mapAnomalyGroup, mapBroadcastDelivery, mapDatasetExecution, mapOverview, mapRecord, mapRecordDetail, recordQuery, rulePayload, ruleToEditorModel } from "./resources"

describe("API resource mappings", () => {
  it("encodes record filters and repeated ids", () => {
    expect(recordQuery({ page: 2, pageSize: 25, search: "订单 异常", ids: ["a", "b"] })).toBe(
      "page=2&page_size=25&search=%E8%AE%A2%E5%8D%95+%E5%BC%82%E5%B8%B8&ids=a&ids=b",
    )
  })

  it("encodes the backend-approved record status filter literal", () => {
    expect(recordQuery({ status: "resolved" })).toBe("status_filter=resolved")
  })

  it("keeps the datasource type immutable and preserves an existing password", () => {
    expect(datasourceUpdatePayload({
      name: "生产库", type: "mysql", host: "db", port: 3306, database: "app", username: "root", password: "", ssl: true,
    })).toEqual({ name: "生产库", host: "db", port: 3306, database: "app", username: "root", ssl: true, description: "" })
  })

  it("maps the rule editor model to the backend contract", () => {
    const payload = rulePayload({
      name: "金额异常", datasetId: "ds-1", severity: "high", logic: "AND", enabled: true,
      conditions: [{ field: "amount", operator: "gt", value: "100" }],
      schedule: { frequency: "daily", interval: 1, time: "09:00", start: "2026-08-30" },
      deadlineSeconds: 1800, validationEnabled: true, validationMethod: "pseudo",
      notificationTargets: [{ receive_id_type: "open_id", source: "literal", value: "ou_x" }],
      groupBroadcast: { situation: { enabled: true, messageTemplate: "发现 {{count}} 条异常" } },
    })
    expect(payload).toMatchObject({ dataset_id: "ds-1", deadline_seconds: 1800, validation_enabled: true })
    expect(payload.conditions).toEqual([expect.objectContaining({ field: "amount", operator: "gt", value: "100" })])
    expect(payload.group_broadcast.situation).toMatchObject({ enabled: true, message_template: "发现 {{count}} 条异常" })
  })

  it("uses the typed client for paginated records", async () => {
    const client = new ApiClient()
    vi.spyOn(client, "request").mockResolvedValue({ items: [], total: 0, page: 1, page_size: 20 })
    await createResources(client).records.list({ page: 1, pageSize: 20 })
    expect(client.request).toHaveBeenCalledWith("/anomalies?page=1&page_size=20", { signal: undefined })
  })

  it("sends only backend-approved record status payload literals", async () => {
    const client = new ApiClient()
    vi.spyOn(client, "request").mockResolvedValue({})
    const resources = createResources(client)

    await resources.records.status("record-1", "resolved", "owner-1")
    await resources.records.bulkStatus(["record-1", "record-2"], "processing")

    expect(client.request).toHaveBeenNthCalledWith(1, "/anomalies/record-1/status", {
      method: "PATCH",
      body: { status: "resolved", assignee: "owner-1" },
    })
    expect(client.request).toHaveBeenNthCalledWith(2, "/anomalies/bulk-status", {
      method: "POST",
      body: { ids: ["record-1", "record-2"], status: "processing" },
    })
  })

  it("uses the backend username field for login", async () => {
    const client = new ApiClient()
    vi.spyOn(client, "request").mockResolvedValue({ id: "u1" })
    await createResources(client).auth.login("admin", "secret")
    expect(client.request).toHaveBeenCalledWith("/auth/login", { method: "POST", body: { username: "admin", password: "secret" } })
  })

  it("maps backend anomaly and group names without losing deep-link ids", () => {
    expect(mapRecord({ id: "a1", business_key: "ORDER-42", first_seen_at: "2026-08-30T01:00:00Z", row_details: { amount: 9 }, delivery_status: "sent" })).toMatchObject({ id: "a1", anomaly_key: "ORDER-42", detected_at: "2026-08-30T01:00:00Z", push_status: "sent" })
    expect(mapAnomalyGroup({ group_id: "run-1", rule_name: "订单规则", matched_rows: 3, detected_at: "2026-08-30T01:00:00Z" })).toMatchObject({ id: "run-1", rule_name: "订单规则", record_count: 3, last_detected_at: "2026-08-30T01:00:00Z" })
  })

  it("keeps backend-approved record sorting on list and export requests", async () => {
    expect(recordQuery({ sortKey: "occurredAt", sortOrder: "asc" })).toBe("sort_key=occurredAt&sort_order=asc")
    const client = new ApiClient()
    vi.spyOn(client, "request").mockResolvedValue(new Blob())
    await createResources(client).records.export({ sortKey: "occurredAt", sortOrder: "desc" })
    expect(client.request).toHaveBeenCalledWith("/anomalies/export?sort_key=occurredAt&sort_order=desc", { responseType: "blob" })
  })

  it("normalizes anomaly detail, group delivery and overview contracts", () => {
    const detail = mapRecordDetail({ id: "a1", business_key: { order_id: "A-42" }, row_details: { amount: 9 }, validation_requests: [{ status: "sent" }], deliveries: [{ id: "d1", status: "failed", error_message: "network" }] })
    expect(detail).toMatchObject({ id: "a1", business_key: { order_id: "A-42" }, data: { amount: 9 }, validation_requests: [{ status: "sent" }] })
    expect(mapBroadcastDelivery({ id: "d1", broadcast_kind: "timeout", status: "failed", error_message: "network" })).toMatchObject({ id: "d1", kind: "timeout", status: "failed", error: "network" })
    expect(mapOverview({ stats: { pending_records: 4 }, recent_anomalies: [{ id: "a1" }] })).toMatchObject({ stats: { pending_records: 4 }, recent_anomalies: [{ id: "a1" }] })
  })

  it("normalizes the backend trend and dataset execution field contracts", () => {
    expect(mapOverview({ days: 7, timezone: "Asia/Shanghai", trend: [{ date: "2026-08-30", count: 2 }] })).toMatchObject({
      days: 7,
      timezone: "Asia/Shanghai",
      trend: [{ date: "2026-08-30", count: 2 }],
    })
    expect(mapDatasetExecution({ fields: [{ name: "order_id", type: "VARCHAR" }, { name: "amount", type: "DECIMAL" }], rows: [["A-1", 9]], row_count: 1, elapsed_ms: 3 })).toEqual({
      fields: [{ name: "order_id", type: "VARCHAR" }, { name: "amount", type: "DECIMAL" }],
      columns: ["order_id", "amount"],
      rows: [["A-1", 9]],
      row_count: 1,
      elapsed_ms: 3,
      duration_ms: 3,
    })
  })

  it("keeps push-job diagnostics distinct from notification deliveries", () => {
    const detail = mapRecordDetail({ id: "a1", deliveries: [{ status: "sent", recipient: "ou_1" }], push_jobs: [{ id: "job-1", kind: "group_broadcast", status: "partial_failed", publish_attempts: 2, dispatch_attempts: 1, last_error: "timeout" }] })
    expect(detail.deliveries).toHaveLength(1)
    expect(detail.push_jobs).toEqual([expect.objectContaining({ id: "job-1", kind: "group_broadcast", status: "partial_failed", attempts: 3, error: "timeout" })])
  })

  it("maps backend group status_counts into explicit summary counts", () => {
    expect(mapAnomalyGroup({ group_id: "run-1", status_counts: { pending: 4, processing: 3, resolved: 2, timed_out: 1 } })).toMatchObject({ pending_count: 4, processing_count: 3, resolved_count: 2, timed_out_count: 1 })
  })

  it("keeps notification deliveries without a backend id identifiable without an empty id", () => {
    const detail = mapRecordDetail({ id: "a1", deliveries: [{ status: "sent", channel: "feishu" }] })
    expect(detail.deliveries[0]).toMatchObject({ status: "sent" })
    expect(detail.deliveries[0].id).toBeUndefined()
  })

  it("restores snake-case rule configuration into the editor model", () => {
    const model = ruleToEditorModel({ id: "r1", name: "规则", dataset_id: "ds", severity: "high", logic: "AND", conditions: [], enabled: true, schedule: { frequency: "daily", interval: 1, start_date: "2026-08-01" }, group_broadcast: { webhook_url: "https://example.test/hook", situation: { enabled: true, message_template: "异常" } } })
    expect(model.schedule.start).toBe("2026-08-01")
    expect(model.groupBroadcast).toMatchObject({ webhookUrl: "https://example.test/hook", situation: { enabled: true, messageTemplate: "异常" } })
  })

  it("round-trips every structured rule field without flattening nested backend contracts", () => {
    const backendRule: Rule = {
      id: "r-full", name: "完整规则", description: "保留所有配置", dataset_id: "ds-1", dataset_name: "订单",
      severity: "high", logic: "OR" as const, enabled: true,
      conditions: [{ field: "amount", operator: "between", value: "10", upper_value: "20", value_source: "literal", upper_value_source: "field", upper_value_field: "limit", baseline: null }],
      anomaly_key_fields: ["order_id"], repeat_push_enabled: true,
      schedule: { frequency: "hour", interval: 2, time: null, start_date: "2026-08-01", end_date: "2026-09-01" },
      notification_targets: [
        { receive_id_type: "user_id", source: "literal", value: "owner" },
        { receive_id_type: "open_id", source: "field", field: "reviewer_id" },
      ],
      private_message_template: "异常 {order_id}\n[查看]({异常记录链接})",
      validation_enabled: true,
      validation_targets: [{ source: "literal", value: "validator" }, { source: "field", field: "reviewer_id" }],
      deadline_seconds: 93784,
      validation_method: "sql",
      sql_validation_config: {
        datasource_id: "source-2",
        query_template: "SELECT status, low, high FROM repair WHERE order_id={id}",
        parameters: [{ name: "id", field: "order_id" }],
        true_condition: { field: "status", operator: "between", value: null, upper_value: null, value_source: "field", value_field: "low", upper_value_source: "field", upper_value_field: "high" },
      },
      group_broadcast: {
        webhook_url: "https://open.feishu.cn/open-apis/bot/v2/hook/example",
        situation: { enabled: true, mention_targets: [{ source: "field", field: "reviewer_id" }], message_template: "异常 {order_id列表}" },
        timeout: { enabled: true, mention_targets: [{ source: "literal", value: "backup" }], message_template: "超时 {order_id列表}" },
      },
    }

    const payload = rulePayload(ruleToEditorModel(backendRule))

    expect(payload).toMatchObject({
      dataset_id: "ds-1", anomaly_key_fields: ["order_id"], repeat_push_enabled: true, deadline_seconds: 93784,
      validation_targets: backendRule.validation_targets,
      sql_validation_config: backendRule.sql_validation_config,
      notification_targets: backendRule.notification_targets,
      group_broadcast: {
        webhook_url: (backendRule.group_broadcast as Record<string, unknown>).webhook_url,
        situation: { enabled: true, mention_targets: [{ source: "field", field: "reviewer_id" }], message_template: "异常 {order_id列表}" },
        timeout: { enabled: true, mention_targets: [{ source: "literal", value: "backup" }], message_template: "超时 {order_id列表}" },
      },
    })
  })

  it("round-trips the complete rule contract against a literal payload oracle", () => {
    const backendRule: Rule = {
      id: "r-literal", name: "订单区间规则", description: "覆盖完整规则契约", dataset_id: "ds-orders", dataset_name: "订单明细",
      severity: "medium", logic: "OR", enabled: true,
      conditions: [{ field: "amount", operator: "between", value: 12.5, upper_value: 88.75, baseline: null, value_source: "literal", value_field: null, upper_value_source: "literal", upper_value_field: null }],
      anomaly_key_fields: ["order_id", "shop_id"], repeat_push_enabled: true,
      schedule: { frequency: "day", interval: 1, time: "08:30", start_date: "2026-09-01", end_date: "2026-12-31" },
      notification_targets: [{ receive_id_type: "user_id", source: "literal", value: "owner-1" }, { receive_id_type: "open_id", source: "field", field: "reviewer_open_id" }],
      private_message_template: "订单 {order_id}\n[查看异常]({异常记录链接})",
      validation_enabled: true,
      validation_targets: [{ source: "literal", value: "validator-1" }, { source: "field", field: "validator_id" }],
      deadline_seconds: 3661,
      validation_method: "pseudo",
      sql_validation_config: null,
      group_broadcast: {
        webhook_url: "https://open.feishu.cn/open-apis/bot/v2/hook/literal-token",
        situation: { enabled: true, mention_targets: [{ source: "literal", value: "situation-owner" }], message_template: "异常订单 {order_id列表}" },
        timeout: { enabled: true, mention_targets: [{ source: "field", field: "timeout_owner_id" }], message_template: "超时订单 {order_id列表}\n[查看分组]({异常记录组链接})" },
      },
    }

    expect(rulePayload(ruleToEditorModel(backendRule))).toEqual({
      name: "订单区间规则",
      description: "覆盖完整规则契约",
      dataset_id: "ds-orders",
      severity: "medium",
      logic: "OR",
      conditions: [{ field: "amount", operator: "between", value: 12.5, upper_value: 88.75, baseline: null, value_source: "literal", value_field: null, upper_value_source: "literal", upper_value_field: null }],
      anomaly_key_fields: ["order_id", "shop_id"],
      repeat_push_enabled: true,
      schedule: { frequency: "day", interval: 1, time: "08:30", start_date: "2026-09-01", end_date: "2026-12-31" },
      notification_targets: [{ receive_id_type: "user_id", source: "literal", value: "owner-1" }, { receive_id_type: "open_id", source: "field", field: "reviewer_open_id" }],
      private_message_template: "订单 {order_id}\n[查看异常]({异常记录链接})",
      validation_enabled: true,
      validation_targets: [{ source: "literal", value: "validator-1" }, { source: "field", field: "validator_id" }],
      deadline_seconds: 3661,
      validation_method: "pseudo",
      sql_validation_config: null,
      group_broadcast: {
        webhook_url: "https://open.feishu.cn/open-apis/bot/v2/hook/literal-token",
        situation: { enabled: true, mention_targets: [{ source: "literal", value: "situation-owner" }], message_template: "异常订单 {order_id列表}" },
        timeout: { enabled: true, mention_targets: [{ source: "field", field: "timeout_owner_id" }], message_template: "超时订单 {order_id列表}\n[查看分组]({异常记录组链接})" },
      },
      enabled: true,
    })
  })

  it("does not silently discard incomplete configured target rows", () => {
    const model = ruleToEditorModel({
      id: "r-targets", name: "目标草稿", dataset_id: "ds-1", severity: "medium", logic: "AND", enabled: false,
      conditions: [{ field: "amount", operator: "gt", value: 1 }], anomaly_key_fields: ["order_id"],
      schedule: { frequency: "day", interval: 1, time: "09:00", start_date: "2026-08-30" },
      notification_targets: [{ receive_id_type: "user_id", source: "field", field: "" }],
      validation_targets: [{ source: "literal", value: "" }],
      group_broadcast: { situation: { enabled: false, mention_targets: [{ source: "field", field: "" }] }, timeout: { enabled: false, mention_targets: [{ source: "literal", value: "" }] } },
    })

    const payload = rulePayload(model)

    expect(payload.notification_targets).toEqual([{ receive_id_type: "user_id", source: "field", field: "" }])
    expect(payload.validation_targets).toEqual([{ source: "literal", value: "" }])
    expect(payload.group_broadcast).toMatchObject({
      situation: { mention_targets: [{ source: "field", field: "" }] },
      timeout: { mention_targets: [{ source: "literal", value: "" }] },
    })
  })

  it("loads the actual pending record count through the paginated anomalies endpoint", async () => {
    const client = new ApiClient()
    vi.spyOn(client, "request").mockResolvedValue({ items: [], total: 3, page: 1, page_size: 1 })
    await createResources(client).records.pendingCount()
    expect(client.request).toHaveBeenCalledWith("/anomalies?page=1&page_size=1&status_filter=pending", { signal: undefined })
  })
})
