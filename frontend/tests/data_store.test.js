const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');


test('sendFeishuTestMessage posts the selected target to the system test endpoint', async () => {
  const requests = [];
  const context = {
    window: {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, message_id: 'om_frontend' }),
      };
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'data.js'), 'utf8');
  vm.runInNewContext(source, context);

  const result = await context.window.Store.sendFeishuTestMessage('chat_id', 'oc_group');

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, message_id: 'om_frontend' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/v1/tests/feishu-message');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    receive_id_type: 'chat_id',
    receive_id: 'oc_group',
  });
});

test('abortAnomalyPushes posts to the administrative abort endpoint', async () => {
  const requests = [];
  const summary = {
    status: 'completed', aborted_jobs: 3, stopped_ds_instances: 2,
    deleted_ds_instances: 2, cleared_kafka_partitions: 1, errors: [],
  };
  const context = {
    window: {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => summary };
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '..', 'scripts', 'data.js'), 'utf8'), context,
  );

  const result = await context.window.Store.abortAnomalyPushes();

  assert.deepEqual(JSON.parse(JSON.stringify(result)), summary);
  assert.equal(requests[0].url, '/api/v1/anomaly-pushes/abort');
  assert.equal(requests[0].options.method, 'POST');
});

test('validation rule fields and anomaly audit details map between API and UI contracts', async () => {
  const requests = [];
  const responses = {
    '/api/v1/auth/me': { username: 'admin' },
    '/api/v1/datasources': [],
    '/api/v1/datasets': [{
      id: 'dataset-1', name: 'Orders', description: '', datasource_id: 'source-1',
      datasource_name: 'Warehouse', sql: 'select 1', fields: [{ name: 'owner_id', type: 'varchar' }],
      row_count: 1, created_at: '2026-08-22T08:00:00', updated_at: '2026-08-22T08:00:00',
    }],
    '/api/v1/rules': [{
      id: 'rule-1', name: 'GMV check', description: 'GMV anomaly', dataset_id: 'dataset-1',
      dataset_name: 'Orders', severity: 'high', logic: 'AND',
      conditions: [{ field: 'gmv', operator: 'gt', value: 100 }], anomaly_key_fields: ['owner_id'],
      schedule: { frequency: 'day', interval: 1, time: '09:00', start_date: '2026-08-22', end_date: null },
      notification_targets: [{ receive_id_type: 'open_id', source: 'literal', value: 'ou_1' }],
      validation_enabled: true,
      validation_targets: [{ source: 'literal', value: 'u_1' }, { source: 'field', field: 'owner_id' }],
      validation_timeout_minutes: 30,
      validation_method: 'sql',
      sql_validation_config: {
        query_template: "SELECT status FROM repair_state WHERE owner_id='{目标ID}'",
        parameters: [{ name: '目标ID', field: 'owner_id' }],
        true_condition: { field: 'status', operator: 'eq', value: 'normal', upper_value: null },
      },
      group_broadcast: {
        enabled: true, has_webhook: true,
        mention_targets: [{ source: 'literal', value: 'group-owner' }, { source: 'field', field: 'owner_id' }],
      },
      enabled: true, sync_status: 'synced', sync_error: null, last_run: null, next_run: null,
      anomaly_count: 1, created_at: '2026-08-22T08:00:00',
    }],
    '/api/v1/anomalies?page=1&page_size=10': {
      items: [{
        id: 'record-1', rule_id: 'rule-1', rule_name: 'GMV check', dataset_name: 'Orders',
        severity: 'high', status: 'timed_out', business_key: { owner_id: 'u_1' }, row_details: { gmv: 999 },
        matched_conditions: [{ field: 'gmv', operator: 'gt', actual: 999 }], hit_count: 1,
        first_seen_at: '2026-08-22T09:00:00', last_seen_at: '2026-08-22T09:10:00',
        resolved_at: null, assignee: null, description: 'GMV anomaly',
        validation_deadline: '2026-08-22T09:30:00', timed_out_at: '2026-08-22T09:30:01',
        resolution_source: null, resolved_by_user_id: null, delivery_status: 'sent',
        validation_method: 'sql',
      }], total: 1, page: 1, page_size: 100,
    },
    '/api/v1/overview': {
      stats: {
        pending_records: 2, processing_records: 3, timed_out_records: 4, resolved_records: 5,
        critical_anomalies: 1, active_rules: 1, total_rules: 1, online_datasources: 0,
        total_datasources: 0, total_datasets: 1, push_in_transit_anomalies: 6,
      }, recent_anomalies: [], top_rules: [],
    },
    '/api/v1/anomalies/record-1': {
      id: 'record-1', rule_id: 'rule-1', rule_name: 'GMV check', dataset_name: 'Orders',
      severity: 'high', status: 'resolved', business_key: { owner_id: 'u_1' }, row_details: { gmv: 999 },
      matched_conditions: [{ field: 'gmv', operator: 'gt', actual: 999 }], hit_count: 1,
      first_seen_at: '2026-08-22T09:00:00', last_seen_at: '2026-08-22T09:10:00', resolved_at: '2026-08-22T09:20:00',
      assignee: null, description: 'GMV anomaly', validation_deadline: '2026-08-22T09:30:00',
      timed_out_at: null, resolution_source: 'validation', resolved_by_user_id: 'u_1', delivery_status: 'sent',
      validation_method: 'sql',
      timeline: [], deliveries: [],
      validation_requests: [{
        recipient_user_id: 'u_1', delivery_status: 'resolved', delivery_attempts: 2,
        message_id: 'om_1', last_error: null, delivered_at: '2026-08-22T09:01:00',
      }],
      validation_submission: {
        submitted_by_user_id: 'u_1', submitted_text: 'confirmed', validator_type: 'pseudo',
        result: 'passed', submitted_at: '2026-08-22T09:20:00',
        result_detail: { field: 'status', operator: 'eq', value: 'normal', upper_value: null, actual: 'normal' },
      },
    },
  };
  const context = {
    window: {},
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === '/api/v1/rules' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        return {
          ok: true, status: 201,
          json: async () => ({
            ...responses['/api/v1/rules'][0],
            id: 'rule-2', name: body.name, description: body.description,
            validation_enabled: body.validation_enabled,
            validation_targets: body.validation_targets,
            validation_timeout_minutes: body.validation_timeout_minutes,
            validation_method: body.validation_method,
            sql_validation_config: body.sql_validation_config,
            group_broadcast: {
              enabled: body.group_broadcast.enabled,
              has_webhook: !!body.group_broadcast.webhook_url,
              mention_targets: body.group_broadcast.mention_targets,
            },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => responses[url] || responses[url.split('?')[0]] };
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'data.js'), 'utf8');
  vm.runInNewContext(source, context);
  const store = context.window.Store;

  await store.init();

  const rule = store.getRule('rule-1');
  assert.equal(rule.validationEnabled, true);
  assert.equal(rule.validationTimeoutMinutes, 30);
  assert.equal(rule.validationMethod, 'sql');
  assert.equal(rule.sqlValidationConfig.queryTemplate, "SELECT status FROM repair_state WHERE owner_id='{目标ID}'");
  assert.deepEqual(JSON.parse(JSON.stringify(rule.validationTargets)), [
    { source: 'literal', value: 'u_1' }, { source: 'field', field: 'owner_id' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(rule.groupBroadcast)), {
    enabled: true,
    hasWebhook: true,
    mentionTargets: [{ source: 'literal', value: 'group-owner' }, { source: 'field', field: 'owner_id' }],
  });
  const listed = store.getRecord('record-1');
  assert.equal(listed.description, 'GMV anomaly');
  assert.equal(listed.validationDeadline, '2026-08-22T09:30:00');
  assert.equal(listed.timedOutAt, '2026-08-22T09:30:01');
  assert.equal(store.getStats().timedOutRecords, 4);
  assert.equal(store.getStats().unresolvedRecords, 9);
  assert.equal(store.getStats().pushInTransitAnomalies, 6);

  const detail = await store.loadRecord('record-1');
  assert.equal(detail.resolutionSource, 'validation');
  assert.equal(detail.resolvedByUserId, 'u_1');
  assert.equal(detail.validationMethod, 'sql');
  assert.deepEqual(JSON.parse(JSON.stringify(detail.validationRequests)), [{
    recipientUserId: 'u_1', deliveryStatus: 'resolved', deliveryAttempts: 2,
    messageId: 'om_1', lastError: null, deliveredAt: '2026-08-22T09:01:00',
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(detail.validationSubmission)), {
    submittedByUserId: 'u_1', submittedText: 'confirmed', validatorType: 'pseudo',
    result: 'passed', submittedAt: '2026-08-22T09:20:00',
    resultDetail: { field: 'status', operator: 'eq', value: 'normal', upperValue: null, actual: 'normal' },
  });

  await store.addRule({
    name: 'Validation', description: 'Review it', datasetId: 'dataset-1', severity: 'high', logic: 'AND',
    conditions: [{ field: 'gmv', op: 'gt', value: 100 }], anomalyKeyFields: ['owner_id'],
    schedule: { frequency: 'day', interval: 1, time: '09:00', start: '2026-08-22', end: null },
    notificationTargets: [{ receive_id_type: 'open_id', source: 'literal', value: 'ou_1' }],
    validationEnabled: false,
    validationTargets: [{ source: 'literal', value: 'u_2' }, { source: 'field', field: 'owner_id' }],
    validationTimeoutMinutes: 43200,
    validationMethod: 'sql',
    sqlValidationConfig: {
      queryTemplate: "SELECT status FROM repair_state WHERE owner_id='{目标ID}'",
      parameters: [{ name: '目标ID', field: 'owner_id' }],
      trueCondition: { field: 'status', operator: 'eq', value: 'normal', upperValue: null },
    },
    groupBroadcast: {
      enabled: true,
      hasWebhook: false,
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook',
      mentionTargets: [{ source: 'literal', value: 'group-user' }, { source: 'field', field: 'owner_id' }],
    },
    enabled: true,
  });
  const createRequest = requests.find(item => item.url === '/api/v1/rules' && item.options.method === 'POST');
  const body = JSON.parse(createRequest.options.body);
  assert.equal(body.validation_enabled, false);
  assert.equal(body.validation_timeout_minutes, 43200);
  assert.equal(body.validation_method, 'sql');
  assert.deepEqual(body.sql_validation_config, {
    query_template: "SELECT status FROM repair_state WHERE owner_id='{目标ID}'",
    parameters: [{ name: '目标ID', field: 'owner_id' }],
    true_condition: { field: 'status', operator: 'eq', value: 'normal', upper_value: null },
  });
  assert.deepEqual(body.validation_targets, [
    { source: 'literal', value: 'u_2' }, { source: 'field', field: 'owner_id' },
  ]);
  assert.deepEqual(body.group_broadcast, {
    enabled: true,
    webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook',
    mention_targets: [{ source: 'literal', value: 'group-user' }, { source: 'field', field: 'owner_id' }],
  });
});

test('updating an existing condition sends the edited operator instead of the stale API operator', async () => {
  const requests = [];
  const apiRule = {
    id: 'rule-1', name: 'Temperature check', description: '', dataset_id: 'dataset-1',
    dataset_name: 'Vehicle temperatures', severity: 'medium', logic: 'AND',
    conditions: [{ field: 'refrigerated_temperature', operator: 'gte', value: -12 }],
    anomaly_key_fields: ['data_date', 'license_plate'],
    schedule: { frequency: 'day', interval: 1, time: '09:00', start_date: '2026-08-09', end_date: null },
    notification_targets: [{ receive_id_type: 'user_id', source: 'literal', value: 'validator-1' }],
    validation_enabled: false, validation_targets: [], validation_timeout_minutes: 1440,
    enabled: true, sync_status: 'synced', sync_error: null, created_at: '2026-08-22T08:00:00',
  };
  const context = {
    window: {},
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === '/api/v1/auth/me') return { ok: true, status: 200, json: async () => ({ username: 'admin' }) };
      if (url === '/api/v1/datasources' || url === '/api/v1/datasets') return { ok: true, status: 200, json: async () => [] };
      if (url === '/api/v1/rules') return { ok: true, status: 200, json: async () => [apiRule] };
      if (url === '/api/v1/anomalies?page=1&page_size=10') {
        return { ok: true, status: 200, json: async () => ({ items: [], total: 0, page: 1, page_size: 10 }) };
      }
      if (url === '/api/v1/overview') return { ok: true, status: 200, json: async () => ({ stats: {} }) };
      if (url === '/api/v1/rules/rule-1' && options.method === 'PUT') {
        return { ok: true, status: 200, json: async () => ({ ...apiRule, ...JSON.parse(options.body) }) };
      }
      throw new Error(`unexpected request ${url}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'data.js'), 'utf8'), context);
  const store = context.window.Store;
  await store.init();

  const condition = store.getRule('rule-1').conditions[0];
  await store.updateRule('rule-1', {
    conditions: [{ ...condition, field: 'license_plate', op: 'eq', value: 'q皖H0BCB7' }],
  });

  const request = requests.find(item => item.url === '/api/v1/rules/rule-1' && item.options.method === 'PUT');
  assert.deepEqual(JSON.parse(request.options.body).conditions, [{
    field: 'license_plate', operator: 'eq', value: 'q皖H0BCB7', upper_value: null, baseline: null,
  }]);
});

test('updating one record refreshes authoritative overview counts immediately', async () => {
  const requests = [];
  let resolved = false;
  const apiRecord = status => ({
    id: 'record-1', rule_id: 'rule-1', rule_name: 'GMV check', dataset_name: 'Orders',
    severity: 'high', status, business_key: {}, row_details: { gmv: 999 },
    matched_conditions: [{ field: 'gmv', operator: 'gt', actual: 999 }], hit_count: 1,
    first_seen_at: '2026-08-22T09:00:00', last_seen_at: '2026-08-22T09:10:00',
    resolved_at: status === 'resolved' ? '2026-08-22T09:20:00' : null, assignee: null,
    description: '', validation_deadline: null, timed_out_at: status === 'timed_out' ? '2026-08-22T09:15:00' : null,
    resolution_source: status === 'resolved' ? 'manual' : null,
    resolved_by_user_id: status === 'resolved' ? 'admin' : null, delivery_status: 'none',
  });
  const overview = () => ({
    stats: {
      pending_records: 0, processing_records: 0, timed_out_records: resolved ? 0 : 1,
      resolved_records: resolved ? 1 : 0, critical_anomalies: 0, active_rules: 0,
      total_rules: 0, online_datasources: 0, total_datasources: 0, total_datasets: 0,
    }, recent_anomalies: [], top_rules: [],
  });
  const context = {
    window: {},
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      let body;
      if (url === '/api/v1/auth/me') body = { username: 'admin' };
      else if (url === '/api/v1/datasources' || url === '/api/v1/datasets' || url === '/api/v1/rules') body = [];
      else if (url === '/api/v1/anomalies?page=1&page_size=10') body = { items: [apiRecord('timed_out')], total: 1, page: 1, page_size: 10 };
      else if (url === '/api/v1/anomalies/record-1/status') { resolved = true; body = apiRecord('resolved'); }
      else if (url === '/api/v1/overview') body = overview();
      else throw new Error(`unexpected request ${url}`);
      return { ok: true, status: 200, json: async () => body };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'data.js'), 'utf8'), context);
  const store = context.window.Store;
  await store.init();
  assert.equal(store.getStats().timedOutRecords, 1);
  assert.equal(store.getStats().unresolvedRecords, 1);

  await store.updateRecord('record-1', { status: 'resolved' });

  assert.equal(store.getRecord('record-1').status, 'resolved');
  assert.equal(store.getStats().timedOutRecords, 0);
  assert.equal(store.getStats().resolvedToday, 1);
  assert.equal(store.getStats().unresolvedRecords, 0);
  assert.equal(requests.filter(item => item.url === '/api/v1/overview').length, 2);
});

test('a successful record mutation remains successful when the overview refresh fails', async () => {
  let overviewRequests = 0;
  const apiRecord = status => ({
    id: 'record-1', rule_id: 'rule-1', rule_name: 'GMV check', dataset_name: 'Orders',
    severity: 'critical', status, business_key: {}, row_details: { gmv: 999 },
    matched_conditions: [{ field: 'gmv', operator: 'gt', actual: 999 }], hit_count: 1,
    first_seen_at: '2026-08-22T09:00:00', last_seen_at: '2026-08-22T09:10:00',
    resolved_at: status === 'resolved' ? '2026-08-22T09:20:00' : null, assignee: null,
    description: '', validation_deadline: null, timed_out_at: status === 'timed_out' ? '2026-08-22T09:15:00' : null,
    resolution_source: status === 'resolved' ? 'manual' : null,
    resolved_by_user_id: status === 'resolved' ? 'admin' : null, delivery_status: 'none',
  });
  const context = {
    window: {},
    fetch: async (url, options = {}) => {
      let body;
      if (url === '/api/v1/auth/me') body = { username: 'admin' };
      else if (url === '/api/v1/datasources' || url === '/api/v1/datasets' || url === '/api/v1/rules') body = [];
      else if (url === '/api/v1/anomalies?page=1&page_size=10') body = { items: [apiRecord('timed_out')], total: 1, page: 1, page_size: 10 };
      else if (url === '/api/v1/anomalies/record-1/status') body = apiRecord('resolved');
      else if (url === '/api/v1/overview') {
        overviewRequests += 1;
        if (overviewRequests > 1) return { ok: false, status: 503, statusText: 'Unavailable', json: async () => ({ detail: 'overview offline' }) };
        body = {
          stats: {
            pending_records: 0, processing_records: 0, timed_out_records: 1,
            resolved_records: 0, critical_anomalies: 1, active_rules: 0,
            total_rules: 0, online_datasources: 0, total_datasources: 0, total_datasets: 0,
          }, recent_anomalies: [], top_rules: [],
        };
      } else throw new Error(`unexpected request ${url}`);
      return { ok: true, status: 200, json: async () => body };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'data.js'), 'utf8'), context);
  const store = context.window.Store;
  await store.init();

  const updated = await store.updateRecord('record-1', { status: 'resolved' });

  assert.equal(updated.status, 'resolved');
  assert.equal(store.getRecord('record-1').status, 'resolved');
  assert.equal(store.getStats().timedOutRecords, 0);
  assert.equal(store.getStats().resolvedToday, 1);
  assert.equal(store.getStats().criticalAnomalies, 0);
  assert.equal(store.getStats().unresolvedRecords, 0);
});

test('record pages are loaded from the backend with status and pagination filters', async () => {
  const requests = [];
  const context = {
    window: {}, URLSearchParams,
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      return {
        ok: true, status: 200,
        json: async () => ({
          items: [{
            id: 'record-21', rule_id: 'rule-1', rule_name: 'GMV check', dataset_name: 'Orders',
            severity: 'high', status: 'timed_out', business_key: {}, row_details: { gmv: 999 },
            matched_conditions: [{ field: 'gmv', operator: 'gt', actual: 999 }], hit_count: 1,
            first_seen_at: '2026-08-22T09:00:00', last_seen_at: '2026-08-22T09:10:00',
            resolved_at: null, assignee: null, description: '', validation_deadline: null,
            timed_out_at: '2026-08-22T09:30:00', resolution_source: null,
            resolved_by_user_id: null, delivery_status: 'none',
          }],
          total: 27, page: 3, page_size: 10,
        }),
      };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'data.js'), 'utf8'), context);
  const store = context.window.Store;
  assert.equal(typeof store.loadRecordsPage, 'function');

  const result = await store.loadRecordsPage({
    page: 3, pageSize: 10, status: 'timed_out', pushStatus: 'in_transit',
    severity: 'high', ruleId: 'rule-1', search: 'GMV',
    sortKey: 'severity', sortOrder: 'asc',
  });

  assert.equal(requests[0].url, '/api/v1/anomalies?page=3&page_size=10&status_filter=timed_out&push_status=in_transit&severity=high&rule_id=rule-1&search=GMV&sort_key=severity&sort_order=asc');
  assert.equal(result.total, 27);
  assert.equal(result.page, 3);
  assert.equal(result.pageSize, 10);
  assert.equal(result.items[0].status, 'timed_out');
  assert.equal(store.getRecords()[0].id, 'record-21');
  assert.equal(
    store.exportUrl({
      status: 'timed_out', pushStatus: 'in_transit', severity: 'high', ruleId: 'rule-1', search: 'GMV',
      sortKey: 'severity', sortOrder: 'asc',
    }),
    '/api/v1/anomalies/export?status_filter=timed_out&push_status=in_transit&severity=high&rule_id=rule-1&search=GMV&sort_key=severity&sort_order=asc',
  );
});

test('the newest record-page request owns the Store cache when responses arrive out of order', async () => {
  const pendingResponses = [];
  const apiRecord = (id, status) => ({
    id, rule_id: 'rule-1', rule_name: 'GMV check', dataset_name: 'Orders', severity: 'high', status,
    business_key: {}, row_details: {}, matched_conditions: [], hit_count: 1,
    first_seen_at: '2026-08-22T09:00:00', last_seen_at: '2026-08-22T09:00:00',
    resolved_at: null, assignee: null, description: '', validation_deadline: null,
    timed_out_at: null, resolution_source: null, resolved_by_user_id: null, delivery_status: 'none',
  });
  const context = {
    window: {},
    fetch: url => new Promise(resolve => pendingResponses.push({ url, resolve })),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'data.js'), 'utf8'), context);
  const store = context.window.Store;
  const first = store.loadRecordsPage({ page: 1, pageSize: 10, status: 'pending' });
  const second = store.loadRecordsPage({ page: 1, pageSize: 10, status: 'timed_out' });

  pendingResponses[1].resolve({
    ok: true, status: 200,
    json: async () => ({ items: [apiRecord('newest', 'timed_out')], total: 1, page: 1, page_size: 10 }),
  });
  await second;
  pendingResponses[0].resolve({
    ok: true, status: 200,
    json: async () => ({ items: [apiRecord('stale', 'pending')], total: 1, page: 1, page_size: 10 }),
  });
  await first;

  assert.equal(store.getRecords()[0].id, 'newest');
  assert.equal(store.getRecords()[0].status, 'timed_out');
});

test('peeking an export page neither replaces cached records nor supersedes an in-flight page owner', async () => {
  const pendingResponses = [];
  const apiRecord = (id, status) => ({
    id, rule_id: 'rule-1', rule_name: 'GMV check', dataset_name: 'Orders', severity: 'high', status,
    business_key: {}, row_details: {}, matched_conditions: [], hit_count: 1,
    first_seen_at: '2026-08-22T09:00:00', last_seen_at: '2026-08-22T09:00:00',
    resolved_at: null, assignee: null, description: '', validation_deadline: null,
    timed_out_at: null, resolution_source: null, resolved_by_user_id: null, delivery_status: 'none',
  });
  const context = {
    window: {},
    fetch: url => new Promise(resolve => pendingResponses.push({ url, resolve })),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'data.js'), 'utf8'), context);
  const store = context.window.Store;

  const initial = store.loadRecordsPage({ page: 2, pageSize: 10 });
  pendingResponses[0].resolve({
    ok: true, status: 200,
    json: async () => ({ items: [apiRecord('page-two-current', 'timed_out')], total: 11, page: 2, page_size: 10 }),
  });
  await initial;

  const pageRefresh = store.loadRecordsPage({ page: 2, pageSize: 10 });
  const exportPeek = store.peekRecordsPage({ page: 1, pageSize: 10 });
  pendingResponses[2].resolve({
    ok: true, status: 200,
    json: async () => ({ items: [apiRecord('page-one-export', 'pending')], total: 11, page: 1, page_size: 10 }),
  });
  const peeked = await exportPeek;

  assert.equal(peeked.items[0].id, 'page-one-export');
  assert.equal(store.getRecords()[0].id, 'page-two-current');

  pendingResponses[1].resolve({
    ok: true, status: 200,
    json: async () => ({ items: [apiRecord('page-two-newest', 'timed_out')], total: 11, page: 2, page_size: 10 }),
  });
  await pageRefresh;

  assert.equal(store.getRecords()[0].id, 'page-two-newest');
});

test('anomaly group pages and details map live status summaries and member records', async () => {
  const requests = [];
  const group = {
    group_id: 'run-1', rule_id: 'rule-1', rule_name: 'GMV check', detected_at: '2026-08-23T09:00:00',
    scanned_rows: 10, matched_rows: 1, new_anomalies: 1,
    status_counts: { pending: 1, processing: 0, timed_out: 0, resolved: 0 },
    broadcast_status: 'sent',
  };
  const context = {
    window: {},
    fetch: async url => {
      requests.push(url);
      if (url.startsWith('/api/v1/anomaly-groups/run-1')) return {
        ok: true, status: 200, json: async () => ({
          group,
          items: [{
            id: 'record-1', rule_id: 'rule-1', rule_name: 'GMV check', dataset_name: 'Orders',
            severity: 'high', status: 'pending', business_key: { store_id: 1 }, row_details: { gmv: 999 },
            matched_conditions: [{ field: 'gmv', operator: 'gt', actual: 999 }], hit_count: 1,
            first_seen_at: '2026-08-23T09:00:00', last_seen_at: '2026-08-23T09:00:00', delivery_status: 'none',
          }],
          total: 1, page: 1, page_size: 20,
        }),
      };
      return {
        ok: true, status: 200,
        json: async () => ({ items: [group], total: 1, page: 1, page_size: 10 }),
      };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'data.js'), 'utf8'), context);

  const page = await context.window.Store.loadAnomalyGroupsPage({ search: 'GMV', page: 1, pageSize: 10 });
  const detail = await context.window.Store.loadAnomalyGroup('run-1', { page: 1, pageSize: 20 });

  assert.equal(requests[0], '/api/v1/anomaly-groups?page=1&page_size=10&search=GMV');
  assert.equal(requests[1], '/api/v1/anomaly-groups/run-1?page=1&page_size=20');
  assert.equal(page.items[0].broadcastStatus, 'sent');
  assert.equal(page.items[0].statusCounts.pending, 1);
  assert.equal(detail.items[0].id, 'record-1');
  assert.equal(detail.items[0].status, 'pending');
});
