const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');

const frontendRoot = path.join(__dirname, '..');

test('rule summary shows deduplicated pushes in transit and refreshes the server count', async t => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
  t.after(() => browser.close());

  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.setContent(`<!doctype html><html><body>
    <div id="toast-container"></div><div id="actions"></div><div id="content"></div>
  </body></html>`);
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'icons.js') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'components.js') });
  await page.evaluate(() => {
    window.pushInTransit = 3;
    window.refreshCalls = 0;
    window.Store = {
      getRules: () => [],
      getDatasets: () => [],
      getStats: () => ({ pushInTransitAnomalies: window.pushInTransit }),
      refresh: async () => {
        window.refreshCalls += 1;
        window.pushInTransit = 7;
      },
    };
  });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'rules.js') });
  await page.evaluate(() => RulesModule.render(document.getElementById('content'), {
    actionsEl: document.getElementById('actions'), navigate: () => {},
  }));

  const pushCard = page.locator('#r-stats .stat-card').filter({ hasText: '推送途中' });
  assert.equal(await page.locator('#r-stats').getAttribute('class'), 'stat-strip five-up');
  assert.equal(await pushCard.locator('.stat-card-value').textContent(), '3');

  await page.click('#r-refresh');
  await page.waitForFunction(() => window.refreshCalls === 1);
  assert.equal(await pushCard.locator('.stat-card-value').textContent(), '7');
  assert.deepEqual(pageErrors, []);
});

test('opening an existing rule directly renders its condition and can add another', async t => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
  t.after(() => browser.close());

  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.setContent(`
    <!doctype html>
    <html>
      <body>
        <div id="toast-container"></div>
        <div id="actions"></div>
        <div id="content"></div>
      </body>
    </html>
  `);
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'icons.js') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'components.js') });
  await page.evaluate(() => {
    const dataset = {
      id: 'dataset-1',
      name: '订单明细',
      rowCount: 100,
      fields: [
        { name: 'order_id', type: 'varchar' },
        { name: 'amount', type: 'decimal' },
      ],
    };
    const rule = {
      id: 'rule-1',
      name: '订单金额检测',
      description: '',
      datasetId: dataset.id,
      datasetName: dataset.name,
      severity: 'medium',
      enabled: true,
      anomalyCount: 0,
      lastRun: null,
      logic: 'AND',
      conditions: [{ field: 'amount', op: 'gt', value: '100', baseline: null }],
      anomalyKeyFields: ['order_id', 'order_id'],
      schedule: { frequency: 'day', interval: 1, time: '09:00', start: '2026-08-09', end: '' },
      notify: { mode: 'manual', openIds: ['ou_test'], userIds: [], fieldSource: null },
      notificationTargets: [{ receive_id_type: 'open_id', source: 'literal', value: 'ou_test' }],
    };

    window.updatedRule = null;
    window.Store = {
      getRules: () => [rule],
      getRule: id => id === rule.id ? rule : null,
      getDatasets: () => [dataset],
      getDataset: id => id === dataset.id ? dataset : null,
      updateRule: async (_id, payload) => { window.updatedRule = payload; },
    };
  });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'rules.js') });
  await page.evaluate(() => {
    RulesModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'),
      navigate: () => {},
    });
  });

  await page.evaluate(() => RulesModule.openItem('rule-1'));
  assert.deepEqual(
    await page.locator('#f-key-fields .key-field-picker-tag').allTextContents(),
    ['order_id'],
  );
  assert.equal(
    await page.locator('.condition-row').count(),
    1,
    `condition rows were not initialized; browser errors: ${pageErrors.join(' | ')}`,
  );

  await page.click('#add-condition');
  assert.equal(await page.locator('.condition-row').count(), 2);

  await page.click('[data-logic="OR"]');
  assert.equal(await page.locator('.condition-logic').textContent(), 'OR');
  await page.locator('[data-remove="1"]').click();
  assert.equal(await page.locator('.condition-row').count(), 1);

  const actionButtonTypes = await page.locator(
    '#f-logic button, #f-notify-mode button, #add-condition, [data-remove], [data-action="cancel"], #f-test, #f-save',
  ).evaluateAll(buttons => buttons.map(button => button.type));
  assert.deepEqual(actionButtonTypes, actionButtonTypes.map(() => 'button'));
  await page.click('#f-save');
  await page.waitForTimeout(25);
  assert.deepEqual(await page.evaluate(() => window.updatedRule.anomalyKeyFields), ['order_id']);
  assert.deepEqual(pageErrors, []);
});

