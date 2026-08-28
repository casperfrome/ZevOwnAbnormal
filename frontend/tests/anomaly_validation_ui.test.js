const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');

const frontendRoot = path.join(__dirname, '..');
const executablePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function withPage(t, setup) {
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(2000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.setContent('<!doctype html><html><body><div id="toast-container"></div><div id="actions"></div><div id="content"></div></body></html>');
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'icons.js') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'components.js') });
  await setup(page);
  return { page, pageErrors };
}

function datasetFixture() {
  return {
    id: 'dataset-1', name: 'Orders', rowCount: 100,
    fields: [
      { name: 'order_id', type: 'varchar' },
      { name: 'owner_id', type: 'varchar' },
      { name: 'reviewer_id', type: 'varchar' },
      { name: 'amount', type: 'decimal' },
    ],
  };
}

test('rule field selectors preserve hostile names and types as inert option text', async t => {
  const fieldName = 'owner" data-pwned="yes"><img src=x onerror="window.ruleXss=1">';
  const fieldType = 'varchar</option><option id="field-type-xss" value="pwned" onerror="window.ruleXss=1">owned</option><option>';
  const dataset = {
    id: 'dataset-hostile', name: 'Hostile fields', rowCount: 1,
    fields: [{ name: fieldName, type: fieldType }],
  };
  const { page, pageErrors } = await withPage(t, async page => {
    await page.evaluate(datasetValue => {
      window.ruleXss = 0;
      window.Store = {
        getRules: () => [], getDatasets: () => [datasetValue],
        getDataset: id => id === datasetValue.id ? datasetValue : null,
      };
    }, dataset);
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'rules.js') });
    await page.evaluate(() => RulesModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  await page.click('#r-add');
  await page.getByRole('tab', { name: '关联数据集', exact: true }).click();
  await page.selectOption('#f-dataset', dataset.id);
  const selectors = [
    '#f-field-source', '#f-validation-fields',
    '.condition-row [data-c="field"]',
  ];
  for (const selector of selectors) {
    const options = await page.locator(`${selector} option`).evaluateAll(nodes => nodes.map(option => ({
      value: option.value,
      text: option.textContent,
      pwned: option.getAttribute('data-pwned'),
    })));
    const matching = options.filter(option => option.value === fieldName);
    assert.equal(matching.length, 1, `${selector} keeps exactly one field option`);
    assert.equal(matching[0].text, `${fieldName} · ${fieldType}`);
    assert.equal(matching[0].pwned, null);
  }
  await page.click('#f-key-fields');
  const keyFieldOption = page.locator('#f-key-fields-listbox [role="option"]');
  assert.equal(await keyFieldOption.count(), 1);
  assert.equal(await keyFieldOption.getAttribute('data-key-field'), fieldName);
  assert.equal(await keyFieldOption.locator('strong').textContent(), fieldName);
  assert.equal(await keyFieldOption.locator('small').textContent(), fieldType);
  assert.equal(await keyFieldOption.getAttribute('data-pwned'), null);
  assert.equal(await page.locator('#field-type-xss').count(), 0);
  assert.equal(await page.evaluate(() => window.ruleXss), 0);
  assert.deepEqual(pageErrors, []);
});

test('rule form saves real-time validation targets and reports an inline error when enabled without targets', async t => {
  const { page, pageErrors } = await withPage(t, async page => {
    await page.evaluate(dataset => {
      window.createdRule = null;
      window.Store = {
        getRules: () => [], getDatasets: () => [dataset],
        getDataset: id => id === dataset.id ? dataset : null,
        addRule: async payload => { window.createdRule = payload; },
      };
    }, datasetFixture());
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'rules.js') });
    await page.evaluate(() => RulesModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  await page.click('#r-add');
  assert.equal(await page.getByText('异常描述', { exact: true }).count(), 1);
  assert.equal(await page.getByText('实时校验', { exact: true }).count(), 1);
  assert.equal(await page.getByRole('tab', { name: '私聊通知', exact: true }).count(), 1, 'normal notifications remain a distinct section');
  await page.fill('#f-name', 'Validation rule');
  await page.getByRole('tab', { name: '关联数据集', exact: true }).click();
  await page.selectOption('#f-dataset', 'dataset-1');
  await page.click('#f-key-fields');
  await page.locator('#f-key-fields-listbox [data-key-field="order_id"]').click();
  await page.getByRole('tab', { name: '异常条件', exact: true }).click();
  await page.selectOption('.condition-row [data-c="field"]', 'amount');
  await page.fill('.condition-row [data-c="value"]', '100');
  await page.getByRole('tab', { name: '私聊通知', exact: true }).click();
  await page.fill('#f-openids-input', 'ou_notify');
  await page.getByRole('tab', { name: '实时校验', exact: true }).click();
  await page.check('#f-validation-enabled');
  await page.getByRole('tab', { name: '基本信息', exact: true }).click();
  await page.fill('#f-deadline-days', '0');
  await page.fill('#f-deadline-minutes', '30');
  await page.getByRole('tab', { name: '实时校验', exact: true }).click();
  await page.getByRole('tab', { name: '基本信息' }).click();
  await page.click('#f-save');

  assert.equal(await page.evaluate(() => window.createdRule), null);
  assert.equal(await page.getByRole('tab', { selected: true }).textContent(), '实时校验');
  assert.equal(await page.locator('#f-validation-userids-input').evaluate(node => node === document.activeElement), true);
  const targetError = page.locator('#f-validation-target-error');
  assert.equal(await targetError.isVisible(), true);
  assert.match(await targetError.textContent(), /至少.*验证目标/);

  await page.getByRole('tab', { name: '实时校验', exact: true }).click();
  await page.fill('#f-validation-userids-input', 'u_typed_not_entered');
  await page.selectOption('#f-validation-fields', ['owner_id', 'reviewer_id']);
  await page.click('#f-save');
  await page.waitForTimeout(25);

  const created = await page.evaluate(() => window.createdRule);
  assert.equal(created.validationEnabled, true);
  assert.equal(created.deadlineSeconds, 1800);
  assert.deepEqual(created.validationTargets, [
    { source: 'literal', value: 'u_typed_not_entered' },
    { source: 'field', field: 'owner_id' },
    { source: 'field', field: 'reviewer_id' },
  ]);
  assert.deepEqual(pageErrors, []);
});

test('disabled real-time validation preserves configured targets when editing', async t => {
  const { page, pageErrors } = await withPage(t, async page => {
    const dataset = datasetFixture();
    const rule = {
      id: 'rule-1', name: 'Validation rule', description: 'Review issue', datasetId: dataset.id,
      datasetName: dataset.name, severity: 'medium', enabled: true, anomalyCount: 0,
      lastRun: null, logic: 'AND', conditions: [{ field: 'amount', op: 'gt', value: '100' }],
      anomalyKeyFields: ['order_id'], schedule: { frequency: 'day', interval: 1, time: '09:00', start: '2026-08-22', end: '' },
      notify: { mode: 'manual', openIds: ['ou_notify'], userIds: [], fieldSource: null },
      notificationTargets: [{ receive_id_type: 'open_id', source: 'literal', value: 'ou_notify' }],
      validationEnabled: false,
      validationTargets: [{ source: 'literal', value: 'u_1' }, { source: 'field', field: 'owner_id' }],
      validationTimeoutMinutes: 60,
    };
    await page.evaluate(({ dataset, rule }) => {
      window.savedRule = null;
      window.Store = {
        getRules: () => [rule], getRule: () => rule, getDatasets: () => [dataset], getDataset: () => dataset,
        updateRule: async (_id, payload) => { window.savedRule = payload; },
      };
    }, { dataset, rule });
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'rules.js') });
    await page.evaluate(() => RulesModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  await page.click('[data-action="edit"]');
  assert.equal(await page.isChecked('#f-validation-enabled'), false);
  assert.equal(await page.locator('#f-validation-userids .tag-pill').count(), 1);
  assert.deepEqual(
    await page.locator('#f-validation-fields option:checked').evaluateAll(options => options.map(option => option.value)),
    ['owner_id'],
  );
  await page.click('#f-save');
  await page.waitForTimeout(25);

  const saved = await page.evaluate(() => window.savedRule);
  assert.equal(saved.validationEnabled, false);
  assert.deepEqual(saved.validationTargets, [
    { source: 'literal', value: 'u_1' }, { source: 'field', field: 'owner_id' },
  ]);
  assert.deepEqual(pageErrors, []);
});

