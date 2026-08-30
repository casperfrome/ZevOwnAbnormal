import type { ApiClient } from "./client"
import type { AnomalyGroup, AnomalyGroupDetail, AnomalyRecord, AnomalyRecordDetail, BroadcastDelivery, Dataset, DatasetExecution, DatasetInput, Datasource, DatasourceInput, NotificationTarget, Overview, Paginated, PushJobDiagnostic, RecordFilters, Rule, RuleEditorModel, SqlValidationConfigEditor, User, ValidationTarget } from "./types"
import { businessKeyText } from "@/lib/format"

const clean = <T extends Record<string, unknown>>(value: T) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T

export function recordQuery(filters: RecordFilters = {}) {
  const query = new URLSearchParams()
  const values: Record<string, unknown> = { page: filters.page, page_size: filters.pageSize, status_filter: filters.status, push_status: filters.pushStatus, severity: filters.severity, rule_id: filters.ruleId, search: filters.search, sort_key: filters.sortKey, sort_order: filters.sortOrder }
  Object.entries(values).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)) })
  filters.ids?.forEach((id) => query.append("ids", id))
  return query.toString()
}

export const datasourcePayload = (data: DatasourceInput) => clean({ name: data.name, type: data.type, host: data.host, port: Number(data.port), database: data.database, username: data.username, password: data.password ?? "", ssl: Boolean(data.ssl), description: data.description ?? "" })
export const datasourceUpdatePayload = (data: DatasourceInput) => {
  const payload = datasourcePayload(data) as Record<string, unknown>
  delete payload.type
  if (!data.password) delete payload.password
  return payload
}
export const datasetPayload = (data: DatasetInput) => ({ name: data.name, datasource_id: data.datasourceId, description: data.description ?? "", sql: data.sql })

export function mapRecord(value: Record<string, unknown>): AnomalyRecord {
  const businessKey = value.business_key ?? value.anomaly_key ?? ""
  const matched = Array.isArray(value.matched_conditions) && value.matched_conditions[0] && typeof value.matched_conditions[0] === "object" ? value.matched_conditions[0] as Record<string, unknown> : {}
  const data = (value.row_details ?? value.data ?? {}) as Record<string, unknown>
  const field = String(value.field ?? value.anomaly_field ?? matched.field ?? "")
  return {
    ...value,
    id: String(value.id ?? ""),
    anomaly_key: businessKeyText(businessKey),
    business_key: businessKey as AnomalyRecord["business_key"],
    business_key_summary: businessKeyText(businessKey),
    title: String(value.description ?? businessKeyText(businessKey) ?? value.id ?? ""),
    severity: String(value.severity ?? "medium"),
    status: String(value.status ?? "pending"),
    detected_at: String(value.first_seen_at ?? value.detected_at ?? value.created_at ?? ""),
    created_at: String(value.created_at ?? value.first_seen_at ?? ""),
    push_status: String(value.delivery_status ?? value.push_status ?? "none"),
    field: field || undefined,
    anomalous_value: value.value ?? value.anomalous_value ?? matched.actual ?? (field ? data[field] : undefined),
    data,
  }
}

const records = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function mapBroadcastDelivery(value: Record<string, unknown>): BroadcastDelivery {
  const id = value.id == null || value.id === "" ? {} : { id: String(value.id) }
  return { ...value, ...id, kind: String(value.broadcast_kind ?? value.kind ?? "situation"), status: String(value.status ?? "pending"), attempts: Number(value.attempts ?? value.delivery_attempts ?? 0), error: typeof (value.error_message ?? value.last_error) === "string" ? String(value.error_message ?? value.last_error) : undefined, sent_at: typeof (value.sent_at ?? value.delivered_at) === "string" ? String(value.sent_at ?? value.delivered_at) : undefined }
}

export function mapPushJobDiagnostic(value: Record<string, unknown>): PushJobDiagnostic {
  const publish_attempts = Number(value.publish_attempts ?? 0); const dispatch_attempts = Number(value.dispatch_attempts ?? 0)
  return { ...value, id: String(value.id ?? ""), kind: String(value.kind ?? "notification"), status: String(value.status ?? "pending"), publish_attempts, dispatch_attempts, attempts: publish_attempts + dispatch_attempts, next_attempt_at: typeof value.next_attempt_at === "string" ? value.next_attempt_at : undefined, error: typeof value.last_error === "string" ? value.last_error : undefined, updated_at: typeof value.updated_at === "string" ? value.updated_at : undefined }
}

