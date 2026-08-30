import { describe, expect, it, vi } from "vitest"

import { ApiClient } from "./client"
import type { Rule } from "./types"
import { createResources, datasourceUpdatePayload, mapAnomalyGroup, mapBroadcastDelivery, mapOverview, mapRecord, mapRecordDetail, recordQuery, rulePayload, ruleToEditorModel } from "./resources"

describe("API resource mappings", () => {
  it("encodes record filters and repeated ids", () => {
    expect(recordQuery({ page: 2, pageSize: 25, search: "订单 异常", ids: ["a", "b"] })).toBe(
      "page=2&page_size=25&search=%E8%AE%A2%E5%8D%95+%E5%BC%82%E5%B8%B8&ids=a&ids=b",
    )
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

  it("loads the actual pending record count through the paginated anomalies endpoint", async () => {
    const client = new ApiClient()
    vi.spyOn(client, "request").mockResolvedValue({ items: [], total: 3, page: 1, page_size: 1 })
    await createResources(client).records.pendingCount()
    expect(client.request).toHaveBeenCalledWith("/anomalies?page=1&page_size=1&status_filter=pending", { signal: undefined })
  })
})