test('records expose timed-out filtering and render escaped validation audit detail without reopen controls', async t => {
  const { page, pageErrors } = await withPage(t, async page => {
    const records = [
      {
        id: 'record-timeout', ruleId: 'rule-1', ruleName: 'GMV check', datasetName: 'Orders', severity: 'high',
        status: 'timed_out', occurredAt: '2026-08-22T09:00:00', field: 'gmv', value: 999, expected: 'gt',
        assignee: null,
      },
      {
        id: 'record-resolved', ruleId: 'rule-1', ruleName: 'GMV check', datasetName: 'Orders', severity: 'high',
        status: 'resolved', occurredAt: '2026-08-22T08:00:00', field: 'gmv', value: 999, expected: 'gt',
        assignee: null,
      },
    ];
    const detail = {
      ...records[1], description: '<img src=x onerror="window.auditInjected=true">',
      validationDeadline: '2026-08-22T09:30:00', timedOutAt: null, resolutionSource: 'validation',
      validationMethod: 'sql',
      resolvedByUserId: 'u_1', businessKey: { owner_id: 'u_1' }, details: { gmv: 999 }, hitCount: 1,
      lastSeenAt: '2026-08-22T09:10:00', deliveries: [{
        receive_id_type: 'open_id', recipient: 'ou_aborted', status: 'aborted', attempts: 0,
        message_id: null, last_error: '推送已由管理员中止',
      }], timeline: [],
      validationRequests: [{
        recipientUserId: 'u_1', deliveryStatus: 'resolved', deliveryAttempts: 2,
        messageId: 'om_1', lastError: null, deliveredAt: '2026-08-22T09:01:00',
      }, {
        recipientUserId: 'u_aborted', deliveryStatus: 'aborted', deliveryAttempts: 0,
        messageId: null, lastError: '推送已由管理员中止', deliveredAt: null,
      }],
      validationSubmission: {
        submittedByUserId: 'u_1', submittedText: '',
        validatorType: 'sql', result: 'passed', submittedAt: '2026-08-22T09:20:00',
        resultDetail: { field: 'status', operator: 'eq', value: 'normal', upperValue: null, actual: 'normal' },
      },
    };
    const timedOutDetail = {
      ...detail, ...records[0], description: 'Timed out validation', timedOutAt: '2026-08-22T09:30:01',
      resolutionSource: null, resolvedByUserId: null, validationSubmission: null,
      validationRequests: [{ ...detail.validationRequests[0], deliveryStatus: 'timed_out' }],
    };
    await page.evaluate(({ records, detail, timedOutDetail }) => {
      window.auditInjected = false;
      window.Store = {
        getRecords: () => records, getRules: () => [{ id: 'rule-1', name: 'GMV check' }],
        getRule: () => ({ id: 'rule-1' }),
        loadRecord: async id => id === 'record-timeout' ? timedOutDetail : detail,
        refresh: async () => {}, exportUrl: '/export',
      };
      window.App = { navigate: () => {} };
    }, { records, detail, timedOutDetail });
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'records.js') });
    await page.evaluate(() => RecordsModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  assert.equal(await page.getByText('已超时', { exact: true }).count() > 0, true);
  assert.equal(await page.locator('#cnt-timed-out').textContent(), '1');
  await page.click('[data-status="timed_out"]');
  assert.equal(await page.locator('tbody tr').count(), 1);
  assert.match(await page.locator('tbody tr').textContent(), /record-timeout/);
  await page.evaluate(() => RecordsModule.openDetail('record-timeout'));
  await page.locator('.drawer').waitFor();
  assert.equal(await page.locator('#d-mark-processing').count(), 0, 'timed-out detail cannot return to processing');
  assert.equal(await page.locator('#d-resolve').count(), 1, 'timed-out detail can still be resolved');
  await page.locator('.drawer .modal-close').click();
  await page.evaluate(() => RecordsModule.openDetail('record-resolved'));
  await page.locator('.drawer').waitFor();

  const drawerText = await page.locator('.drawer').textContent();
  assert.match(drawerText, /异常描述/);
  assert.match(drawerText, /截止时间/);
  assert.match(drawerText, /解决来源/);
  assert.match(drawerText, /u_1/);
  assert.match(drawerText, /SQL 校验/);
  assert.match(drawerText, /status/);
  assert.match(drawerText, /normal/);
  assert.match(drawerText, /resolved/);
  assert.equal(await page.getByText('已中止', { exact: true }).count(), 2);
  assert.equal(await page.evaluate(() => window.auditInjected), false);
  assert.equal(await page.locator('.drawer script, .drawer img').count(), 0);
  assert.equal(await page.locator('#d-mark-processing, #d-resolve').count(), 0);
  assert.equal(await page.locator('[data-id="record-resolved"][data-action="status"]').count(), 0);
  await page.locator('.drawer .modal-close').click();
  await page.click('[data-status="all"]');
  await page.locator('[data-id="record-resolved"].rec-row-check').check();
  assert.equal(
    await page.locator('[data-bulk="processing"]').count(),
    0,
    'bulk controls must not offer a reopen path when a resolved record is selected',
  );
  assert.deepEqual(pageErrors, []);
});

test('record list and anomaly detail hide expected conditions while SQL audit keeps its translated condition', async t => {
  const record = {
    id: 'record-operator', ruleId: 'rule-1', ruleName: 'Temperature check',
    datasetName: 'Cold chain', severity: 'high', status: 'pending',
    occurredAt: '2026-08-23T09:00:00', lastSeenAt: '2026-08-23T09:00:00',
    field: 'temperature', value: -10, expected: 'gte', assignee: null,
    description: '', businessKey: {}, details: { temperature: -10 }, hitCount: 1,
    validationDeadline: null, timedOutAt: null, resolutionSource: null,
    resolvedByUserId: null, validationMethod: 'sql', timeline: [], deliveries: [],
    validationRequests: [],
    validationSubmission: {
      submittedByUserId: 'validator', submittedText: '', validatorType: 'sql',
      result: 'failed', submittedAt: '2026-08-23T09:05:00',
      resultDetail: {
        field: 'status', operator: 'eq', value: 'normal', upperValue: null, actual: 'abnormal',
      },
    },
  };
  const { page, pageErrors } = await withPage(t, async page => {
    await page.evaluate(record => {
      window.Store = {
        isSuperuser: () => false,
        getStats: () => ({
          pendingRecords: 1, processingRecords: 0, timedOutRecords: 0,
          resolvedToday: 0, highAnomalies: 0,
        }),
        getRecords: () => [record], getRules: () => [], getRecord: () => record,
        getRule: () => ({ id: 'rule-1', name: 'Temperature check' }),
        loadRecordsPage: async () => ({ items: [record], total: 1, page: 1, pageSize: 10 }),
        loadRecord: async () => record,
        refresh: async () => {}, exportUrl: () => '/export',
      };
    }, record);
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'records.js') });
    await page.evaluate(() => RecordsModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  await page.locator('#rec-table tbody tr').waitFor();
  const listText = await page.locator('#rec-table').innerText();
  assert.doesNotMatch(listText, /预期|大于等于（≥）|\bgte\b/);
  assert.match(listText, /2026-08-23 17:00:00/);

  await page.evaluate(() => RecordsModule.openDetail('record-operator'));
  const detailText = await page.locator('.drawer').innerText();
  assert.match(detailText, /等于（=） normal/);
  assert.doesNotMatch(detailText, /实际值 \/ 预期值|大于等于（≥）|\beq\b|\bgte\b/);
  assert.equal(await page.locator('.section-title').evaluateAll(nodes => nodes.every(node => (
    node.firstElementChild?.tagName.toLowerCase() === 'svg'
  ))), true);
  assert.deepEqual(pageErrors, []);
});