export function mapRecordDetail(value: Record<string, unknown>): AnomalyRecordDetail {
  const base = mapRecord(value)
  const rawDeliveries = Array.isArray(value.deliveries) ? value.deliveries : []
  return { ...base, validation_requests: Array.isArray(value.validation_requests) ? value.validation_requests.map(records) : [], deliveries: rawDeliveries.map(records).map(mapBroadcastDelivery), delivery_diagnostics: rawDeliveries.map(records).map(mapBroadcastDelivery), push_jobs: Array.isArray(value.push_jobs) ? value.push_jobs.map(records).map(mapPushJobDiagnostic) : [] }
}

export function mapAnomalyGroup(value: Record<string, unknown>): AnomalyGroup {
  const statusCounts = records(value.status_counts)
  return {
    ...value,
    id: String(value.group_id ?? value.id ?? ""),
    rule_name: String(value.rule_name ?? ""),
    record_count: Number(value.matched_rows ?? value.record_count ?? value.new_anomalies ?? 0),
    last_detected_at: String(value.detected_at ?? value.last_detected_at ?? ""),
    first_detected_at: String(value.detected_at ?? value.first_detected_at ?? ""),
    status: String(value.broadcast_status ?? value.status ?? ""),
    pending_count: Number(statusCounts.pending ?? value.pending_count ?? 0),
    processing_count: Number(statusCounts.processing ?? value.processing_count ?? 0),
    resolved_count: Number(statusCounts.resolved ?? value.resolved_count ?? 0),
    timed_out_count: Number(statusCounts.timed_out ?? value.timed_out_count ?? 0),
    scanned_rows: Number(value.scanned_rows ?? 0),
    matched_rows: Number(value.matched_rows ?? 0),
    new_anomalies: Number(value.new_anomalies ?? 0),
    situation_broadcast_status: String(value.situation_broadcast_status ?? value.broadcast_status ?? "disabled"),
    timeout_broadcast_status: String(value.timeout_broadcast_status ?? "disabled"),
    timeout_waiting_count: Number(value.timeout_waiting_count ?? 0),
    timeout_waiting_delivery_count: Number(value.timeout_waiting_delivery_count ?? 0),
  }
}

export function mapOverview(value: Record<string, unknown>): Overview {
  return { ...value, stats: records(value.stats) as Record<string, number>, trends: Array.isArray(value.trends) ? value.trends.map(records) : [], severity_distribution: Array.isArray(value.severity_distribution) ? value.severity_distribution.map(records) : [], recent_anomalies: Array.isArray(value.recent_anomalies) ? value.recent_anomalies.map(records).map(mapRecord) : [], top_rules: Array.isArray(value.top_rules) ? value.top_rules.map(records) : [] }
}