test('editing an API-shaped condition removes the stale operator before saving', async t => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
  t.after(() => browser.close());

  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.setContent(`
    <!doctype html>
    <html>
      <body>
        <div id="toast-container"></div>
        <div id="actions"></div>
        <div id="content"></div>
      </body>
    </html>
  `);
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'icons.js') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'components.js') });
  await page.evaluate(() => {
    const dataset = {
      id: 'dataset-1', name: 'Vehicle temperatures', rowCount: 188,
      fields: [
        { name: 'data_date', type: 'VARCHAR' },
        { name: 'license_plate', type: 'VARCHAR' },
        { name: 'refrigerated_temperature', type: 'DECIMAL' },
      ],
    };
    const rule = {
      id: 'rule-1', name: 'Temperature check', description: '', datasetId: dataset.id,
      datasetName: dataset.name, severity: 'medium', enabled: true, anomalyCount: 0,
      lastRun: null, logic: 'AND',
      conditions: [{
        field: 'refrigerated_temperature', operator: 'gte', op: 'gte', value: '-12', baseline: null,
      }],
      anomalyKeyFields: ['data_date', 'license_plate'],
      schedule: { frequency: 'day', interval: 1, time: '09:00', start: '2026-08-09', end: '' },
      notify: { mode: 'manual', openIds: [], userIds: ['validator-1'], fieldSource: null },
      notificationTargets: [{ receive_id_type: 'user_id', source: 'literal', value: 'validator-1' }],
    };
    window.updatedRule = null;
    window.Store = {
      getRules: () => [rule], getRule: () => rule,
      getDatasets: () => [dataset], getDataset: () => dataset,
      updateRule: async (_id, payload) => {
        window.updatedRule = payload;
        Object.assign(rule, payload);
        rule.groupBroadcast = {
          ...payload.groupBroadcast,
          hasWebhook: payload.groupBroadcast.webhookUrl === null ? false : true,
        };
      },
    };
  });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'rules.js') });
  await page.evaluate(() => RulesModule.render(document.getElementById('content'), {
    actionsEl: document.getElementById('actions'), navigate: () => {},
  }));

  await page.evaluate(() => RulesModule.openItem('rule-1'));
  await page.selectOption('.condition-row [data-c="field"]', 'license_plate');
  await page.selectOption('.condition-row [data-c="op"]', 'eq');
  await page.fill('.condition-row [data-c="value"]', 'q皖H0BCB7');
  await page.click('#f-save');
  await page.waitForTimeout(25);

  assert.deepEqual(await page.evaluate(() => window.updatedRule.conditions), [{
    field: 'license_plate', op: 'eq', value: 'q皖H0BCB7', baseline: null,
  }]);
  assert.deepEqual(pageErrors, []);
});