test('manual resolution relies on the server resolver and refreshes the open detail', async t => {
  const { page, pageErrors } = await withPage(t, async page => {
    const pending = {
      id: 'record-1', ruleId: 'rule-1', ruleName: 'GMV check', datasetName: 'Orders', severity: 'high',
      status: 'pending', occurredAt: '2026-08-22T09:00:00', field: 'gmv', value: 999, expected: 'gt',
      assignee: null, description: 'Review', validationDeadline: null, timedOutAt: null,
      resolutionSource: null, resolvedByUserId: null, businessKey: {}, details: {}, hitCount: 1,
      lastSeenAt: '2026-08-22T09:00:00', deliveries: [], validationRequests: [], validationSubmission: null, timeline: [],
    };
    await page.evaluate(pending => {
      window.records = [pending]; window.updatePayload = null; window.loadCount = 0;
      window.Store = {
        getRecords: () => window.records, getRecords: () => window.records,
        getRules: () => [], getRule: () => null,
        refresh: async () => { throw new Error('detail action must rely on centralized Store.updateRecord refresh'); },
        exportUrl: '/export',
        loadRecord: async () => {
          window.loadCount += 1;
          return window.loadCount === 1 ? pending : {
            ...pending, status: 'resolved', resolutionSource: 'manual', resolvedByUserId: 'admin',
          };
        },
        updateRecord: async (_id, payload) => {
          window.updatePayload = payload;
          window.records = [{ ...pending, status: 'resolved', resolutionSource: 'manual', resolvedByUserId: 'admin' }];
        },
      };
      window.App = { navigate: () => {} };
    }, pending);
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'records.js') });
    await page.evaluate(() => RecordsModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  await page.evaluate(() => RecordsModule.openDetail('record-1'));
  await page.click('#d-resolve');
  await page.waitForFunction(() => window.loadCount === 2);
  assert.deepEqual(await page.evaluate(() => window.updatePayload), { status: 'resolved' });
  assert.match(await page.locator('.drawer').textContent(), /已解决/);
  assert.equal(await page.locator('#d-resolve, #d-mark-processing').count(), 0);
  assert.deepEqual(pageErrors, []);
});

async function openRealRecordsDeepLink(t, recordId) {
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>
    <div id="toast-container"></div><div id="sidebar"></div><div id="sidebar-backdrop"></div>
    <button id="sidebar-toggle"></button><div id="breadcrumb"><span class="crumb-current"></span></div>
    <span id="nav-anomaly-count"></span><div class="nav-item" data-route="records"></div><main id="page-root"></main>
  </body></html>`);
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'icons.js') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'components.js') });
  await page.evaluate(recordId => {
    location.hash = `#records/${recordId}`;
    const record = {
      id: 'record-uuid', ruleId: 'rule-1', ruleName: 'GMV check', datasetName: 'Orders', severity: 'high',
      status: 'pending', occurredAt: '2026-08-22T09:00:00', field: 'gmv', value: 999, expected: 'gt',
      assignee: null, description: 'Investigate GMV', validationDeadline: null, timedOutAt: null,
      resolutionSource: null, resolvedByUserId: null, businessKey: {}, details: { gmv: 999 }, hitCount: 1,
      lastSeenAt: '2026-08-22T09:00:00', deliveries: [], validationRequests: [], validationSubmission: null,
      timeline: [],
    };
    window.detailRequests = [];
    window.Store = {
      init: async () => {},
      getStats: () => ({ pendingRecords: 1, processingRecords: 0, timedOutRecords: 0, resolvedToday: 0 }),
      getRecords: () => [record], getRecord: () => record,
      getRules: () => [{ id: 'rule-1', name: 'GMV check' }], getRule: () => ({ id: 'rule-1' }),
      loadRecordsPage: async () => ({ items: [record], total: 1, page: 1, pageSize: 10 }),
      loadRecord: async id => {
        window.detailRequests.push(id);
        if (id !== record.id) throw new Error('record not found');
        return record;
      },
      refresh: async () => {}, exportUrl: '/export',
    };
  }, recordId);
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'records.js') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'app.js') });
  await page.locator('#rec-table tbody tr').waitFor();
  return { page, browser };
}

test('valid deep record hash loads real records module and opens fetched detail', async t => {
  const { page } = await openRealRecordsDeepLink(t, 'record-uuid');
  await page.locator('.drawer').waitFor();

  assert.deepEqual(await page.evaluate(() => window.detailRequests), ['record-uuid']);
  assert.match(await page.locator('.drawer').textContent(), /异常详情 · record-uuid/);
  assert.match(await page.locator('#rec-table tbody tr').textContent(), /record-uuid/);
});

test('unknown deep record hash keeps real records list and shows a toast', async t => {
  const { page } = await openRealRecordsDeepLink(t, 'missing-uuid');
  await page.getByText('详情加载失败', { exact: true }).waitFor();

  assert.deepEqual(await page.evaluate(() => window.detailRequests), ['missing-uuid']);
  assert.match(await page.locator('#rec-table tbody tr').textContent(), /record-uuid/);
  assert.equal(await page.locator('.drawer').count(), 0);
});

test('record tabs use overview totals and request status-filtered backend pages', async t => {
  const { page, pageErrors } = await withPage(t, async page => {
    await page.evaluate(() => {
      const makeRecord = (id, status) => ({
        id, ruleId: 'rule-1', ruleName: 'GMV check', datasetName: 'Orders', severity: 'high',
        status, occurredAt: '2026-08-22T09:00:00', field: 'gmv', value: 999,
        expected: 'gt', assignee: null,
      });
      window.recordQueries = [];
      window.currentPageRecords = [];
      window.Store = {
        getStats: () => ({
          pendingRecords: 12, processingRecords: 8, timedOutRecords: 27,
          resolvedToday: 23, highAnomalies: 4, pushInTransitAnomalies: 5,
        }),
        getRecords: () => window.currentPageRecords,
        getRules: () => [],
        loadRecordsPage: async query => {
          window.recordQueries.push({ ...query });
          const status = query.status || 'pending';
          window.currentPageRecords = [makeRecord(`record-${query.page}`, status)];
          return {
            items: window.currentPageRecords,
            total: query.status === 'timed_out' ? 27 : 70,
            page: query.page,
            pageSize: query.pageSize,
          };
        },
        refresh: async () => {}, exportUrl: '/export',
      };
    });
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'records.js') });
    await page.evaluate(() => RecordsModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.recordQueries.length), 1);
  assert.deepEqual(await page.evaluate(() => window.recordQueries[0]), {
    page: 1, pageSize: 10, status: null, pushStatus: null, severity: null, ruleId: null, search: '',
    sortKey: 'occurredAt', sortOrder: 'desc',
  });
  assert.equal(await page.locator('#cnt-all').textContent(), '70');
  assert.equal(await page.locator('#cnt-pending').textContent(), '12');
  assert.equal(await page.locator('#cnt-processing').textContent(), '8');
  assert.equal(await page.locator('#cnt-timed-out').textContent(), '27');
  assert.equal(await page.locator('#cnt-resolved').textContent(), '23');

  const allTab = page.getByRole('tab', { name: /^全部/ });
  const timedOutTab = page.getByRole('tab', { name: /^已超时/ });
  assert.equal(await allTab.getAttribute('aria-selected'), 'true');
  await timedOutTab.click();
  await page.waitForFunction(() => window.recordQueries.length === 2);
  assert.equal(await allTab.getAttribute('aria-selected'), 'false');
  assert.equal(await timedOutTab.getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#rec-count-text').textContent(), '共 27 条记录');
  assert.equal(await page.evaluate(() => window.recordQueries[1].status), 'timed_out');
  await page.click('.page-btn[data-page="2"]');
  await page.waitForFunction(() => window.recordQueries.length === 3);
  assert.deepEqual(await page.evaluate(() => window.recordQueries[2]), {
    page: 2, pageSize: 10, status: 'timed_out', pushStatus: null, severity: null, ruleId: null, search: '',
    sortKey: 'occurredAt', sortOrder: 'desc',
  });
  assert.equal(await timedOutTab.getAttribute('aria-controls'), 'rec-table');
  assert.equal(await page.locator('#rec-table').getAttribute('role'), 'tabpanel');
  assert.equal(await page.locator('#rec-table').getAttribute('aria-labelledby'), await timedOutTab.getAttribute('id'));
  await timedOutTab.press('End');
  await page.waitForFunction(() => window.recordQueries.length === 4);
  assert.equal(await page.getByRole('tab', { name: /^已解决/ }).getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: /^已解决/ }).press('Home');
  await page.waitForFunction(() => window.recordQueries.length === 5);
  assert.equal(await allTab.getAttribute('aria-selected'), 'true');
  assert.deepEqual(pageErrors, []);
});

