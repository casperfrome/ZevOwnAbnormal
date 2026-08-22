/* API-backed state store. Keeps the existing synchronous read API for views. */
window.Store = (function () {
  const state = { datasources: [], datasets: [], rules: [], records: [], overview: null, currentUser: null };
  let recordsPageSequence = 0;

  async function request(path, options = {}) {
    const response = await fetch('/api/v1' + path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      let payload = null;
      try { payload = await response.json(); detail = payload.detail || detail; } catch (_) {}
      const error = new Error(detail);
      error.payload = payload;
      throw error;
    }
    if (response.status === 204) return null;
    return response.json();
  }

  const mapDatasource = d => ({
    id: d.id, name: d.name, type: d.type, host: d.host, port: d.port, database: d.database,
    username: d.username, password: '', ssl: d.ssl, description: d.description || '', status: d.status,
    lastChecked: d.last_checked, createdAt: d.created_at, updatedAt: d.updated_at,
    errorMsg: d.error_message, hasPassword: d.has_password,
  });
  const mapDataset = d => ({
    id: d.id, name: d.name, description: d.description || '', datasourceId: d.datasource_id,
    datasourceName: d.datasource_name, sql: d.sql, fields: d.fields || [], rowCount: d.row_count || 0,
    createdAt: d.created_at, updatedAt: d.updated_at,
  });
  const targetsToNotify = targets => {
    const literal = targets.filter(t => t.source === 'literal');
    const field = targets.find(t => t.source === 'field');
    return {
      mode: field ? 'field' : 'manual',
      openIds: literal.filter(t => t.receive_id_type === 'open_id').map(t => t.value),
      userIds: literal.filter(t => t.receive_id_type === 'user_id').map(t => t.value),
      fieldSource: field?.field || null,
      fieldIdType: field?.receive_id_type || 'open_id',
      targets,
    };
  };
  const mapSqlValidationConfig = config => config ? ({
    queryTemplate: config.query_template || '',
    parameters: (config.parameters || []).map(item => ({ name: item.name, field: item.field })),
    trueCondition: {
      field: config.true_condition?.field || '',
      operator: config.true_condition?.operator || 'eq',
      value: config.true_condition?.value ?? null,
      upperValue: config.true_condition?.upper_value ?? null,
    },
  }) : null;
  const mapRule = r => ({
    id: r.id, name: r.name, description: r.description || '', datasetId: r.dataset_id,
    datasetName: r.dataset_name, severity: r.severity, logic: r.logic,
    conditions: (r.conditions || []).map(({ operator, ...condition }) => ({ ...condition, op: operator })),
    anomalyKeyFields: r.anomaly_key_fields || [], schedule: {
      frequency: r.schedule.frequency, interval: r.schedule.interval, time: r.schedule.time,
      start: r.schedule.start_date, end: r.schedule.end_date,
    },
    notify: targetsToNotify(r.notification_targets || []), notificationTargets: r.notification_targets || [],
    validationEnabled: !!r.validation_enabled,
    validationTargets: r.validation_targets || [],
    validationTimeoutMinutes: r.validation_timeout_minutes ?? 1440,
    validationMethod: r.validation_method || 'pseudo',
    sqlValidationConfig: mapSqlValidationConfig(r.sql_validation_config),
    enabled: r.enabled, syncStatus: r.sync_status, syncError: r.sync_error,
    lastRun: r.last_run || null, nextRun: r.next_run || null, anomalyCount: r.anomaly_count || 0,
    createdAt: r.created_at,
  });
  const mapValidationRequest = item => ({
    recipientUserId: item.recipient_user_id,
    deliveryStatus: item.delivery_status,
    deliveryAttempts: item.delivery_attempts || 0,
    messageId: item.message_id,
    lastError: item.last_error,
    deliveredAt: item.delivered_at,
  });
  const mapValidationSubmission = item => item ? ({
    submittedByUserId: item.submitted_by_user_id,
    submittedText: item.submitted_text,
    validatorType: item.validator_type,
    result: item.result,
    resultDetail: item.result_detail ? {
      field: item.result_detail.field,
      operator: item.result_detail.operator,
      value: item.result_detail.value ?? null,
      upperValue: item.result_detail.upper_value ?? null,
      actual: item.result_detail.actual ?? null,
    } : null,
    submittedAt: item.submitted_at,
  }) : null;
  const mapRecord = r => {
    const first = (r.matched_conditions || [])[0] || {};
    return {
      id: r.id, ruleId: r.rule_id, ruleName: r.rule_name, datasetName: r.dataset_name,
      severity: r.severity, status: r.status, occurredAt: r.first_seen_at, firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at, field: first.field || '—', value: first.actual ?? '—',
      expected: first.operator || '', details: r.row_details || {}, businessKey: r.business_key || {},
      matchedConditions: r.matched_conditions || [], hitCount: r.hit_count || 1,
      deliveryStatus: r.delivery_status, assignee: r.assignee,
      description: r.description || '', validationDeadline: r.validation_deadline || null,
      timedOutAt: r.timed_out_at || null, resolvedAt: r.resolved_at || null,
      resolutionSource: r.resolution_source || null, resolvedByUserId: r.resolved_by_user_id || null,
      validationMethod: r.validation_method || null,
      timeline: (r.timeline || []).map(e => ({ time: e.created_at, type: e.type, title: e.description, desc: '' })),
      deliveries: r.deliveries || [],
      validationRequests: (r.validation_requests || []).map(mapValidationRequest),
      validationSubmission: mapValidationSubmission(r.validation_submission),
    };
  };

  function anomalyQuery(filters = {}, includePagination = false) {
    const entries = [
      ...(includePagination ? [
        ['page', filters.page || 1],
        ['page_size', filters.pageSize || 10],
      ] : []),
      ['status_filter', filters.status],
      ['push_status', filters.pushStatus],
      ['severity', filters.severity],
      ['rule_id', filters.ruleId],
      ['search', filters.search],
      ['sort_key', filters.sortKey],
      ['sort_order', filters.sortOrder],
    ].filter(([, value]) => value !== null && value !== undefined && value !== '');
    return entries.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  }

  async function fetchRecordsPage(filters = {}) {
    const query = anomalyQuery(filters, true);
    const result = await request(`/anomalies?${query}`);
    const items = (result.items || []).map(mapRecord);
    return {
      items,
      total: result.total || 0,
      page: result.page || filters.page || 1,
      pageSize: result.page_size || filters.pageSize || 10,
    };
  }

  async function loadRecordsPage(filters = {}) {
    const requestSequence = ++recordsPageSequence;
    const result = await fetchRecordsPage(filters);
    if (requestSequence === recordsPageSequence) state.records = result.items;
    return result;
  }

  function peekRecordsPage(filters = {}) {
    return fetchRecordsPage(filters);
  }

  async function refresh() {
    const [datasources, datasets, rules, , overview] = await Promise.all([
      request('/datasources'), request('/datasets'), request('/rules'), loadRecordsPage({ page: 1, pageSize: 10 }), request('/overview'),
    ]);
    state.datasources = datasources.map(mapDatasource);
    state.datasets = datasets.map(mapDataset);
    state.rules = rules.map(mapRule);
    state.overview = overview;
  }

  async function refreshOverview() {
    state.overview = await request('/overview');
    return state.overview;
  }

  function applyOverviewRecordTransition(previous, next) {
    const stats = state.overview?.stats;
    if (!stats || !previous || previous.status === next.status) return;
    const countKeys = {
      pending: 'pending_records', processing: 'processing_records',
      timed_out: 'timed_out_records', resolved: 'resolved_records',
    };
    const previousKey = countKeys[previous.status];
    const nextKey = countKeys[next.status];
    if (previousKey && Number.isFinite(stats[previousKey])) stats[previousKey] = Math.max(0, stats[previousKey] - 1);
    if (nextKey && Number.isFinite(stats[nextKey])) stats[nextKey] += 1;
    const wasUnresolved = previous.status !== 'resolved';
    const isUnresolved = next.status !== 'resolved';
    if (next.severity === 'critical' && wasUnresolved !== isUnresolved && Number.isFinite(stats.critical_anomalies)) {
      stats.critical_anomalies = Math.max(0, stats.critical_anomalies + (isUnresolved ? 1 : -1));
    }
  }

  async function init() {
    state.currentUser = await request('/auth/me');
    await refresh();
  }

  function dsPayload(data) {
    return { name: data.name, type: data.type, host: data.host, port: Number(data.port), database: data.database,
      username: data.username, password: data.password || '', ssl: !!data.ssl, description: data.description || '' };
  }
  function datasetPayload(data) {
    return { name: data.name, datasource_id: data.datasourceId, description: data.description || '', sql: data.sql };
  }
  function rulePayload(data) {
    let targets = data.notificationTargets || data.notify?.targets || [];
    if (!targets.length && data.notify) {
      targets = [
        ...(data.notify.openIds || []).map(value => ({ receive_id_type: 'open_id', source: 'literal', value })),
        ...(data.notify.userIds || []).map(value => ({ receive_id_type: 'user_id', source: 'literal', value })),
      ];
      if (data.notify.fieldSource) targets.push({ receive_id_type: data.notify.fieldIdType || 'open_id', source: 'field', field: data.notify.fieldSource });
    }
    return {
      name: data.name, description: data.description || '', dataset_id: data.datasetId,
      severity: data.severity || 'medium', logic: data.logic || 'AND',
      conditions: (data.conditions || []).map(c => ({ field: c.field, operator: c.op || c.operator, value: c.value === '' ? null : c.value,
        upper_value: c.upper_value ?? c.upperValue ?? null, baseline: c.baseline || null })),
      anomaly_key_fields: data.anomalyKeyFields || [],
      schedule: { frequency: data.schedule.frequency, interval: Number(data.schedule.interval || 1), time: data.schedule.time || null,
        start_date: data.schedule.start || new Date().toISOString().slice(0, 10), end_date: data.schedule.end || null },
      notification_targets: targets, enabled: !!data.enabled,
      validation_enabled: !!data.validationEnabled,
      validation_targets: data.validationTargets || [],
      validation_timeout_minutes: Number(data.validationTimeoutMinutes ?? 1440),
      validation_method: data.validationMethod || 'pseudo',
      sql_validation_config: data.validationMethod === 'sql' && data.sqlValidationConfig ? {
        query_template: data.sqlValidationConfig.queryTemplate,
        parameters: (data.sqlValidationConfig.parameters || []).map(item => ({ name: item.name, field: item.field })),
        true_condition: {
          field: data.sqlValidationConfig.trueCondition.field,
          operator: data.sqlValidationConfig.trueCondition.operator,
          value: data.sqlValidationConfig.trueCondition.value ?? null,
          upper_value: data.sqlValidationConfig.trueCondition.upperValue ?? null,
        },
      } : null,
    };
  }

  return {
    init, refresh, request, loadRecordsPage, peekRecordsPage,
    isSuperuser: () => state.currentUser?.is_superuser === true,
    getDatasources: () => [...state.datasources],
    getDatasource: id => state.datasources.find(item => item.id === id),
    addDatasource: async data => { const item = mapDatasource(await request('/datasources', { method: 'POST', body: JSON.stringify(dsPayload(data)) })); state.datasources.unshift(item); return item; },
    updateDatasource: async (id, data) => { const payload = dsPayload({ ...state.datasources.find(x => x.id === id), ...data }); delete payload.type; if (!data.password) delete payload.password; const item = mapDatasource(await request(`/datasources/${id}`, { method: 'PATCH', body: JSON.stringify(payload) })); state.datasources[state.datasources.findIndex(x => x.id === id)] = item; return item; },
    deleteDatasource: async id => { await request(`/datasources/${id}`, { method: 'DELETE' }); state.datasources = state.datasources.filter(x => x.id !== id); },
    testDatasource: async id => { const result = await request(`/datasources/${id}/test`, { method: 'POST' }); await refresh(); return result; },
    testDatasourceConfig: data => request('/datasources/test', { method: 'POST', body: JSON.stringify(dsPayload(data)) }),
    sendFeishuTestMessage: (receiveIdType, receiveId) => request('/tests/feishu-message', {
      method: 'POST',
      body: JSON.stringify({ receive_id_type: receiveIdType, receive_id: receiveId }),
    }),
    abortAnomalyPushes: () => request('/anomaly-pushes/abort', { method: 'POST' }),

    getDatasets: () => [...state.datasets],
    getDataset: id => state.datasets.find(item => item.id === id),
    addDataset: async data => { const item = mapDataset(await request('/datasets', { method: 'POST', body: JSON.stringify(datasetPayload(data)) })); state.datasets.unshift(item); return item; },
    updateDataset: async (id, data) => { const item = mapDataset(await request(`/datasets/${id}`, { method: 'PATCH', body: JSON.stringify(datasetPayload(data)) })); state.datasets[state.datasets.findIndex(x => x.id === id)] = item; return item; },
    deleteDataset: async id => { await request(`/datasets/${id}`, { method: 'DELETE' }); state.datasets = state.datasets.filter(x => x.id !== id); },
    executeDataset: async id => { const result = await request(`/datasets/${id}/execute`, { method: 'POST' }); await refresh(); return result; },
    executeDatasetSql: (datasourceId, sql) => request('/datasets/execute', { method: 'POST', body: JSON.stringify({ datasource_id: datasourceId, sql }) }),

    getRules: () => [...state.rules],
    getRule: id => state.rules.find(item => item.id === id),
    addRule: async data => { const item = mapRule(await request('/rules', { method: 'POST', body: JSON.stringify(rulePayload(data)) })); state.rules.unshift(item); return item; },
    updateRule: async (id, data) => { const current = state.rules.find(x => x.id === id); const item = mapRule(await request(`/rules/${id}`, { method: 'PUT', body: JSON.stringify(rulePayload({ ...current, ...data })) })); state.rules[state.rules.findIndex(x => x.id === id)] = item; return item; },
    deleteRule: async id => { await request(`/rules/${id}`, { method: 'DELETE' }); state.rules = state.rules.filter(x => x.id !== id); },
    executeRule: async id => { const result = await request(`/rules/${id}/execute`, { method: 'POST' }); await refresh(); return result; },
    enableRule: async (id, enabled) => { const item = mapRule(await request(`/rules/${id}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' })); state.rules[state.rules.findIndex(x => x.id === id)] = item; return item; },
    syncRule: async id => { const item = mapRule(await request(`/rules/${id}/sync`, { method: 'POST' })); state.rules[state.rules.findIndex(x => x.id === id)] = item; return item; },

    getRecords: () => [...state.records],
    getRecord: id => state.records.find(item => item.id === id),
    loadRecord: async id => mapRecord(await request(`/anomalies/${id}`)),
    updateRecord: async (id, data) => {
      const item = mapRecord(await request(`/anomalies/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: data.status, assignee: data.assignee }) }));
      const index = state.records.findIndex(x => x.id === id);
      const previous = index >= 0 ? state.records[index] : null;
      if (index >= 0) state.records[index] = item;
      applyOverviewRecordTransition(previous, item);
      try { await refreshOverview(); } catch (_) {}
      return item;
    },
    bulkUpdateRecords: async (ids, status) => { await request('/anomalies/bulk-status', { method: 'POST', body: JSON.stringify({ ids, status }) }); await refresh(); },
    exportUrl: filters => {
      const query = anomalyQuery(filters);
      return `/api/v1/anomalies/export${query ? `?${query}` : ''}`;
    },
    getOverview: () => state.overview,
    getStats: () => {
      const server = state.overview?.stats || {};
      const pendingRecords = server.pending_records ?? state.records.filter(r => r.status === 'pending').length;
      const processingRecords = server.processing_records ?? state.records.filter(r => r.status === 'processing').length;
      const timedOutRecords = server.timed_out_records ?? state.records.filter(r => r.status === 'timed_out').length;
      return {
        pendingRecords,
        processingRecords,
        timedOutRecords,
        unresolvedRecords: pendingRecords + processingRecords + timedOutRecords,
        activeRules: server.active_rules ?? state.rules.filter(r => r.enabled).length,
        totalRules: server.total_rules ?? state.rules.length,
        onlineDatasources: server.online_datasources ?? state.datasources.filter(d => d.status === 'online').length,
        totalDatasources: server.total_datasources ?? state.datasources.length,
        totalDatasets: server.total_datasets ?? state.datasets.length,
        pushInTransitAnomalies: server.push_in_transit_anomalies ?? 0,
        criticalAnomalies: server.critical_anomalies ?? state.records.filter(r => r.severity === 'critical' && r.status !== 'resolved').length,
        resolvedToday: server.resolved_records ?? state.records.filter(r => r.status === 'resolved').length,
      };
    },
  };
})();
