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
      enabled: true, sync_status: 'synced', sync_error: null, last_run: null, next_run: null,
      anomaly_count: 1, created_at: '2026-08-22T08:00:00',
    }],
    '/api/v1/anomalies?page_size=100': {
      items: [{
        id: 'record-1', rule_id: 'rule-1', rule_name: 'GMV check', dataset_name: 'Orders',
        severity: 'high', status: 'timed_out', business_key: { owner_id: 'u_1' }, row_details: { gmv: 999 },
        matched_conditions: [{ field: 'gmv', operator: 'gt', actual: 999 }], hit_count: 1,
        first_seen_at: '2026-08-22T09:00:00', last_seen_at: '2026-08-22T09:10:00',
        resolved_at: null, assignee: null, description: 'GMV anomaly',
        validation_deadline: '2026-08-22T09:30:00', timed_out_at: '2026-08-22T09:30:01',
        resolution_source: null, resolved_by_user_id: null, delivery_status: 'sent',
      }], total: 1, page: 1, page_size: 100,
    },
    '/api/v1/overview': {
      stats: {
        pending_records: 2, processing_records: 3, timed_out_records: 4, resolved_records: 5,
        critical_anomalies: 1, active_rules: 1, total_rules: 1, online_datasources: 0,
        total_datasources: 0, total_datasets: 1,
      }, recent_anomalies: [], top_rules: [],
    },
    '/api/v1/anomalies/record-1': {
      id: 'record-1', rule_id: 'rule-1', rule_name: 'GMV check', dataset_name: 'Orders',
      severity: 'high', status: 'resolved', business_key: { owner_id: 'u_1' }, row_details: { gmv: 999 },
      matched_conditions: [{ field: 'gmv', operator: 'gt', actual: 999 }], hit_count: 1,
      first_seen_at: '2026-08-22T09:00:00', last_seen_at: '2026-08-22T09:10:00', resolved_at: '2026-08-22T09:20:00',
      assignee: null, description: 'GMV anomaly', validation_deadline: '2026-08-22T09:30:00',
      timed_out_at: null, resolution_source: 'validation', resolved_by_user_id: 'u_1', delivery_status: 'sent',
      timeline: [], deliveries: [],
      validation_requests: [{
        recipient_user_id: 'u_1', delivery_status: 'resolved', delivery_attempts: 2,
        message_id: 'om_1', last_error: null, delivered_at: '2026-08-22T09:01:00',
      }],
      validation_submission: {
        submitted_by_user_id: 'u_1', submitted_text: 'confirmed', validator_type: 'pseudo',
        result: 'passed', submitted_at: '2026-08-22T09:20:00',
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
  assert.deepEqual(JSON.parse(JSON.stringify(rule.validationTargets)), [
    { source: 'literal', value: 'u_1' }, { source: 'field', field: 'owner_id' },
  ]);
  const listed = store.getRecord('record-1');
  assert.equal(listed.description, 'GMV anomaly');
  assert.equal(listed.validationDeadline, '2026-08-22T09:30:00');
  assert.equal(listed.timedOutAt, '2026-08-22T09:30:01');
  assert.equal(store.getStats().timedOutRecords, 4);
  assert.equal(store.getStats().unresolvedRecords, 9);

  const detail = await store.loadRecord('record-1');
  assert.equal(detail.resolutionSource, 'validation');
  assert.equal(detail.resolvedByUserId, 'u_1');
  assert.deepEqual(JSON.parse(JSON.stringify(detail.validationRequests)), [{
    recipientUserId: 'u_1', deliveryStatus: 'resolved', deliveryAttempts: 2,
    messageId: 'om_1', lastError: null, deliveredAt: '2026-08-22T09:01:00',
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(detail.validationSubmission)), {
    submittedByUserId: 'u_1', submittedText: 'confirmed', validatorType: 'pseudo',
    result: 'passed', submittedAt: '2026-08-22T09:20:00',
  });

  await store.addRule({
    name: 'Validation', description: 'Review it', datasetId: 'dataset-1', severity: 'high', logic: 'AND',
    conditions: [{ field: 'gmv', op: 'gt', value: 100 }], anomalyKeyFields: ['owner_id'],
    schedule: { frequency: 'day', interval: 1, time: '09:00', start: '2026-08-22', end: null },
    notificationTargets: [{ receive_id_type: 'open_id', source: 'literal', value: 'ou_1' }],
    validationEnabled: false,
    validationTargets: [{ source: 'literal', value: 'u_2' }, { source: 'field', field: 'owner_id' }],
    validationTimeoutMinutes: 43200,
    enabled: true,
  });
  const createRequest = requests.find(item => item.url === '/api/v1/rules' && item.options.method === 'POST');
  const body = JSON.parse(createRequest.options.body);
  assert.equal(body.validation_enabled, false);
  assert.equal(body.validation_timeout_minutes, 43200);
  assert.deepEqual(body.validation_targets, [
    { source: 'literal', value: 'u_2' }, { source: 'field', field: 'owner_id' },
  ]);
});