test('record KPI cards apply their corresponding status and severity filters', async t => {
  const { page, pageErrors } = await withPage(t, async page => {
    await page.evaluate(() => {
      const record = {
        id: 'record-1', ruleId: 'rule-1', ruleName: 'GMV check', datasetName: 'Orders', severity: 'high',
        status: 'pending', occurredAt: '2026-08-22T09:00:00', field: 'gmv', value: 999,
        expected: 'gt', assignee: null,
      };
      window.recordQueries = [];
      window.highCountQueries = [];
      window.Store = {
        getStats: () => ({
          pendingRecords: 12, processingRecords: 8, timedOutRecords: 2,
          resolvedToday: 23, highAnomalies: 4, pushInTransitAnomalies: 5,
        }),
        getRecords: () => [record],
        getRules: () => [{ id: 'rule-1', name: 'GMV check' }],
        loadRecordsPage: async query => {
          window.recordQueries.push({ ...query });
          return {
            items: query.pushStatus ? [] : [record],
            total: query.pushStatus ? 0 : 1,
            page: 1,
            pageSize: 10,
          };
        },
        peekRecordsPage: async query => {
          window.highCountQueries.push({ ...query });
          return { items: [], total: 7, page: 1, pageSize: query.pageSize };
        },
        refresh: async () => {}, exportUrl: '/export',
      };
    });
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'records.js') });
    await page.evaluate(() => RecordsModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  const inTransitCard = page.getByRole('button', { name: /筛选推送途中异常.*5/ });
  await inTransitCard.click();
  await page.waitForTimeout(20);
  assert.equal(await inTransitCard.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#rec-stats').evaluate(node => node.classList.contains('six-up')), true);
  assert.equal(await page.evaluate(() => window.recordQueries.at(-1).pushStatus), 'in_transit');
  assert.equal(await page.evaluate(() => window.recordQueries.at(-1).status), null);
  assert.equal(await page.evaluate(() => window.recordQueries.at(-1).severity), null);
  assert.match(await page.locator('#rec-table').innerText(), /当前没有推送途中的异常/);

  await page.getByRole('button', { name: /筛选未处理异常.*12/ }).click();
  await page.waitForTimeout(20);
  assert.equal(await page.getByRole('tab', { name: /^未处理/ }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.evaluate(() => window.recordQueries.at(-1).status), 'pending');
  assert.equal(await page.evaluate(() => window.recordQueries.at(-1).pushStatus), null);
  assert.equal(await inTransitCard.getAttribute('aria-pressed'), 'false');

  await page.getByRole('button', { name: /筛选高严重程度异常.*7/ }).click();
  await page.waitForTimeout(20);
  assert.equal(await page.getByRole('tab', { name: /^全部/ }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#rec-severity-filter').inputValue(), 'high');
  assert.equal(await page.evaluate(() => window.recordQueries.at(-1).severity), 'high');
  assert.equal(await page.evaluate(() => window.recordQueries.at(-1).status), null);
  assert.deepEqual(await page.evaluate(() => window.highCountQueries[0]), {
    severity: 'high', page: 1, pageSize: 1,
  });
  assert.deepEqual(pageErrors, []);
});

test('late high KPI counts preserve focus and do not update after records unmounts', async t => {
  const { page, pageErrors } = await withPage(t, async page => {
    await page.evaluate(() => {
      let resolveCount;
      window.resolveHighCount = total => resolveCount({ items: [], total, page: 1, pageSize: 1 });
      window.Store = {
        getStats: () => ({ pendingRecords: 1, processingRecords: 0, timedOutRecords: 0, resolvedToday: 0, highAnomalies: 0 }),
        getRecords: () => [], getRules: () => [],
        loadRecordsPage: async () => ({ items: [], total: 0, page: 1, pageSize: 10 }),
        peekRecordsPage: () => new Promise(resolve => { resolveCount = resolve; }),
        refresh: async () => {}, exportUrl: '/export',
      };
    });
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'records.js') });
    await page.evaluate(() => RecordsModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  const highCard = page.getByRole('button', { name: /筛选高严重程度异常，正在统计数量/ });
  await highCard.focus();
  await page.evaluate(() => window.resolveHighCount(9));
  await page.getByRole('button', { name: /筛选高严重程度异常，共 9 条/ }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.filterSeverity), 'high');

  await page.evaluate(() => {
    RecordsModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    });
    document.getElementById('content').innerHTML = '<main id="replacement">其他模块</main>';
    window.resolveHighCount(11);
  });
  await page.waitForTimeout(20);
  assert.equal(await page.locator('#replacement').textContent(), '其他模块');
  assert.deepEqual(pageErrors, []);
});

test('mobile records render as readable summary cards that open the existing detail drawer', async t => {
  const { page, pageErrors } = await withPage(t, async page => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const file of ['base.css', 'layout.css', 'components.css', 'pages.css']) {
      await page.addStyleTag({ path: path.join(frontendRoot, 'styles', file) });
    }
    await page.evaluate(() => {
      const record = {
        id: 'record-mobile', ruleId: 'rule-1', ruleName: '门店 GMV 异常', datasetName: '门店日经营',
        severity: 'high', status: 'pending', occurredAt: '2026-08-22 09:00', field: 'gmv', value: 999,
        expected: 'gt 500', assignee: '沈一鸣', description: '检查门店营业额', validationDeadline: null,
        timedOutAt: null, resolutionSource: null, resolvedByUserId: null, businessKey: {}, details: { gmv: 999 },
        hitCount: 1, lastSeenAt: '2026-08-22 09:00', deliveries: [], validationRequests: [],
        validationSubmission: null, timeline: [],
      };
      window.Store = {
        getStats: () => ({ pendingRecords: 1, processingRecords: 0, timedOutRecords: 0, resolvedToday: 0, highAnomalies: 1 }),
        getRecords: () => [record], getRules: () => [{ id: 'rule-1', name: '门店 GMV 异常' }],
        getRecord: id => id === record.id ? record : null, getRule: () => null,
        loadRecord: async id => id === record.id ? record : Promise.reject(new Error('not found')),
        loadRecordsPage: async () => ({ items: [record], total: 1, page: 1, pageSize: 10 }),
        refresh: async () => {}, exportUrl: '/export',
      };
    });
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'records.js') });
    await page.evaluate(() => RecordsModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  const card = page.getByRole('button', { name: /门店 GMV 异常.*gmv.*999.*沈一鸣/ });
  await card.waitFor();
  assert.equal(await page.locator('.record-mobile-list').isVisible(), true);
  assert.equal(await page.locator('.table-wrap').isVisible(), false);
  await card.click();
  await page.locator('.drawer').waitFor();
  assert.match(await page.locator('.drawer').innerText(), /record-mobile/);
  assert.deepEqual(pageErrors, []);
});