test('creating a rule uses condition fields and commits a typed user_id without Enter', async t => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
  t.after(() => browser.close());

  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.setContent(`
    <!doctype html>
    <html>
      <body>
        <div id="toast-container"></div>
        <div id="actions"></div>
        <div id="content"></div>
      </body>
    </html>
  `);
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'icons.js') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'components.js') });
  await page.evaluate(() => {
    const dataset = {
      id: 'dataset-1',
      name: 'Orders',
      rowCount: 100,
      fields: [
        { name: 'order_id', type: 'varchar' },
        { name: 'amount', type: 'decimal' },
      ],
    };
    window.createdRule = null;
    window.Store = {
      getRules: () => [],
      getDatasets: () => [dataset],
      getDataset: id => id === dataset.id ? dataset : null,
      addRule: async payload => { window.createdRule = payload; },
    };
  });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'rules.js') });
  await page.evaluate(() => {
    RulesModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'),
      navigate: () => {},
    });
  });

  await page.click('#r-add');
  assert.equal(await page.getByText('监控字段', { exact: true }).count(), 0);
  assert.equal(await page.locator('#f-field').count(), 0);
  await page.fill('#f-name', 'User ID notification');
  await page.selectOption('#f-dataset', 'dataset-1');
  await page.selectOption('.condition-row [data-c="field"]', 'amount');
  await page.fill('#f-userids-input', 'u_123456');
  await page.click('#f-save');
  assert.equal(await page.evaluate(() => window.createdRule), null, 'an anomaly key remains required');
  await page.click('#f-key-fields');
  await page.locator('#f-key-fields-listbox [data-key-field="order_id"]').click();
  await page.locator('#f-key-fields-listbox [data-key-field="amount"]').click();
  await page.click('#f-save');
  await page.waitForTimeout(25);

  const createdRule = await page.evaluate(() => window.createdRule);
  assert.ok(createdRule, 'the rule should be submitted without requiring Enter in the user_id field');
  assert.deepEqual(createdRule.anomalyKeyFields, ['order_id', 'amount']);
  assert.deepEqual(createdRule.notificationTargets, [
    { receive_id_type: 'user_id', source: 'literal', value: 'u_123456' },
  ]);
  assert.deepEqual(pageErrors, []);
});

test('anomaly key picker supports accessible multi-selection and clears stale fields', async t => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
  t.after(() => browser.close());

  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.setContent(`
    <!doctype html>
    <html>
      <body>
        <div id="toast-container"></div>
        <div id="actions"></div>
        <div id="content"></div>
      </body>
    </html>
  `);
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'icons.js') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'components.js') });
  await page.evaluate(() => {
    const datasets = [
      {
        id: 'dataset-1', name: 'Orders', rowCount: 100,
        fields: [
          { name: 'order_id', type: 'varchar' },
          { name: 'shop_id', type: 'varchar' },
          { name: 'amount', type: 'decimal' },
        ],
      },
      {
        id: 'dataset-2', name: 'Refunds', rowCount: 10,
        fields: [{ name: 'refund_id', type: 'varchar' }],
      },
    ];
    window.Store = {
      getRules: () => [],
      getDatasets: () => datasets,
      getDataset: id => datasets.find(dataset => dataset.id === id),
    };
  });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'rules.js') });
  await page.evaluate(() => {
    RulesModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'),
      navigate: () => {},
    });
  });

  await page.click('#r-add');
  const trigger = page.locator('#f-key-fields');
  const listbox = page.locator('#f-key-fields-listbox');
  assert.equal(await trigger.getAttribute('role'), 'combobox');
  assert.equal(await trigger.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(await trigger.getAttribute('aria-label'), '异常主键字段');
  assert.equal(await trigger.getAttribute('aria-required'), 'true');
  assert.equal(await trigger.isDisabled(), true);

  await page.selectOption('#f-dataset', 'dataset-1');
  assert.equal(await trigger.isEnabled(), true);
  await trigger.click();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
  await listbox.locator('[data-key-field="order_id"]').click();
  await listbox.locator('[data-key-field="shop_id"]').click();
  assert.deepEqual(
    await trigger.locator('.key-field-picker-tag').allTextContents(),
    ['order_id', 'shop_id'],
  );
  assert.equal(await listbox.locator('[data-key-field="order_id"]').getAttribute('aria-selected'), 'true');

  await trigger.press('Escape');
  assert.equal(await listbox.isVisible(), false);
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');

  await trigger.click();
  await page.locator('.modal-title').click();
  assert.equal(await listbox.isVisible(), false);

  await trigger.press('ArrowDown');
  await trigger.press('Enter');
  assert.deepEqual(await trigger.locator('.key-field-picker-tag').allTextContents(), ['shop_id']);
  await trigger.press('Enter');
  assert.deepEqual(await trigger.locator('.key-field-picker-tag').allTextContents(), ['shop_id', 'order_id']);
  await trigger.press('Escape');

  await page.selectOption('#f-dataset', 'dataset-2');
  assert.deepEqual(await trigger.locator('.key-field-picker-tag').allTextContents(), []);
  await trigger.click();
  assert.deepEqual(await listbox.locator('[role="option"] strong').allTextContents(), ['refund_id']);
  assert.deepEqual(pageErrors, []);
});