export function ruleToEditorModel(rule: Rule): RuleEditorModel {
  const schedule = (rule.schedule ?? {}) as Record<string, unknown>
  const group = (rule.group_broadcast ?? {}) as Record<string, unknown>
  const section = (value: unknown) => { const item = value && typeof value === "object" ? value as Record<string, unknown> : {}; return { enabled: Boolean(item.enabled), mentionTargets: Array.isArray(item.mention_targets) ? item.mention_targets as ValidationTarget[] : [], messageTemplate: typeof item.message_template === "string" ? item.message_template : "" } }
  const rawSql = rule.sql_validation_config && typeof rule.sql_validation_config === "object" ? rule.sql_validation_config as Record<string, unknown> : undefined
  const rawTrue = rawSql?.true_condition && typeof rawSql.true_condition === "object" ? rawSql.true_condition as Record<string, unknown> : {}
  const sqlValidationConfig: SqlValidationConfigEditor | undefined = rawSql ? {
    datasourceId: String(rawSql.datasource_id ?? ""), queryTemplate: String(rawSql.query_template ?? ""),
    parameters: Array.isArray(rawSql.parameters) ? rawSql.parameters as SqlValidationConfigEditor["parameters"] : [],
    trueCondition: {
      field: String(rawTrue.field ?? ""), operator: String(rawTrue.operator ?? "eq"), value: rawTrue.value, upperValue: rawTrue.upper_value,
      valueSource: rawTrue.value_source === "field" ? "field" : "literal", valueField: typeof rawTrue.value_field === "string" ? rawTrue.value_field : null,
      upperValueSource: rawTrue.upper_value_source === "field" ? "field" : "literal", upperValueField: typeof rawTrue.upper_value_field === "string" ? rawTrue.upper_value_field : null,
    },
  } : undefined
  return {
    name: rule.name, description: rule.description ?? "", datasetId: rule.dataset_id, severity: rule.severity, logic: rule.logic === "OR" ? "OR" : "AND", conditions: rule.conditions ?? [], enabled: rule.enabled,
    anomalyKeyFields: Array.isArray(rule.anomaly_key_fields) ? rule.anomaly_key_fields as string[] : [], repeatPushEnabled: Boolean(rule.repeat_push_enabled),
    schedule: { frequency: String(schedule.frequency ?? "day"), interval: Number(schedule.interval ?? 1), time: typeof schedule.time === "string" ? schedule.time : undefined, start: String(schedule.start_date ?? schedule.start ?? new Date().toISOString().slice(0, 10)), end: typeof (schedule.end_date ?? schedule.end) === "string" ? String(schedule.end_date ?? schedule.end) : undefined },
    notificationTargets: Array.isArray(rule.notification_targets) ? rule.notification_targets as NotificationTarget[] : [], privateMessageTemplate: typeof rule.private_message_template === "string" ? rule.private_message_template : "", validationEnabled: Boolean(rule.validation_enabled), validationTargets: Array.isArray(rule.validation_targets) ? rule.validation_targets as ValidationTarget[] : [], deadlineSeconds: Number(rule.deadline_seconds ?? 86400), validationMethod: typeof rule.validation_method === "string" ? rule.validation_method : "pseudo", sqlValidationConfig,
    groupBroadcast: { webhookUrl: typeof group.webhook_url === "string" ? group.webhook_url : "", situation: section(group.situation ?? group), timeout: section(group.timeout) },
  }
}

const broadcastSection = (section: Record<string, unknown> = {}) => ({ enabled: Boolean(section.enabled), mention_targets: Array.isArray(section.mentionTargets) ? section.mentionTargets : [], message_template: typeof section.messageTemplate === "string" ? section.messageTemplate.trim() || null : null })
export function rulePayload(data: RuleEditorModel) {
  const group = data.groupBroadcast ?? {}
  const situation = (group.situation ?? group) as Record<string, unknown>
  const timeout = (group.timeout ?? {}) as Record<string, unknown>
  return {
    name: data.name, description: data.description ?? "", dataset_id: data.datasetId, severity: data.severity || "medium", logic: data.logic || "AND",
    conditions: data.conditions.map((condition) => ({ field: condition.field, operator: condition.operator, value: condition.value === "" ? null : condition.value ?? null, upper_value: condition.upper_value ?? null, baseline: condition.baseline ?? null, value_source: condition.value_source ?? "literal", value_field: condition.value_field ?? null, upper_value_source: condition.upper_value_source ?? "literal", upper_value_field: condition.upper_value_field ?? null })),
    anomaly_key_fields: data.anomalyKeyFields ?? [], repeat_push_enabled: Boolean(data.repeatPushEnabled),
    schedule: { frequency: data.schedule.frequency, interval: Number(data.schedule.interval || 1), time: data.schedule.time || null, start_date: data.schedule.start || new Date().toISOString().slice(0, 10), end_date: data.schedule.end || null },
    notification_targets: data.notificationTargets ?? [], private_message_template: data.privateMessageTemplate?.trim() || null,
    validation_enabled: Boolean(data.validationEnabled), validation_targets: data.validationTargets ?? [], deadline_seconds: Number(data.deadlineSeconds ?? (data.validationTimeoutMinutes ?? 1440) * 60), validation_method: data.validationMethod ?? "pseudo", sql_validation_config: data.validationMethod === "sql" && data.sqlValidationConfig ? { datasource_id: data.sqlValidationConfig.datasourceId, query_template: data.sqlValidationConfig.queryTemplate, parameters: data.sqlValidationConfig.parameters, true_condition: { field: data.sqlValidationConfig.trueCondition.field, operator: data.sqlValidationConfig.trueCondition.operator, value: data.sqlValidationConfig.trueCondition.value ?? null, upper_value: data.sqlValidationConfig.trueCondition.upperValue ?? null, value_source: data.sqlValidationConfig.trueCondition.valueSource, value_field: data.sqlValidationConfig.trueCondition.valueField ?? null, upper_value_source: data.sqlValidationConfig.trueCondition.upperValueSource, upper_value_field: data.sqlValidationConfig.trueCondition.upperValueField ?? null } } : null,
    group_broadcast: { situation: broadcastSection(situation), timeout: broadcastSection(timeout), webhook_url: typeof group.webhookUrl === "string" ? group.webhookUrl : null }, enabled: Boolean(data.enabled),
  }
}