test('mobile records retain pagination after a desktop row selection', async t => {
  const { page, pageErrors } = await withPage(t, async page => {
    await page.setViewportSize({ width: 900, height: 800 });
    for (const file of ['base.css', 'layout.css', 'components.css', 'pages.css']) {
      await page.addStyleTag({ path: path.join(frontendRoot, 'styles', file) });
    }
    await page.evaluate(() => {
      const record = {
        id: 'record-selected', ruleId: 'rule-1', ruleName: 'GMV check', datasetName: 'Orders',
        severity: 'high', status: 'pending', occurredAt: '2026-08-22 09:00', field: 'gmv', value: 999,
        expected: 'gt 500', assignee: null,
      };
      window.Store = {
        getStats: () => ({ pendingRecords: 20, processingRecords: 0, timedOutRecords: 0, resolvedToday: 0, highAnomalies: 0 }),
        getRecords: () => [record], getRules: () => [],
        loadRecordsPage: async query => ({ items: [record], total: 20, page: query.page, pageSize: query.pageSize }),
        refresh: async () => {}, exportUrl: '/export',
      };
    });
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'records.js') });
    await page.evaluate(() => RecordsModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  await page.locator('.rec-row-check').evaluate(input => input.click());
  assert.equal(await page.locator('.record-mobile-pagination').count(), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('.record-mobile-pagination').isVisible(), true);
  assert.equal(await page.locator('.record-mobile-pagination').getByRole('button', { name: '2', exact: true }).count(), 1);
  assert.deepEqual(pageErrors, []);
});

test('record search debounces rapid typing into one server request', async t => {
  const { page, pageErrors } = await withPage(t, async page => {
    await page.evaluate(() => {
      window.recordQueries = [];
      window.Store = {
        getStats: () => ({ pendingRecords: 0, processingRecords: 0, timedOutRecords: 0, resolvedToday: 0, highAnomalies: 0 }),
        getRecords: () => [],
        getRules: () => [],
        loadRecordsPage: async query => {
          window.recordQueries.push({ ...query });
          return { items: [], total: 0, page: 1, pageSize: query.pageSize };
        },
        refresh: async () => {}, exportUrl: '/export',
      };
    });
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'records.js') });
    await page.evaluate(() => RecordsModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  await page.waitForFunction(() => window.recordQueries.length === 1);
  await page.locator('#rec-search').fill('a');
  await page.locator('#rec-search').fill('ab');
  await page.locator('#rec-search').fill('abc');
  await page.waitForTimeout(350);

  assert.equal(await page.evaluate(() => window.recordQueries.length), 2);
  assert.equal(await page.evaluate(() => window.recordQueries.at(-1).search), 'abc');
  await page.getByRole('button', { name: '清空搜索' }).click();
  await page.waitForTimeout(350);
  assert.equal(await page.locator('#rec-search').inputValue(), '');
  assert.equal(await page.evaluate(() => window.recordQueries.at(-1).search), '');
  assert.deepEqual(pageErrors, []);
});

test('record export sends current server filters and reports the server total', async t => {
  const { page, pageErrors } = await withPage(t, async page => {
    await page.evaluate(() => {
      const record = {
        id: 'record-page-item', ruleId: 'rule-1', ruleName: 'GMV check', datasetName: 'Orders',
        severity: 'high', status: 'pending', occurredAt: '2026-08-22T09:00:00',
        field: 'gmv', value: 999, expected: 'gt', assignee: null,
      };
      window.currentPageRecords = [record];
      window.exportFilters = null;
      const exportUrl = filters => {
        window.exportFilters = { ...filters };
        return '#export';
      };
      exportUrl.toString = () => '#export';
      window.Store = {
        getStats: () => ({ pendingRecords: 42, processingRecords: 0, timedOutRecords: 0, resolvedToday: 0, highAnomalies: 0 }),
        getRecords: () => window.currentPageRecords,
        getRules: () => [],
        loadRecordsPage: async query => ({
          items: window.currentPageRecords,
          total: query.search ? 3 : 42,
          page: 1,
          pageSize: query.pageSize,
        }),
        peekRecordsPage: async query => ({
          items: window.currentPageRecords,
          total: query.search ? 3 : 42,
          page: 1,
          pageSize: query.pageSize,
        }),
        refresh: async () => {}, exportUrl,
      };
    });
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'records.js') });
    await page.evaluate(() => RecordsModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  await page.locator('.rec-row-check[data-id="record-page-item"]').waitFor();
  await page.locator('#rec-search').fill('new');
  await page.click('#rec-export');
  await page.waitForFunction(() => window.exportFilters !== null);

  assert.deepEqual(await page.evaluate(() => window.exportFilters), {
    status: null, pushStatus: null, severity: null, ruleId: null, search: 'new',
    sortKey: 'occurredAt', sortOrder: 'desc',
  });
  assert.match(await page.locator('#toast-container').textContent(), /3 条记录/);
  assert.deepEqual(pageErrors, []);
});

test('record export keeps one immutable search snapshot while its count request is pending', async t => {
  const { page, pageErrors } = await withPage(t, async page => {
    await page.evaluate(() => {
      window.exportFilters = null;
      window.resolveExportCount = null;
      const exportUrl = filters => {
        window.exportFilters = { ...filters };
        return '#export-snapshot';
      };
      exportUrl.toString = () => '#export-snapshot';
      window.Store = {
        getStats: () => ({ pendingRecords: 0, processingRecords: 0, timedOutRecords: 0, resolvedToday: 0, highAnomalies: 0 }),
        getRecords: () => [],
        getRules: () => [],
        loadRecordsPage: async query => {
          return { items: [], total: query.search === 'new-filter' ? 2 : 0, page: 1, pageSize: query.pageSize };
        },
        peekRecordsPage: async query => {
          if (query.search === 'old-filter') {
            return new Promise(resolve => { window.resolveExportCount = resolve; });
          }
          return { items: [], total: query.search === 'new-filter' ? 2 : 0, page: 1, pageSize: query.pageSize };
        },
        refresh: async () => {}, exportUrl,
      };
    });
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'records.js') });
    await page.evaluate(() => RecordsModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  await page.locator('#rec-search').fill('old-filter');
  await page.click('#rec-export');
  await page.waitForFunction(() => typeof window.resolveExportCount === 'function');
  await page.locator('#rec-search').fill('new-filter');
  await page.evaluate(() => window.resolveExportCount({
    items: [], total: 7, page: 1, pageSize: 10,
  }));
  await page.waitForFunction(() => window.exportFilters !== null);

  assert.equal(await page.evaluate(() => window.exportFilters.search), 'old-filter');
  assert.match(await page.locator('#toast-container').textContent(), /7 条记录/);
  assert.deepEqual(pageErrors, []);
});

