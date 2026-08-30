export type Id = string
export type Severity = "low" | "medium" | "high" | "critical" | string
export type RecordStatus = "pending" | "processing" | "resolved" | "ignored" | "timed_out" | string
export type BusinessKey = string | number | boolean | null | Record<string, unknown>

export interface User { id: Id; login_name: string; display_name: string; job_title?: string; is_superuser: boolean; is_active?: boolean }
export interface Paginated<T> { items: T[]; total: number; page: number; page_size: number; pages?: number }
export interface Datasource { id: Id; name: string; type: string; host: string; port: number; database: string; username: string; ssl: boolean; description?: string; status?: string; last_checked?: string; error_msg?: string; has_password?: boolean }
export interface Dataset { id: Id; name: string; datasource_id: Id; datasource_name?: string; description?: string; sql: string; fields?: string[]; row_count?: number; created_at?: string; updated_at?: string }
export interface RuleCondition { field: string; operator: string; value?: unknown; upper_value?: unknown; baseline?: string | null; value_source?: string; value_field?: string | null; upper_value_source?: string; upper_value_field?: string | null }
export interface Rule { id: Id; name: string; description?: string; dataset_id: Id; dataset_name?: string; severity: Severity; logic: "AND" | "OR" | string; conditions: RuleCondition[]; enabled: boolean; schedule?: Record<string, unknown>; notification_targets?: Array<Record<string, unknown>>; validation_enabled?: boolean; deadline_seconds?: number; created_at?: string; updated_at?: string; [key: string]: unknown }
export interface BroadcastDelivery { id: Id; kind: string; status: string; attempts: number; error?: string; sent_at?: string; created_at?: string; [key: string]: unknown }
export interface AnomalyRecord { id: Id; title?: string; anomaly_key?: string; business_key?: BusinessKey; business_key_summary?: string; rule_id?: Id; rule_name?: string; severity: Severity; status: RecordStatus; assignee?: string; detected_at?: string; created_at?: string; push_status?: string; data?: Record<string, unknown>; matched_conditions?: unknown[]; timeline?: unknown[]; deliveries?: BroadcastDelivery[]; [key: string]: unknown }
export interface AnomalyRecordDetail extends AnomalyRecord { validation_requests: Array<Record<string, unknown>>; delivery_diagnostics: BroadcastDelivery[]; }
export interface AnomalyGroup { id: Id; rule_id?: Id; rule_name?: string; anomaly_key?: string; status?: string; severity?: Severity; record_count?: number; scanned_rows?: number; matched_rows?: number; new_anomalies?: number; pending_count?: number; processing_count?: number; resolved_count?: number; timed_out_count?: number; situation_broadcast_status?: string; timeout_broadcast_status?: string; first_detected_at?: string; last_detected_at?: string; records?: AnomalyRecord[]; [key: string]: unknown }
export interface AnomalyGroupDetail extends AnomalyGroup { records: AnomalyRecord[]; deliveries: BroadcastDelivery[]; total?: number; page?: number; page_size?: number }
export interface Overview { stats?: Record<string, number>; trends?: Array<Record<string, unknown>>; severity_distribution?: Array<Record<string, unknown>>; recent_anomalies?: AnomalyRecord[]; top_rules?: Array<Record<string, unknown>>; [key: string]: unknown }
export interface DatasetExecution { columns?: string[]; rows?: Array<Record<string, unknown> | unknown[]>; row_count?: number; duration_ms?: number; [key: string]: unknown }

export interface DatasourceInput { name: string; type: string; host: string; port: number | string; database: string; username: string; password?: string; ssl?: boolean; description?: string }
export interface DatasetInput { name: string; datasourceId: Id; description?: string; sql: string }
export interface BroadcastSection { enabled?: boolean; mentionTargets?: Array<Record<string, unknown>>; messageTemplate?: string }
export interface GroupBroadcast { situation?: BroadcastSection; timeout?: BroadcastSection; webhookUrl?: string }
export interface RuleEditorModel { name: string; description?: string; datasetId: Id; severity: Severity; logic: "AND" | "OR"; conditions: Array<Partial<RuleCondition> & { field: string; operator: string }>; enabled: boolean; anomalyKeyFields?: string[]; repeatPushEnabled?: boolean; schedule: { frequency: string; interval: number; time?: string; start?: string; end?: string }; notificationTargets?: Array<Record<string, unknown>>; privateMessageTemplate?: string; validationEnabled?: boolean; validationTargets?: string[]; deadlineSeconds?: number; validationTimeoutMinutes?: number; validationMethod?: string; sqlValidationConfig?: Record<string, unknown>; groupBroadcast?: GroupBroadcast }
export interface RecordFilters { page?: number; pageSize?: number; status?: string; pushStatus?: string; severity?: string; ruleId?: string; search?: string; sortKey?: string; sortOrder?: string; ids?: string[] }