test('rule form preserves configured webhook and saves fixed plus field group mentions', async t => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body><div id="toast-container"></div><div id="actions"></div><div id="content"></div></body></html>');
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'icons.js') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'components.js') });
  await page.evaluate(() => {
    const dataset = {
      id: 'dataset-1', name: 'Orders', rowCount: 2,
      fields: [
        { name: 'store_id', type: 'VARCHAR' },
        { name: 'owner_user_id', type: 'VARCHAR' },
        { name: 'backup_user_id', type: 'VARCHAR' },
        { name: 'gmv', type: 'DECIMAL' },
      ],
    };
    const rule = {
      id: 'rule-1', name: 'GMV check', description: '', datasetId: dataset.id,
      datasetName: dataset.name, severity: 'high', enabled: true, anomalyCount: 0,
      lastRun: null, logic: 'AND', conditions: [{ field: 'gmv', op: 'gt', value: 10 }],
      anomalyKeyFields: ['store_id'],
      schedule: { frequency: 'day', interval: 1, time: '09:00', start: '2026-08-23', end: '' },
      notify: { mode: 'manual', openIds: [], userIds: ['ordinary-user'], fieldSource: null },
      notificationTargets: [{ receive_id_type: 'user_id', source: 'literal', value: 'ordinary-user' }],
      validationEnabled: false, validationTargets: [], validationTimeoutMinutes: 1440,
      validationMethod: 'pseudo', sqlValidationConfig: null,
      groupBroadcast: {
        enabled: true, hasWebhook: true,
        mentionTargets: [
          { source: 'literal', value: 'fixed-user' },
          { source: 'field', field: 'owner_user_id' },
        ],
      },
    };
    window.updatedRule = null;
    window.Store = {
      getRules: () => [rule], getRule: () => rule,
      getDatasets: () => [dataset], getDataset: () => dataset,
      updateRule: async (_id, payload) => { window.updatedRule = payload; },
    };
  });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'rules.js') });
  await page.evaluate(() => RulesModule.render(document.getElementById('content'), {
    actionsEl: document.getElementById('actions'), navigate: () => {},
  }));

  await page.evaluate(() => RulesModule.openItem('rule-1'));
  assert.equal(await page.locator('#f-group-broadcast-enabled').isChecked(), true);
  assert.match(await page.locator('#f-group-webhook').getAttribute('placeholder'), /已配置/);
  assert.deepEqual(await page.locator('#f-group-userids .tag-pill').allTextContents(), ['fixed-user']);
  assert.deepEqual(await page.locator('#f-group-fields option:checked').allTextContents(), ['owner_user_id · VARCHAR']);

  await page.fill('#f-group-userids-input', 'extra-user');
  await page.selectOption('#f-group-fields', ['owner_user_id', 'backup_user_id']);
  await page.click('#f-save');
  await page.waitForTimeout(25);

  assert.deepEqual(await page.evaluate(() => window.updatedRule.groupBroadcast), {
    enabled: true,
    hasWebhook: true,
    mentionTargets: [
      { source: 'literal', value: 'fixed-user' },
      { source: 'literal', value: 'extra-user' },
      { source: 'field', field: 'owner_user_id' },
      { source: 'field', field: 'backup_user_id' },
    ],
  });

  await page.evaluate(() => RulesModule.openItem('rule-1'));
  assert.equal(await page.locator('#f-group-webhook-clear').isVisible(), true);
  await page.uncheck('#f-group-broadcast-enabled');
  await page.check('#f-group-webhook-clear');
  await page.click('#f-save');
  await page.waitForTimeout(25);
  assert.equal(await page.evaluate(() => window.updatedRule.groupBroadcast.webhookUrl), null);
});