test('production Store export on page two preserves the rendered record and its quick action target', async t => {
  const { page, pageErrors } = await withPage(t, async page => {
    await page.evaluate(() => {
      const apiRecord = (id, status) => ({
        id, rule_id: 'rule-1', rule_name: 'GMV check', dataset_name: 'Orders', severity: 'high', status,
        business_key: {}, row_details: {}, matched_conditions: [{ field: 'gmv', operator: 'gt', actual: 999 }],
        hit_count: 1, first_seen_at: '2026-08-22T09:00:00', last_seen_at: '2026-08-22T09:00:00',
        resolved_at: status === 'resolved' ? '2026-08-22T10:00:00' : null,
        assignee: null, description: '', validation_deadline: null,
        timed_out_at: status === 'timed_out' ? '2026-08-22T09:30:00' : null,
        resolution_source: status === 'resolved' ? 'manual' : null,
        resolved_by_user_id: status === 'resolved' ? 'admin' : null,
        delivery_status: 'none', timeline: [], deliveries: [], validation_requests: [],
        validation_submission: null,
      });
      window.pageTwoStatus = 'timed_out';
      window.quickPatchIds = [];
      window.exportFilters = null;
      window.fetch = async (input, options = {}) => {
        const url = new URL(String(input), 'http://sentinel.test');
        const method = options.method || 'GET';
        const jsonResponse = body => ({
          ok: true, status: 200, statusText: 'OK', json: async () => body,
        });
        if (method === 'PATCH' && url.pathname.endsWith('/status')) {
          const id = url.pathname.split('/').at(-2);
          window.quickPatchIds.push(id);
          window.pageTwoStatus = JSON.parse(options.body).status;
          return jsonResponse(apiRecord(id, window.pageTwoStatus));
        }
        if (url.pathname.endsWith('/overview')) {
          return jsonResponse({ stats: {
            pending_records: 10, processing_records: 0,
            timed_out_records: window.pageTwoStatus === 'timed_out' ? 1 : 0,
            resolved_records: window.pageTwoStatus === 'resolved' ? 1 : 0,
            high_anomalies: 0,
          } });
        }
        if (url.pathname.endsWith('/anomalies')) {
          const requestedPage = Number(url.searchParams.get('page') || 1);
          const item = requestedPage === 2
            ? apiRecord('record-page-two', window.pageTwoStatus)
            : apiRecord('record-page-one', 'pending');
          return jsonResponse({ items: [item], total: 11, page: requestedPage, page_size: 10 });
        }
        throw new Error(`unexpected request: ${method} ${url.pathname}`);
      };
    });
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'data.js') });
    await page.evaluate(() => {
      Store.exportUrl = filters => {
        window.exportFilters = { ...filters };
        return '#production-export';
      };
    });
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'records.js') });
    await page.evaluate(() => RecordsModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  await page.locator('.record-desktop-table').getByText('record-page-one', { exact: true }).waitFor();
  await page.locator('.page-btn[data-page="2"]:not([aria-label])').click();
  await page.locator('.record-desktop-table').getByText('record-page-two', { exact: true }).waitFor();
  await page.click('#rec-export');
  await page.waitForFunction(() => window.exportFilters !== null);

  assert.equal(await page.locator('.record-desktop-table').getByText('record-page-two', { exact: true }).count(), 1);
  assert.deepEqual(await page.evaluate(() => Store.getRecords().map(record => record.id)), ['record-page-two']);

  await page.locator('[data-id="record-page-two"][data-action="status"]').click();
  await page.locator('[role="dialog"] [data-status="resolved"]').click();
  await page.waitForFunction(() => window.quickPatchIds.length === 1);

  assert.deepEqual(await page.evaluate(() => window.quickPatchIds), ['record-page-two']);
  assert.equal(await page.evaluate(() => Store.getRecord('record-page-two').status), 'resolved');
  assert.deepEqual(pageErrors, []);
});

test('selection is scoped to the current server result and never leaks into a later bulk request', async t => {
  const { page, pageErrors } = await withPage(t, async page => {
    await page.evaluate(() => {
      const makeRecord = (id, ruleName) => ({
        id, ruleId: 'rule-1', ruleName, datasetName: 'Orders', severity: 'high',
        status: 'pending', occurredAt: '2026-08-22T09:00:00', field: 'amount',
        value: 999, expected: 'gt', assignee: null,
      });
      window.currentPageRecords = [];
      window.bulkCalls = [];
      window.Store = {
        getStats: () => ({ pendingRecords: 2, processingRecords: 0, timedOutRecords: 0, resolvedToday: 0, highAnomalies: 0 }),
        getRecords: () => window.currentPageRecords,
        getRules: () => [],
        loadRecordsPage: async query => {
          window.currentPageRecords = query.search
            ? [makeRecord('record-new', 'new rule')]
            : [makeRecord('record-old', 'old rule')];
          return { items: window.currentPageRecords, total: 1, page: 1, pageSize: 10 };
        },
        bulkUpdateRecords: async (ids, status) => { window.bulkCalls.push({ ids, status }); },
        refresh: async () => {}, exportUrl: '/export',
      };
    });
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'records.js') });
    await page.evaluate(() => RecordsModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  await page.locator('[data-id="record-old"].rec-row-check').check();
  await page.locator('#rec-search').fill('new');
  await page.locator('[data-id="record-new"].rec-row-check').waitFor();
  assert.equal(await page.locator('#rec-clear-sel').count(), 0, 'changing the result set clears old selection');

  await page.locator('[data-id="record-new"].rec-row-check').check();
  await page.click('[data-bulk="resolved"]');
  await page.waitForFunction(() => window.bulkCalls.length === 1);
  assert.deepEqual(await page.evaluate(() => window.bulkCalls[0]), {
    ids: ['record-new'], status: 'resolved',
  });
  assert.deepEqual(pageErrors, []);
});

test('resolving the final item on the final page refetches the nearest valid page', async t => {
  const { page, pageErrors } = await withPage(t, async page => {
    await page.evaluate(() => {
      const makeRecord = (id, status) => ({
        id, ruleId: 'rule-1', ruleName: 'GMV check', datasetName: 'Orders', severity: 'high',
        status, occurredAt: '2026-08-22T09:00:00', field: 'gmv', value: 999,
        expected: 'gt', assignee: null,
      });
      window.recordQueries = [];
      window.currentPageRecords = [];
      window.finalResolved = false;
      window.Store = {
        getStats: () => ({ pendingRecords: 10, processingRecords: 0, timedOutRecords: window.finalResolved ? 0 : 1, resolvedToday: window.finalResolved ? 1 : 0, highAnomalies: 0 }),
        getRecords: () => window.currentPageRecords,
        getRecord: id => window.currentPageRecords.find(record => record.id === id),
        getRules: () => [],
        loadRecordsPage: async query => {
          window.recordQueries.push({ ...query });
          if (query.page === 2 && !window.finalResolved) {
            window.currentPageRecords = [makeRecord('record-final', 'timed_out')];
            return { items: window.currentPageRecords, total: 11, page: 2, pageSize: 10 };
          }
          if (query.page === 2) {
            window.currentPageRecords = [];
            return { items: [], total: 10, page: 2, pageSize: 10 };
          }
          window.currentPageRecords = [makeRecord('record-first-page', 'pending')];
          return { items: window.currentPageRecords, total: window.finalResolved ? 10 : 11, page: 1, pageSize: 10 };
        },
        updateRecord: async () => { window.finalResolved = true; },
        refresh: async () => {}, exportUrl: '/export',
      };
    });
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'records.js') });
    await page.evaluate(() => RecordsModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  await page.locator('.page-btn[data-page="2"]:not([aria-label])').click();
  await page.locator('[data-id="record-final"][data-action="status"]').click();
  await page.locator('[role="dialog"] [data-status="resolved"]').click();
  await page.locator('.record-desktop-table').getByText('record-first-page', { exact: true }).waitFor();

  assert.deepEqual(await page.evaluate(() => window.recordQueries.map(query => query.page)), [1, 2, 2, 1]);
  assert.equal(await page.locator('[data-id="record-final"].rec-row-check').count(), 0);
  assert.deepEqual(pageErrors, []);
});

test('quick status resolution refreshes list classifications and the navigation count', async t => {
  const { page, pageErrors } = await withPage(t, async page => {
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('afterbegin', '<span id="nav-anomaly-count">1</span>');
      window.summaryStats = {
        pendingRecords: 0, processingRecords: 0, timedOutRecords: 1,
        resolvedToday: 0, highAnomalies: 0, unresolvedRecords: 1,
      };
      window.currentRecord = {
        id: 'record-timeout', ruleId: 'rule-1', ruleName: 'GMV check', datasetName: 'Orders',
        severity: 'high', status: 'timed_out', occurredAt: '2026-08-22T09:00:00',
        field: 'gmv', value: 999, expected: 'gt', assignee: null,
      };
      window.Store = {
        getStats: () => window.summaryStats,
        getRecords: () => [window.currentRecord], getRecord: () => window.currentRecord, getRules: () => [],
        loadRecordsPage: async () => ({ items: [window.currentRecord], total: 1, page: 1, pageSize: 10 }),
        updateRecord: async (_id, payload) => {
          window.currentRecord = { ...window.currentRecord, status: payload.status };
          window.summaryStats = {
            ...window.summaryStats, timedOutRecords: 0, resolvedToday: 1, unresolvedRecords: 0,
          };
          return window.currentRecord;
        },
        refresh: async () => {}, exportUrl: '/export',
      };
    });
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'records.js') });
    await page.evaluate(() => RecordsModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  await page.locator('[data-action="status"]').waitFor();
  await page.click('[data-action="status"]');
  await page.click('[role="dialog"] [data-status="resolved"]');
  await page.waitForFunction(() => document.getElementById('cnt-resolved').textContent === '1');
  assert.equal(await page.locator('#cnt-timed-out').textContent(), '0');
  assert.equal(await page.locator('#nav-anomaly-count').textContent(), '0');
  assert.equal(await page.locator('[data-id="record-timeout"][data-action="status"]').count(), 0);
  assert.deepEqual(pageErrors, []);
});

