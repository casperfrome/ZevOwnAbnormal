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
  assert.equal(await page.getByText('飞书通知', { exact: true }).count(), 1, 'normal notifications remain a distinct section');
  await page.fill('#f-name', 'Validation rule');
  await page.selectOption('#f-dataset', 'dataset-1');
  await page.selectOption('#f-field', 'amount');
  await page.selectOption('#f-key-fields', 'order_id');
  await page.selectOption('.condition-row [data-c="field"]', 'amount');
  await page.fill('#f-openids-input', 'ou_notify');
  await page.check('#f-validation-enabled');
  await page.fill('#f-validation-timeout', '30');
  await page.click('#f-save');

  assert.equal(await page.evaluate(() => window.createdRule), null);
  const targetError = page.locator('#f-validation-target-error');
  assert.equal(await targetError.isVisible(), true);
  assert.match(await targetError.textContent(), /至少.*验证目标/);

  await page.fill('#f-validation-userids-input', 'u_typed_not_entered');
  await page.selectOption('#f-validation-fields', ['owner_id', 'reviewer_id']);
  await page.click('#f-save');
  await page.waitForTimeout(25);

  const created = await page.evaluate(() => window.createdRule);
  assert.equal(created.validationEnabled, true);
  assert.equal(created.validationTimeoutMinutes, 30);
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
      datasetName: dataset.name, field: 'amount', severity: 'medium', enabled: true, anomalyCount: 0,
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
      resolvedByUserId: 'u_1', businessKey: { owner_id: 'u_1' }, details: { gmv: 999 }, hitCount: 1,
      lastSeenAt: '2026-08-22T09:10:00', deliveries: [], timeline: [],
      validationRequests: [{
        recipientUserId: 'u_1', deliveryStatus: 'resolved', deliveryAttempts: 2,
        messageId: 'om_1', lastError: null, deliveredAt: '2026-08-22T09:01:00',
      }],
      validationSubmission: {
        submittedByUserId: 'u_1', submittedText: '<script>window.auditInjected=true</script>approved',
        validatorType: 'pseudo', result: 'passed', submittedAt: '2026-08-22T09:20:00',
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
  assert.match(drawerText, /校验截止时间/);
  assert.match(drawerText, /解决来源/);
  assert.match(drawerText, /u_1/);
  assert.match(drawerText, /approved/);
  assert.match(drawerText, /resolved/);
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
          resolvedToday: 23, criticalAnomalies: 4,
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
    page: 1, pageSize: 10, status: null, severity: null, ruleId: null, search: '',
    sortKey: 'occurredAt', sortOrder: 'desc',
  });
  assert.equal(await page.locator('#cnt-all').textContent(), '70');
  assert.equal(await page.locator('#cnt-pending').textContent(), '12');
  assert.equal(await page.locator('#cnt-processing').textContent(), '8');
  assert.equal(await page.locator('#cnt-timed-out').textContent(), '27');
  assert.equal(await page.locator('#cnt-resolved').textContent(), '23');

  await page.click('[data-status="timed_out"]');
  await page.waitForFunction(() => window.recordQueries.length === 2);
  assert.equal(await page.locator('#rec-count-text').textContent(), '共 27 条记录');
  assert.equal(await page.evaluate(() => window.recordQueries[1].status), 'timed_out');
  await page.click('.page-btn[data-page="2"]');
  await page.waitForFunction(() => window.recordQueries.length === 3);
  assert.deepEqual(await page.evaluate(() => window.recordQueries[2]), {
    page: 2, pageSize: 10, status: 'timed_out', severity: null, ruleId: null, search: '',
    sortKey: 'occurredAt', sortOrder: 'desc',
  });
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
        getStats: () => ({ pendingRecords: 2, processingRecords: 0, timedOutRecords: 0, resolvedToday: 0, criticalAnomalies: 0 }),
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
        getStats: () => ({ pendingRecords: 10, processingRecords: 0, timedOutRecords: window.finalResolved ? 0 : 1, resolvedToday: window.finalResolved ? 1 : 0, criticalAnomalies: 0 }),
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
  await page.locator('text=record-first-page').waitFor();

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
        resolvedToday: 0, criticalAnomalies: 0, unresolvedRecords: 1,
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