export function createResources(client: ApiClient) {
  return {
    auth: {
      me: (signal?: AbortSignal) => client.request<User>("/auth/me", { signal }),
      login: (login_name: string, password: string) => client.request<User>("/auth/login", { method: "POST", body: { username: login_name, password } }),
      logout: () => client.request<void>("/auth/logout", { method: "POST" }),
    },
    overview: async (days = 30, signal?: AbortSignal) => mapOverview(await client.request<Record<string, unknown>>(`/overview?days=${days}`, { signal })),
    datasources: {
      list: (signal?: AbortSignal) => client.request<Datasource[]>("/datasources", { signal }),
      create: (data: DatasourceInput) => client.request<Datasource>("/datasources", { method: "POST", body: datasourcePayload(data) }),
      update: (id: string, data: DatasourceInput) => client.request<Datasource>(`/datasources/${id}`, { method: "PATCH", body: datasourceUpdatePayload(data) }),
      remove: (id: string) => client.request<void>(`/datasources/${id}`, { method: "DELETE" }),
      test: (id: string) => client.request<Record<string, unknown>>(`/datasources/${id}/test`, { method: "POST" }),
      testConfig: (data: DatasourceInput & { id?: string }) => client.request<Record<string, unknown>>("/datasources/test", { method: "POST", body: clean({ ...datasourcePayload(data), datasource_id: data.id || undefined, password: data.password || undefined }) }),
    },
    datasets: {
      list: (signal?: AbortSignal) => client.request<Dataset[]>("/datasets", { signal }),
      create: (data: DatasetInput) => client.request<Dataset>("/datasets", { method: "POST", body: datasetPayload(data) }),
      update: (id: string, data: DatasetInput) => client.request<Dataset>(`/datasets/${id}`, { method: "PATCH", body: datasetPayload(data) }),
      remove: (id: string) => client.request<void>(`/datasets/${id}`, { method: "DELETE" }),
      execute: (id: string) => client.request<DatasetExecution>(`/datasets/${id}/execute`, { method: "POST" }),
      preview: (datasource_id: string, sql: string) => client.request<DatasetExecution>("/datasets/execute", { method: "POST", body: { datasource_id, sql } }),
      validate: (sql: string) => client.request<Record<string, unknown>>("/datasets/validate", { method: "POST", body: { sql } }),
    },
    rules: {
      list: (signal?: AbortSignal) => client.request<Rule[]>("/rules", { signal }),
      create: (data: RuleEditorModel) => client.request<Rule>("/rules", { method: "POST", body: rulePayload(data) }),
      update: (id: string, data: RuleEditorModel) => client.request<Rule>(`/rules/${id}`, { method: "PUT", body: rulePayload(data) }),
      remove: (id: string) => client.request<void>(`/rules/${id}`, { method: "DELETE" }),
      execute: (id: string) => client.request<Record<string, unknown>>(`/rules/${id}/execute`, { method: "POST" }),
      enable: (id: string, enabled: boolean) => client.request<Rule>(`/rules/${id}/${enabled ? "enable" : "disable"}`, { method: "POST" }),
      sync: (id: string) => client.request<Rule>(`/rules/${id}/sync`, { method: "POST" }),
    },
    records: {
      list: async (filters: RecordFilters = {}, signal?: AbortSignal) => { const payload = await client.request<Paginated<Record<string, unknown>>>(`/anomalies${recordQuery(filters) ? `?${recordQuery(filters)}` : ""}`, { signal }); return { ...payload, items: payload.items.map(mapRecord) } },
      detail: async (id: string, signal?: AbortSignal) => mapRecordDetail(await client.request<Record<string, unknown>>(`/anomalies/${id}`, { signal })),
      pendingCount: async (signal?: AbortSignal) => (await client.request<Paginated<Record<string, unknown>>>("/anomalies?page=1&page_size=1&status_filter=pending", { signal })).total,
      count: async (filters: RecordFilters = {}, signal?: AbortSignal) => (await client.request<Paginated<Record<string, unknown>>>(`/anomalies?${recordQuery({ ...filters, page: 1, pageSize: 1 })}`, { signal })).total,
      status: (id: string, status: string, assignee?: string) => client.request<AnomalyRecord>(`/anomalies/${id}/status`, { method: "PATCH", body: { status, assignee } }),
      bulkStatus: (ids: string[], status: string) => client.request<Record<string, unknown>>("/anomalies/bulk-status", { method: "POST", body: { ids, status } }),
      export: (filters: RecordFilters = {}) => client.request<Blob>(`/anomalies/export${recordQuery(filters) ? `?${recordQuery(filters)}` : ""}`, { responseType: "blob" }),
    },
    groups: {
      list: async (filters: { page?: number; pageSize?: number; search?: string; ruleId?: string } = {}, signal?: AbortSignal) => { const q = new URLSearchParams(); const values = { page: filters.page, page_size: filters.pageSize, search: filters.search, rule_id: filters.ruleId }; Object.entries(values).forEach(([key, value]) => { if (value !== undefined && value !== "") q.set(key, String(value)) }); const payload = await client.request<Paginated<Record<string, unknown>>>(`/anomaly-groups${q.size ? `?${q}` : ""}`, { signal }); return { ...payload, items: payload.items.map(mapAnomalyGroup) } },
      detail: async (id: string, filters: { page?: number; pageSize?: number } = {}, signal?: AbortSignal): Promise<AnomalyGroupDetail> => { const q = new URLSearchParams(); if (filters.page) q.set("page", String(filters.page)); if (filters.pageSize) q.set("page_size", String(filters.pageSize)); const payload = await client.request<{ group: Record<string, unknown>; items: Array<Record<string, unknown>>; deliveries?: Array<Record<string, unknown>>; total?: number; page?: number; page_size?: number }>(`/anomaly-groups/${id}${q.size ? `?${q}` : ""}`, { signal }); return { ...mapAnomalyGroup(payload.group), records: payload.items.map(mapRecord), deliveries: (payload.deliveries ?? []).map(mapBroadcastDelivery), total: payload.total, page: payload.page, page_size: payload.page_size } },
    },
    accounts: {
      list: (signal?: AbortSignal) => client.request<User[]>("/accounts", { signal }),
      create: (body: Record<string, unknown>) => client.request<User>("/accounts", { method: "POST", body }),
      update: (id: string, body: Record<string, unknown>) => client.request<User>(`/accounts/${id}`, { method: "PATCH", body }),
      password: (id: string, password: string) => client.request<void>(`/accounts/${id}/password`, { method: "POST", body: { password } }),
      remove: (id: string) => client.request<void>(`/accounts/${id}`, { method: "DELETE" }),
    },
    account: {
      profile: (body: Record<string, unknown>) => client.request<User>("/account/profile", { method: "PATCH", body }),
      credentials: (body: Record<string, unknown>) => client.request<User>("/account/credentials", { method: "PATCH", body }),
    },
    tests: { feishu: (receive_id_type: string, receive_id: string) => client.request<Record<string, unknown>>("/tests/feishu-message", { method: "POST", body: { receive_id_type, receive_id } }) },
    pushes: {
      abort: () => client.request<Record<string, unknown>>("/anomaly-pushes/abort", { method: "POST" }),
      clear: () => client.request<Record<string, unknown>>("/anomaly-pushes/clear-in-transit", { method: "POST" }),
      recover: () => client.request<Record<string, unknown>>("/anomaly-pushes/recover", { method: "POST" }),
    },
  }
}

export type Resources = ReturnType<typeof createResources>