test('abort push action is left of export, confirms danger, and prevents duplicate requests', async t => {
  const { page, pageErrors } = await withPage(t, async page => {
    await page.evaluate(() => {
      window.abortCalls = 0;
      window.resolveAbort = null;
      window.Store = {
        isSuperuser: () => true,
        getStats: () => ({ pendingRecords: 0, processingRecords: 0, timedOutRecords: 0, resolvedToday: 0, highAnomalies: 0 }),
        getRecords: () => [], getRules: () => [],
        loadRecordsPage: async () => ({ items: [], total: 0, page: 1, pageSize: 10 }),
        abortAnomalyPushes: () => {
          window.abortCalls += 1;
          return new Promise(resolve => { window.resolveAbort = resolve; });
        },
        refresh: async () => {}, exportUrl: '/export',
      };
    });
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'records.js') });
    await page.evaluate(() => RecordsModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  assert.deepEqual(await page.locator('#actions button').evaluateAll(items => items.map(item => item.id)), [
    'rec-recover-push', 'rec-abort-push', 'rec-clear-in-transit', 'rec-export', 'rec-refresh',
  ]);
  await page.click('#rec-abort-push');
  assert.match(await page.locator('[role="dialog"]').innerText(), /已发送消息无法撤回/);
  await page.locator('[role="dialog"] [data-action="cancel"]').click();
  assert.equal(await page.evaluate(() => window.abortCalls), 0);
  await page.click('#rec-abort-push');
  await page.locator('[role="dialog"] [data-action="confirm"]').click();
  await page.waitForFunction(() => window.abortCalls === 1);
  assert.equal(await page.locator('#rec-abort-push').isDisabled(), true);
  await page.evaluate(() => window.resolveAbort({
    status: 'completed', aborted_jobs: 3, stopped_ds_instances: 2,
    deleted_ds_instances: 2, cleared_kafka_partitions: 1, errors: [],
  }));
  await page.getByText('推送积压已中止', { exact: true }).waitFor();
  assert.equal(await page.locator('#rec-abort-push').isDisabled(), false);
  assert.equal(await page.evaluate(() => window.abortCalls), 1);
  assert.deepEqual(pageErrors, []);
});

test('recover push action confirms scope, prevents duplicates, and reports recovery summary', async t => {
  const { page, pageErrors } = await withPage(t, async page => {
    await page.evaluate(() => {
      window.recoverCalls = 0;
      window.resolveRecovery = null;
      window.Store = {
        isSuperuser: () => true,
        getStats: () => ({ pendingRecords: 0, processingRecords: 0, timedOutRecords: 0, resolvedToday: 0, highAnomalies: 0 }),
        getRecords: () => [], getRules: () => [],
        loadRecordsPage: async () => ({ items: [], total: 0, page: 1, pageSize: 10 }),
        recoverAnomalyPushes: () => {
          window.recoverCalls += 1;
          return new Promise(resolve => { window.resolveRecovery = resolve; });
        },
        abortAnomalyPushes: async () => ({}),
        refresh: async () => { throw new Error('refresh unavailable'); }, exportUrl: '/export',
      };
    });
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'records.js') });
    await page.evaluate(() => RecordsModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  await page.click('#rec-recover-push');
  assert.match(await page.locator('[role="dialog"]').innerText(), /只恢复可安全重试/);
  await page.locator('[role="dialog"] [data-action="confirm"]').click();
  await page.waitForFunction(() => window.recoverCalls === 1);
  assert.equal(await page.locator('#rec-recover-push').isDisabled(), true);
  assert.equal(await page.evaluate(() => window.recoverCalls), 1);
  await page.evaluate(() => window.resolveRecovery({
    status: 'completed', requeued_jobs: 3, skipped_jobs: 2,
    requeued_by_kind: { notification: 1, validation: 1, group_broadcast: 1 }, errors: [],
  }));
  await page.getByText('失败推送已恢复', { exact: true }).waitFor();
  assert.equal(await page.getByText('失败推送恢复失败', { exact: true }).count(), 0);
  assert.equal(await page.locator('#rec-recover-push').isDisabled(), false);
  assert.deepEqual(pageErrors, []);
});

test('record administrative actions fit the mobile viewport without clipping', async t => {
  const { page, pageErrors } = await withPage(t, async page => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addStyleTag({ path: path.join(frontendRoot, 'styles', 'base.css') });
    await page.addStyleTag({ path: path.join(frontendRoot, 'styles', 'components.css') });
    await page.addStyleTag({ path: path.join(frontendRoot, 'styles', 'layout.css') });
    await page.evaluate(() => {
      const actions = document.getElementById('actions');
      actions.className = 'page-actions';
      document.getElementById('content').innerHTML = '<div class="page"><div class="page-header" id="mobile-header"></div><div id="mobile-content"></div></div>';
      document.getElementById('mobile-header').append(actions);
      window.Store = {
        isSuperuser: () => true,
        getStats: () => ({ pendingRecords: 0, processingRecords: 0, timedOutRecords: 0, resolvedToday: 0, highAnomalies: 0 }),
        getRecords: () => [], getRules: () => [],
        loadRecordsPage: async () => ({ items: [], total: 0, page: 1, pageSize: 10 }),
        recoverAnomalyPushes: async () => ({}), abortAnomalyPushes: async () => ({}),
        refresh: async () => {}, exportUrl: '/export',
      };
    });
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'records.js') });
    await page.evaluate(() => RecordsModule.render(document.getElementById('mobile-content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  assert.deepEqual(await page.locator('#actions').evaluate(element => {
    const style = getComputedStyle(element);
    return [style.display, style.gridTemplateColumns.split(' ').length];
  }), ['grid', 2]);
  assert.equal(await page.locator('#actions').evaluate(element => element.getBoundingClientRect().right <= innerWidth), true);
  assert.equal(await page.getByRole('button', { name: '刷新' }).isVisible(), true);
  assert.deepEqual(pageErrors, []);
});

