/* API-backed state store. Keeps the existing synchronous read API for views. */
window.Store = (function () {
  const state = { datasources: [], datasets: [], rules: [], records: [], overview: null, currentUser: null };
  let recordsPageSequence = 0;
  let unauthorizedHandler = null;
  let authGeneration = 0;
  let unauthorizedGeneration = null;
  const refreshSequences = { datasources: 0, datasets: 0, rules: 0, overview: 0 };

  async function request(path, options = {}) {
    const { responseType, ...fetchOptions } = options;
    const requestGeneration = authGeneration;
    let response;
    try {
      response = await fetch('/api/v1' + path, {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...fetchOptions,
      });
    } catch (error) {
      if (!Number.isFinite(error.status)) error.status = 0;
      throw error;
    }
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      let payload = null;
      try { payload = await response.json(); detail = payload.detail || detail; } catch (_) {}
      const error = new Error(detail);
      error.status = response.status;
      error.payload = payload;
      if (response.status === 401 && path !== '/auth/login'
        && requestGeneration === authGeneration && unauthorizedGeneration !== requestGeneration) {
        unauthorizedGeneration = requestGeneration;
        unauthorizedHandler?.(error);
      }
      throw error;
    }
    if (response.status === 204) return null;
    if (responseType === 'blob') return response.blob();
    try {
      return await response.json();
    } catch (error) {
      error.status = response.status;
      throw error;
    }
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
    datasourceId: config.datasource_id,
    queryTemplate: config.query_template || '',
    parameters: (config.parameters || []).map(item => ({ name: item.name, field: item.field })),
    trueCondition: {
      field: config.true_condition?.field || '',
      operator: config.true_condition?.operator || 'eq',
      value: config.true_condition?.value ?? null,
      upperValue: config.true_condition?.upper_value ?? null,
      valueSource: config.true_condition?.value_source || 'literal',
      valueField: config.true_condition?.value_field || null,
      upperValueSource: config.true_condition?.upper_value_source || 'literal',
      upperValueField: config.true_condition?.upper_value_field || null,
    },
  }) : null;
  const mapBroadcastSection = section => ({
    enabled: !!section?.enabled,
    mentionTargets: section?.mention_targets || [],
    messageTemplate: section?.message_template || '',
  });
  const mapRule = r => ({
    id: r.id, name: r.name, description: r.description || '', datasetId: r.dataset_id,
    datasetName: r.dataset_name, severity: r.severity, logic: r.logic,
    conditions: (r.conditions || []).map(({ operator, ...condition }) => ({ ...condition, op: operator })),
    repeatPushEnabled: !!r.repeat_push_enabled,
    anomalyKeyFields: r.anomaly_key_fields || [], schedule: {
      frequency: r.schedule.frequency, interval: r.schedule.interval, time: r.schedule.time,
      start: r.schedule.start_date, end: r.schedule.end_date,
    },
    notify: targetsToNotify(r.notification_targets || []), notificationTargets: r.notification_targets || [],
    privateMessageTemplate: r.private_message_template || '',
    validationEnabled: !!r.validation_enabled,
    validationTargets: r.validation_targets || [],
    deadlineSeconds: r.deadline_seconds ?? (r.validation_timeout_minutes ?? 1440) * 60,
    validationMethod: r.validation_method || 'pseudo',
    sqlValidationConfig: mapSqlValidationConfig(r.sql_validation_config),
    groupBroadcast: {
      webhookUrl: r.group_broadcast?.webhook_url || '',
      situation: mapBroadcastSection(r.group_broadcast?.situation || r.group_broadcast),
      timeout: mapBroadcastSection(r.group_broadcast?.timeout),
    },
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
  const mapResultDetail = detail => detail ? ({
    field: detail.field, operator: detail.operator,
    value: detail.value ?? null, upperValue: detail.upper_value ?? null, actual: detail.actual ?? null,
    valueSource: detail.value_source || 'literal', valueField: detail.value_field || null,
    upperValueSource: detail.upper_value_source || 'literal', upperValueField: detail.upper_value_field || null,
    resolvedValue: detail.resolved_value ?? null, resolvedUpperValue: detail.resolved_upper_value ?? null,
  }) : null;
  const mapValidationSubmission = item => item ? ({
    submittedByUserId: item.submitted_by_user_id,
    submittedText: item.submitted_text,
    validatorType: item.validator_type,
    result: item.result,
    resultDetail: mapResultDetail(item.result_detail),
    submittedAt: item.submitted_at,
  }) : null;
  const mapPushJob = item => ({
    id: item.id,
    kind: item.kind,
    status: item.status,
    publishAttempts: item.publish_attempts || 0,
    dispatchAttempts: item.dispatch_attempts || 0,
    nextAttemptAt: item.next_attempt_at || null,
    lastError: item.last_error || null,
    updatedAt: item.updated_at || null,
  });
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
      deadlineSecondsSnapshot: r.deadline_seconds_snapshot ?? null, firstDeliveredAt: r.first_delivered_at || null,
      timedOutAt: r.timed_out_at || null, resolvedAt: r.resolved_at || null,
      resolutionSource: r.resolution_source || null, resolvedByUserId: r.resolved_by_user_id || null,
      validationMethod: r.validation_method || null,
      timeline: (r.timeline || []).map(e => ({ time: e.created_at, type: e.type, title: e.description, desc: '' })),
      deliveries: r.deliveries || [],
      validationRequests: (r.validation_requests || []).map(mapValidationRequest),
      validationSubmission: mapValidationSubmission(r.validation_submission),
      lastSqlValidationResult: r.last_sql_validation_result ? {
        outcome: r.last_sql_validation_result.outcome,
        reason: r.last_sql_validation_result.reason,
        condition: r.last_sql_validation_result.condition,
        resultDetail: mapResultDetail(r.last_sql_validation_result.result_detail),
        operatorUserId: r.last_sql_validation_result.operator_user_id,
        checkedAt: r.last_sql_validation_result.checked_at,
      } : null,
      pushJobs: (r.push_jobs || []).map(mapPushJob),
    };
  };

  const mapAnomalyGroup = item => ({
    groupId: item.group_id,
    ruleId: item.rule_id,
    ruleName: item.rule_name,
    detectedAt: item.detected_at,
    scannedRows: item.scanned_rows || 0,
    matchedRows: item.matched_rows || 0,
    newAnomalies: item.new_anomalies || 0,
    statusCounts: item.status_counts || { pending: 0, processing: 0, timed_out: 0, resolved: 0 },
    broadcastStatus: item.broadcast_status || 'disabled',
    situationBroadcastStatus: item.situation_broadcast_status || item.broadcast_status || 'disabled',
    timeoutBroadcastStatus: item.timeout_broadcast_status || 'disabled',
    timeoutWaitingCount: item.timeout_waiting_count || 0,
    timeoutWaitingDeliveryCount: item.timeout_waiting_delivery_count || 0,
  });

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
      ...(filters.ids || []).map(id => ['ids', id]),
    ].filter(([, value]) => value !== null && value !== undefined && value !== '');
    return entries.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  }

  function anomalyGroupQuery(filters = {}) {
    return [
      ['page', filters.page || 1],
      ['page_size', filters.pageSize || 10],
      ['search', filters.search],
      ['rule_id', filters.ruleId],
    ].filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  }

  async function loadAnomalyGroupsPage(filters = {}) {
    const result = await request(`/anomaly-groups?${anomalyGroupQuery(filters)}`);
    return {
      items: (result.items || []).map(mapAnomalyGroup),
      total: result.total || 0,
      page: result.page || filters.page || 1,
      pageSize: result.page_size || filters.pageSize || 10,
    };
  }

  async function loadAnomalyGroup(groupId, filters = {}) {
    const query = anomalyGroupQuery(filters);
    const result = await request(`/anomaly-groups/${encodeURIComponent(groupId)}?${query}`);
    return {
      group: mapAnomalyGroup(result.group),
      items: (result.items || []).map(mapRecord),
      deliveries: result.deliveries || [],
      total: result.total || 0,
      page: result.page || filters.page || 1,
      pageSize: result.page_size || filters.pageSize || 20,
    };
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

  async function refreshResource(key, path, map = value => value) {
    const sequence = ++refreshSequences[key];
    const generation = authGeneration;
    const result = map(await request(path));
    if (sequence === refreshSequences[key] && generation === authGeneration) state[key] = result;
    return result;
  }

  function refreshOverview(days) {
    return refreshResource('overview', `/overview${days ? `?days=${days}` : ''}`);
  }

  async function refresh() {
    await Promise.all([
      refreshResource('datasources', '/datasources', rows => rows.map(mapDatasource)),
      refreshResource('datasets', '/datasets', rows => rows.map(mapDataset)),
      refreshResource('rules', '/rules', rows => rows.map(mapRule)),
      loadRecordsPage({ page: 1, pageSize: 10 }), refreshOverview(),
    ]);
  }

  async function withRefresh(result, refreshFn = refresh) {
    try { await refreshFn(); return result; }
    catch (error) { return { ...result, refreshWarning: error.message }; }
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
    if (next.severity === 'high' && wasUnresolved !== isUnresolved && Number.isFinite(stats.high_anomalies)) {
      stats.high_anomalies = Math.max(0, stats.high_anomalies + (isUnresolved ? 1 : -1));
    }
  }

  async function init() {
    state.currentUser = await request('/auth/me');
    await refresh();
  }

  async function login(username, password) {
    const user = await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    authGeneration += 1;
    unauthorizedGeneration = null;
    state.currentUser = user;
    return user;
  }

  function cacheItem(key, item) {
    refreshSequences[key] += 1;
    const index = state[key].findIndex(existing => existing.id === item.id);
    if (index >= 0) state[key][index] = item;
    else state[key].unshift(item);
    return item;
  }

  function removeCachedItem(key, id) {
    refreshSequences[key] += 1;
    state[key] = state[key].filter(item => item.id !== id);
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
    const groupBroadcast = data.groupBroadcast || {};
    const broadcastSectionPayload = section => ({
      enabled: !!section?.enabled,
      mention_targets: section?.mentionTargets || [],
      message_template: section?.messageTemplate?.trim() || null,
    });
    const groupBroadcastPayload = {
      situation: broadcastSectionPayload(groupBroadcast.situation || groupBroadcast),
      timeout: broadcastSectionPayload(groupBroadcast.timeout),
    };
    groupBroadcastPayload.webhook_url = groupBroadcast.webhookUrl || null;
    return {
      name: data.name, description: data.description || '', dataset_id: data.datasetId,
      severity: data.severity || 'medium', logic: data.logic || 'AND',
      conditions: (data.conditions || []).map(c => ({ field: c.field, operator: c.op || c.operator, value: c.value === '' ? null : c.value,
        upper_value: c.upper_value ?? c.upperValue ?? null, baseline: c.baseline || null,
        value_source: c.value_source || 'literal', value_field: c.value_field || null,
        upper_value_source: c.upper_value_source || 'literal', upper_value_field: c.upper_value_field || null })),
      anomaly_key_fields: data.anomalyKeyFields || [],
      repeat_push_enabled: !!data.repeatPushEnabled,
      schedule: { frequency: data.schedule.frequency, interval: Number(data.schedule.interval || 1), time: data.schedule.time || null,
        start_date: data.schedule.start || new Date().toISOString().slice(0, 10), end_date: data.schedule.end || null },
      notification_targets: targets, enabled: !!data.enabled,
      private_message_template: data.privateMessageTemplate?.trim() || null,
      validation_enabled: !!data.validationEnabled,
      validation_targets: data.validationTargets || [],
      deadline_seconds: Number(data.deadlineSeconds ?? (data.validationTimeoutMinutes ?? 1440) * 60),
      validation_method: data.validationMethod || 'pseudo',
      sql_validation_config: data.validationMethod === 'sql' && data.sqlValidationConfig ? {
        datasource_id: data.sqlValidationConfig.datasourceId,
        query_template: data.sqlValidationConfig.queryTemplate,
        parameters: (data.sqlValidationConfig.parameters || []).map(item => ({ name: item.name, field: item.field })),
        true_condition: {
          field: data.sqlValidationConfig.trueCondition.field,
          operator: data.sqlValidationConfig.trueCondition.operator,
          value: data.sqlValidationConfig.trueCondition.value ?? null,
          upper_value: data.sqlValidationConfig.trueCondition.upperValue ?? null,
          value_source: data.sqlValidationConfig.trueCondition.valueSource || 'literal',
          value_field: data.sqlValidationConfig.trueCondition.valueField || null,
          upper_value_source: data.sqlValidationConfig.trueCondition.upperValueSource || 'literal',
          upper_value_field: data.sqlValidationConfig.trueCondition.upperValueField || null,
        },
      } : null,
      group_broadcast: groupBroadcastPayload,
    };
  }

  return {
    init, login, refresh, refreshOverview, request, loadRecordsPage, peekRecordsPage,
    setUnauthorizedHandler: handler => { unauthorizedHandler = typeof handler === 'function' ? handler : null; },
    loadAnomalyGroupsPage, loadAnomalyGroup,
    isSuperuser: () => state.currentUser?.is_superuser === true,
    getDatasources: () => [...state.datasources],
    getDatasource: id => state.datasources.find(item => item.id === id),
    addDatasource: async data => { const item = mapDatasource(await request('/datasources', { method: 'POST', body: JSON.stringify(dsPayload(data)) })); return cacheItem('datasources', item); },
    updateDatasource: async (id, data) => { const payload = dsPayload({ ...state.datasources.find(x => x.id === id), ...data }); delete payload.type; if (!data.password) delete payload.password; const item = mapDatasource(await request(`/datasources/${id}`, { method: 'PATCH', body: JSON.stringify(payload) })); return cacheItem('datasources', item); },
    deleteDatasource: async id => { await request(`/datasources/${id}`, { method: 'DELETE' }); removeCachedItem('datasources', id); },
    testDatasource: async id => withRefresh(await request(`/datasources/${id}/test`, { method: 'POST' })),
    testDatasourceConfig: data => {
      const payload = dsPayload(data);
      if (data.id) { payload.datasource_id = data.id; if (!data.password) delete payload.password; }
      return request('/datasources/test', { method: 'POST', body: JSON.stringify(payload) });
    },
    sendFeishuTestMessage: (receiveIdType, receiveId) => request('/tests/feishu-message', {
      method: 'POST',
      body: JSON.stringify({ receive_id_type: receiveIdType, receive_id: receiveId }),
    }),
    abortAnomalyPushes: () => request('/anomaly-pushes/abort', { method: 'POST' }),
    clearInTransitPushes: () => request('/anomaly-pushes/clear-in-transit', { method: 'POST' }),
    recoverAnomalyPushes: () => request('/anomaly-pushes/recover', { method: 'POST' }),

    getDatasets: () => [...state.datasets],
    getDataset: id => state.datasets.find(item => item.id === id),
    addDataset: async data => { const item = mapDataset(await request('/datasets', { method: 'POST', body: JSON.stringify(datasetPayload(data)) })); return cacheItem('datasets', item); },
    updateDataset: async (id, data) => { const item = mapDataset(await request(`/datasets/${id}`, { method: 'PATCH', body: JSON.stringify(datasetPayload(data)) })); return cacheItem('datasets', item); },
    deleteDataset: async id => { await request(`/datasets/${id}`, { method: 'DELETE' }); removeCachedItem('datasets', id); },
    executeDataset: async id => withRefresh(await request(`/datasets/${id}/execute`, { method: 'POST' })),
    executeDatasetSql: (datasourceId, sql) => request('/datasets/execute', { method: 'POST', body: JSON.stringify({ datasource_id: datasourceId, sql }) }),
    validateDatasetSql: sql => request('/datasets/validate', { method: 'POST', body: JSON.stringify({ sql }) }),

    getRules: () => [...state.rules],
    getRule: id => state.rules.find(item => item.id === id),
    addRule: async data => { const item = mapRule(await request('/rules', { method: 'POST', body: JSON.stringify(rulePayload(data)) })); return cacheItem('rules', item); },
    updateRule: async (id, data) => { const current = state.rules.find(x => x.id === id); const item = mapRule(await request(`/rules/${id}`, { method: 'PUT', body: JSON.stringify(rulePayload({ ...current, ...data })) })); return cacheItem('rules', item); },
    deleteRule: async id => { await request(`/rules/${id}`, { method: 'DELETE' }); removeCachedItem('rules', id); },
    executeRule: async id => withRefresh(await request(`/rules/${id}/execute`, { method: 'POST' })),
    enableRule: async (id, enabled) => { const item = mapRule(await request(`/rules/${id}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' })); return cacheItem('rules', item); },
    syncRule: async id => { const item = mapRule(await request(`/rules/${id}/sync`, { method: 'POST' })); return cacheItem('rules', item); },

    getRecords: () => [...state.records],
    getRecord: id => state.records.find(item => item.id === id),
    loadRecord: async id => mapRecord(await request(`/anomalies/${id}`)),
    updateRecord: async (id, data) => {
      const item = mapRecord(await request(`/anomalies/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: data.status, assignee: data.assignee }) }));
      recordsPageSequence += 1;
      const index = state.records.findIndex(x => x.id === id);
      const previous = index >= 0 ? state.records[index] : null;
      if (index >= 0) state.records[index] = item;
      applyOverviewRecordTransition(previous, item);
      return withRefresh(item, refreshOverview);
    },
    bulkUpdateRecords: async (ids, status) => withRefresh(await request('/anomalies/bulk-status', { method: 'POST', body: JSON.stringify({ ids, status }) })),
    downloadExport: url => request(url.replace(/^\/api\/v1/, ''), { responseType: 'blob' }),
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
        highAnomalies: server.high_anomalies ?? state.records.filter(r => r.severity === 'high' && r.status !== 'resolved').length,
        resolvedToday: server.resolved_records ?? state.records.filter(r => r.status === 'resolved').length,
      };
    },
  };
})();