test('rule form configures one SQL validation method with mapped anomaly fields', async t => {
  const { page, pageErrors } = await withPage(t, async page => {
    await page.evaluate(dataset => {
      window.createdRule = null;
      window.Store = {
        getRules: () => [], getDatasets: () => [dataset],
        getDataset: id => id === dataset.id ? dataset : null,
        addRule: async payload => { window.createdRule = payload; },
      };
    }, datasetFixture());
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'rules.js') });
    await page.evaluate(() => RulesModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  await page.click('#r-add');
  await page.fill('#f-name', 'SQL validation rule');
  await page.getByRole('tab', { name: '关联数据集', exact: true }).click();
  await page.selectOption('#f-dataset', 'dataset-1');
  await page.click('#f-key-fields');
  await page.locator('#f-key-fields-listbox [data-key-field="order_id"]').click();
  await page.getByRole('tab', { name: '异常条件', exact: true }).click();
  await page.selectOption('.condition-row [data-c="field"]', 'amount');
  await page.fill('.condition-row [data-c="value"]', '100');
  await page.getByRole('tab', { name: '私聊通知', exact: true }).click();
  await page.fill('#f-openids-input', 'ou_notify');
  await page.getByRole('tab', { name: '实时校验', exact: true }).click();
  await page.check('#f-validation-enabled');
  await page.getByRole('tab', { name: '实时校验', exact: true }).click();
  await page.fill('#f-validation-userids-input', 'validator-1');
  await page.getByRole('tab', { name: '实时校验', exact: true }).click();
  await page.click('[data-validation-method="sql"]');
  assert.equal(await page.locator('#f-sql-validation-panel').isVisible(), true);
  await page.fill('#f-validation-sql', "SELECT current_amount FROM repair_state WHERE order_id='{订单ID}'");
  await page.click('#f-add-sql-parameter');
  const mapping = page.locator('.sql-parameter-row').last();
  await mapping.locator('[data-sql-param="name"]').fill('订单ID');
  await mapping.locator('[data-sql-param="field"]').selectOption('order_id');
  await page.fill('#f-sql-result-field', 'current_amount');
  await page.selectOption('#f-sql-operator', 'lt');
  await page.fill('#f-sql-value', '100');
  await page.click('#f-save');
  await page.waitForTimeout(25);

  const created = await page.evaluate(() => window.createdRule);
  assert.equal(created.validationMethod, 'sql');
  assert.deepEqual(created.sqlValidationConfig, {
    queryTemplate: "SELECT current_amount FROM repair_state WHERE order_id='{订单ID}'",
    parameters: [{ name: '订单ID', field: 'order_id' }],
    trueCondition: { field: 'current_amount', operator: 'lt', value: 100, upperValue: null, valueSource: 'literal', valueField: null, upperValueSource: 'literal', upperValueField: null },
  });
  assert.deepEqual(created.validationTargets, [{ source: 'literal', value: 'validator-1' }]);
  assert.deepEqual(pageErrors, []);
});

test('abort push action is hidden from non-superadmin readers', async t => {
  const { page, pageErrors } = await withPage(t, async page => {
    await page.evaluate(() => {
      window.Store = {
        isSuperuser: () => false,
        getStats: () => ({ pendingRecords: 0, processingRecords: 0, timedOutRecords: 0, resolvedToday: 0, highAnomalies: 0 }),
        getRecords: () => [], getRules: () => [],
        loadRecordsPage: async () => ({ items: [], total: 0, page: 1, pageSize: 10 }),
        refresh: async () => {}, exportUrl: '/export',
      };
    });
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'records.js') });
    await page.evaluate(() => RecordsModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }));
  });

  assert.equal(await page.locator('#rec-abort-push').count(), 0);
  assert.equal(await page.locator('#rec-recover-push').count(), 0);
  assert.equal(await page.locator('#rec-clear-in-transit').count(), 0);
  assert.deepEqual(await page.locator('#actions button').evaluateAll(items => items.map(item => item.id)), [
    'rec-export', 'rec-refresh',
  ]);
  assert.deepEqual(pageErrors, []);
});

test('record detail shows resolved field comparisons and last failed SQL audit without rendering unrelated SQL data', async t => {
  const { page, pageErrors } = await withPage(t, async page => {
    await page.evaluate(() => {
      const record = {
        id: 'audit-fields', ruleName: 'Compare', status: 'pending', severity: 'high', details: {}, businessKey: {},
        field: 'actual', value: 15, deliveries: [], timeline: [],
        matchedConditions: [{ field: 'actual', operator: 'between', actual: 15, value_source: 'field', value_field: '<low>', resolved_value: 10, upper_value_source: 'field', upper_value_field: 'high', resolved_upper_value: 20 }],
        lastSqlValidationResult: { outcome: 'failed', reason: '比较未通过', operatorUserId: 'validator', checkedAt: '2026-08-28T01:00:00Z', resultDetail: { field: 'actual', operator: 'gt', actual: 15, valueSource: 'field', valueField: 'limit', resolvedValue: 20 } },
      };
      window.Store = { loadRecord: async () => record, getRule: () => null };
    });
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'records.js') });
  });
  await page.evaluate(() => RecordsModule.openDetail('audit-fields'));
  const text = await page.locator('.drawer').textContent();
  assert.match(text, /<low>.*10/);
  assert.match(text, /high.*20/);
  assert.match(text, /最近 SQL 校验/);
  assert.match(text, /比较未通过/);
  assert.match(text, /limit.*20/);
  assert.equal(await page.locator('.drawer low').count(), 0);
  assert.deepEqual(pageErrors, []);
});

for (const outcome of ['success', 'request-failure', 'refresh-failure', 'list-failure']) {
  test(`clear in-transit action confirms global scope and handles ${outcome}`, async t => {
    const { page, pageErrors } = await withPage(t, async page => {
      await page.evaluate(outcome => {
        window.clearCalls = 0;
        window.refreshCalls = 0;
        const record = { id: 'clear-target', ruleId: 'rule-1', ruleName: 'Clear target',
          datasetName: 'Orders', severity: 'high', status: 'pending',
          occurredAt: '2026-08-22T09:00:00', field: 'amount', value: 999, assignee: null };
        window.Store = {
          isSuperuser: () => true,
          getStats: () => ({ pendingRecords: window.refreshCalls ? 0 : 12, processingRecords: 0, timedOutRecords: 0,
            resolvedToday: window.refreshCalls ? 12 : 0, highAnomalies: 0 }),
          getRecords: () => [record], getRules: () => [],
          loadRecordsPage: async () => {
            if (outcome === 'list-failure' && window.refreshCalls) throw new Error('list failed');
            return { items: [record], total: 1, page: 1, pageSize: 10 };
          },
          clearInTransitPushes: () => {
            window.clearCalls++;
            return new Promise((resolve, reject) => {
              window.finishClear = () => outcome === 'request-failure'
                ? reject(new Error('request failed')) : resolve({ resolved_records: 12, cancelled_jobs: 25 });
            });
          },
          refresh: async () => {
            window.refreshCalls++;
            if (outcome === 'refresh-failure') throw new Error('refresh failed');
          }, exportUrl: '/export',
        };
      }, outcome);
      await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'records.js') });
      await page.evaluate(() => RecordsModule.render(document.getElementById('content'), {
        actionsEl: document.getElementById('actions'), navigate: () => {},
      }));
    });
    await page.locator('.rec-row-check').check();
    await page.click('#rec-clear-in-transit');
    const dialog = page.locator('[role="dialog"]');
    assert.match(await dialog.innerText(), /所有.*在途/);
    assert.match(await dialog.innerText(), /群聊播报/);
    assert.match(await dialog.innerText(), /筛选.*分页/);
    await dialog.locator('[data-action="cancel"]').click();
    assert.equal(await page.evaluate(() => window.clearCalls), 0);
    await page.click('#rec-clear-in-transit');
    await dialog.locator('[data-action="confirm"]').click();
    await page.waitForFunction(() => window.clearCalls === 1);
    assert.equal(await page.locator('#rec-clear-in-transit').isDisabled(), true);
    await page.evaluate(() => {
      document.getElementById('rec-clear-in-transit').dispatchEvent(new Event('click'));
      window.finishClear();
    });
    const title = outcome === 'request-failure' ? '清除在途推送失败'
      : ['refresh-failure', 'list-failure'].includes(outcome) ? '在途推送已清除，页面刷新失败' : '在途推送已清除';
    await page.getByText(title, { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.clearCalls), 1);
    assert.equal(await page.evaluate(() => window.refreshCalls), outcome === 'request-failure' ? 0 : 1);
    assert.equal(await page.locator('#rec-clear-in-transit').isDisabled(), false);
    if (outcome === 'success') {
      assert.match(await page.locator('#toast-container').innerText(), /12.*25/);
      assert.equal(await page.locator('.rec-row-check').isChecked(), false);
      assert.equal(await page.locator('#cnt-resolved').innerText(), '12');
    }
    assert.deepEqual(pageErrors, []);
  });
}
