const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');

const frontendRoot = path.join(__dirname, '..');

async function openTabbedRule(t, { editing = true, viewport = { width: 1280, height: 900 }, rulePatch = {} } = {}) {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(3000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.setContent('<!doctype html><html><body><div id="toast-container"></div><div id="actions"></div><div id="content"></div></body></html>');
  for (const file of ['base', 'components', 'pages']) {
    await page.addStyleTag({ path: path.join(frontendRoot, 'styles', `${file}.css`) });
  }
  for (const file of ['icons', 'components']) {
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', `${file}.js`) });
  }
  await page.evaluate(rulePatch => {
    const dataset = { id: 'dataset-1', name: '订单数据', rowCount: 2, fields: [
      { name: 'order_id', type: 'VARCHAR' }, { name: 'amount', type: 'DECIMAL' },
      { name: 'owner_id', type: 'VARCHAR' }, { name: 'limit', type: 'DECIMAL' },
    ] };
    const rule = {
      id: 'rule-1', name: '订单异常', description: '', datasetId: dataset.id, datasetName: dataset.name,
      severity: 'medium', enabled: true, anomalyCount: 0, lastRun: null,
      conditions: [{ field: 'amount', op: 'gt', value: '100' }], logic: 'AND', anomalyKeyFields: ['order_id'],
      schedule: { frequency: 'day', interval: 1, time: '09:00', start: '2026-08-28', end: '' },
      notify: { mode: 'manual', openIds: ['ou_notify'], userIds: [] },
      notificationTargets: [{ receive_id_type: 'open_id', source: 'literal', value: 'ou_notify' }],
      validationEnabled: false, validationTargets: [], validationTimeoutMinutes: 1440,
      groupBroadcast: { enabled: false, webhookUrl: '', mentionTargets: [], messageTemplate: '' },
    };
    Object.assign(rule, rulePatch);
    window.savedRule = null;
    window.Store = {
      getRules: () => [rule], getRule: () => rule, getDatasets: () => [dataset], getDataset: () => dataset,
      addRule: async payload => { window.savedRule = payload; },
      updateRule: async (_id, payload) => { window.savedRule = payload; },
    };
  }, rulePatch);
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'rules.js') });
  await page.evaluate(() => RulesModule.render(document.getElementById('content'), {
    actionsEl: document.getElementById('actions'), navigate: () => {},
  }));
  await page.evaluate(edit => RulesModule.openItem(edit ? 'rule-1' : undefined), editing);
  return page;
}

test('rule tabs isolate sections and preserve drafts for both create and edit', async t => {
  for (const editing of [false, true]) {
    const page = await openTabbedRule(t, { editing });
    const tabs = page.getByRole('tab');
    const names = ['基本信息', '关联数据集', '异常条件', '调度规则', '实时校验', '私聊通知', '群聊播报'];
    assert.deepEqual(await tabs.allTextContents(), names);
    assert.equal(await page.getByRole('tab', { selected: true }).textContent(), '基本信息');
    await page.fill('#f-name', '跨栏目草稿');
    for (const name of names) {
      await page.getByRole('tab', { name, exact: true }).click();
      assert.equal(await page.getByRole('tabpanel').count(), 1);
      assert.equal(await page.getByRole('tabpanel', { name, exact: true }).count(), 1);
      if (name !== '基本信息') assert.equal(await page.locator('#f-name').isVisible(), false);
    }
    await page.getByRole('tab', { name: '关联数据集' }).click();
    if (!editing) {
      await page.selectOption('#f-dataset', 'dataset-1');
      await page.click('#f-key-fields');
      await page.locator('#f-key-fields-listbox [data-key-field="order_id"]').click();
    }
    await page.getByRole('tab', { name: '异常条件' }).click();
    await page.selectOption('.condition-row [data-c="field"]', 'amount');
    await page.fill('.condition-row [data-c="value"]', '321');
    if (!editing) {
      await page.click('#f-save');
      assert.equal(await page.getByRole('tab', { selected: true }).textContent(), '私聊通知');
      assert.equal(await page.locator('#f-openids-input').evaluate(node => node === document.activeElement), true);
    }
    await page.getByRole('tab', { name: '调度规则' }).click();
    await page.fill('#f-interval', '3');
    await page.getByRole('tab', { name: '实时校验' }).click();
    await page.fill('#f-validation-userids-input', 'validator_draft');
    await page.getByRole('tab', { name: '私聊通知' }).click();
    await page.fill('#f-userids-input', 'recipient_draft');
    await page.fill('#f-private-message-template', '订单 {order_id}');
    await page.getByRole('tab', { name: '群聊播报' }).click();
    await page.fill('#f-group-userids-input', 'group_draft');
    await page.fill('#f-group-message-template', '订单 {order_id列表}');
    await page.getByRole('tab', { name: '基本信息' }).click();
    assert.equal(await page.locator('#f-name').inputValue(), '跨栏目草稿');
    assert.equal(await page.evaluate(() => window.savedRule), null, 'switching tabs never saves');
    await page.click('#f-save');
    assert.ok(await page.evaluate(() => window.savedRule), await page.locator('#toast-container').textContent());
    const saved = await page.evaluate(() => window.savedRule);
    assert.equal(saved.name, '跨栏目草稿');
    assert.equal(saved.conditions[0].value, '321');
    assert.equal(saved.schedule.interval, 3);
    assert.deepEqual(saved.validationTargets, [{ source: 'literal', value: 'validator_draft' }]);
    assert.ok(saved.notificationTargets.some(target => target.value === 'recipient_draft'));
    assert.equal(saved.privateMessageTemplate, '订单 {order_id}');
    assert.deepEqual(saved.groupBroadcast.situation.mentionTargets, [{ source: 'literal', value: 'group_draft' }]);
    assert.equal(saved.groupBroadcast.situation.messageTemplate, '订单 {order_id列表}');
    await page.evaluate(() => RulesModule.openItem('rule-1'));
    assert.equal(await page.getByRole('tab', { selected: true }).textContent(), '基本信息');
  }
});

test('rule tabs support keyboard navigation and keep navigation and actions visible on narrow screens', async t => {
  const page = await openTabbedRule(t, { viewport: { width: 390, height: 700 } });
  assert.equal(await page.getByRole('tab').count(), 7);
  await page.getByRole('tab', { name: '基本信息' }).focus();
  for (const [key, name] of [['ArrowRight', '关联数据集'], ['End', '群聊播报'], ['ArrowRight', '基本信息'], ['ArrowLeft', '群聊播报'], ['Home', '基本信息']]) {
    await page.keyboard.press(key);
    const selected = page.getByRole('tab', { selected: true });
    assert.equal(await selected.textContent(), name);
    assert.equal(await selected.evaluate(node => node === document.activeElement), true);
  }
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#f-name').evaluate(node => node === document.activeElement), true);
  await page.getByRole('tab', { name: '实时校验' }).click();
  await page.click('[data-validation-method="sql"]');
  const before = await page.getByRole('tablist').boundingBox();
  await page.locator('.modal-body').evaluate(node => { node.scrollTop = node.scrollHeight; });
  const after = await page.getByRole('tablist').boundingBox();
  assert.equal(after.y, before.y, 'tabs stay above the scrolling panel');
  const footer = await page.locator('.modal-footer').boundingBox();
  assert.ok(footer.y + footer.height <= 700);
  assert.equal(await page.locator('.modal-body').evaluate(node => node.scrollTop > 0), true);
  assert.equal(await page.locator('.modal').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.getByRole('tab', { name: '群聊播报' }).click();
  const last = await page.getByRole('tab', { selected: true }).boundingBox();
  assert.ok(last.x >= 0 && last.x + last.width <= 390);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 700 });
    for (const name of ['基本信息', '关联数据集', '异常条件', '调度规则', '实时校验', '私聊通知', '群聊播报']) {
      await page.getByRole('tab', { name, exact: true }).click();
      if (name === '异常条件') await page.selectOption('.condition-row [data-c="op"]', 'between');
      assert.equal(await page.locator('.modal-body').evaluate(node => node.scrollWidth <= node.clientWidth), true, `${width}px ${name} must fit`);
    }
    const dialog = await page.locator('.modal').boundingBox();
    for (const button of await page.locator('.modal-footer button').all()) {
      const box = await button.boundingBox();
      assert.ok(box.x >= dialog.x && box.x + box.width <= dialog.x + dialog.width, `${width}px footer actions must fit`);
    }
  }
});

test('saving opens the hidden tab containing an error and focuses its input', async t => {
  const page = await openTabbedRule(t);
  assert.equal(await page.getByRole('tab').count(), 7);
  const cases = [
    ['基本信息', '#f-name', '', '已修复'],
    ['关联数据集', '#f-dataset', '', 'dataset-1'],
    ['异常条件', '.condition-row [data-c="field"]', '', 'amount'],
    ['私聊通知', '#f-private-message-template', '[不安全](http://example.com)', ''],
    ['群聊播报', '#f-group-message-template', '{不存在}', ''],
    ['实时校验', '#f-validation-timeout', '0', '30'],
  ];
  for (const [name, selector, invalid, valid] of cases) {
    await page.getByRole('tab', { name, exact: true }).click();
    const input = page.locator(selector);
    const isSelect = await input.evaluate(node => node.tagName === 'SELECT');
    if (isSelect) await input.selectOption(invalid); else await input.fill(invalid);
    await page.getByRole('tab', { name: name === '基本信息' ? '调度规则' : '基本信息', exact: true }).click();
    await page.click('#f-save');
    assert.equal(await page.getByRole('tab', { selected: true }).textContent(), name);
    assert.equal(await input.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.evaluate(() => window.savedRule), null);
    if (isSelect) await input.selectOption(valid); else await input.fill(valid);
    if (selector === '#f-dataset') {
      await page.click('#f-key-fields');
      await page.locator('#f-key-fields-listbox [data-key-field="order_id"]').click();
      await page.getByRole('tab', { name: '异常条件' }).click();
      await page.selectOption('.condition-row [data-c="field"]', 'amount');
    }
  }
  await page.getByRole('tab', { name: '群聊播报' }).click();
  await page.locator('label').filter({ has: page.locator('#f-group-broadcast-enabled') }).click();
  await page.getByRole('tab', { name: '基本信息' }).click();
  await page.click('#f-save');
  assert.equal(await page.getByRole('tab', { selected: true }).textContent(), '群聊播报');
  assert.equal(await page.locator('#f-group-webhook').evaluate(node => node === document.activeElement), true);
  await page.fill('#f-group-webhook', 'https://open.feishu.cn/open-apis/bot/v2/hook/example');
  await page.getByRole('tab', { name: '基本信息' }).click();
  await page.click('#f-save');
  assert.deepEqual(await page.evaluate(() => window.savedRule.groupBroadcast.situation.mentionTargets), [], 'situation mentions are optional');
});

test('SQL validation keeps its draft across tabs and focuses missing parameter mappings', async t => {
  const page = await openTabbedRule(t);
  await page.getByRole('tab', { name: '实时校验' }).click();
  await page.click('[data-validation-method="sql"]');
  await page.fill('#f-validation-sql', 'SELECT amount FROM orders WHERE id={订单ID}');
  await page.click('#f-add-sql-parameter');
  await page.locator('[data-sql-param="name"]').fill('订单ID');
  await page.getByRole('tab', { name: '基本信息' }).click();
  await page.click('#f-save');
  assert.equal(await page.getByRole('tab', { selected: true }).textContent(), '实时校验');
  assert.equal(await page.locator('[data-sql-param="field"]').evaluate(node => node === document.activeElement), true);
  assert.equal(await page.locator('#f-validation-sql').inputValue(), 'SELECT amount FROM orders WHERE id={订单ID}');
  assert.equal(await page.locator('[data-sql-param="name"]').inputValue(), '订单ID');
  await page.locator('[data-sql-param="field"]').selectOption('order_id');
  await page.selectOption('#f-sql-operator', 'between');
  for (const [selector, value] of [['#f-sql-result-field', 'amount'], ['#f-sql-value', '10'], ['#f-sql-upper-value', '20']]) {
    await page.getByRole('tab', { name: '基本信息' }).click();
    await page.click('#f-save');
    assert.equal(await page.getByRole('tab', { selected: true }).textContent(), '实时校验');
    assert.equal(await page.locator(selector).evaluate(node => node === document.activeElement), true);
    assert.equal(await page.evaluate(() => window.savedRule), null);
    await page.fill(selector, value);
  }
  await page.getByRole('tab', { name: '基本信息' }).click();
  await page.click('#f-save');
  assert.deepEqual(await page.evaluate(() => window.savedRule.sqlValidationConfig), {
    queryTemplate: 'SELECT amount FROM orders WHERE id={订单ID}',
    parameters: [{ name: '订单ID', field: 'order_id' }],
    trueCondition: { field: 'amount', operator: 'between', value: 10, upperValue: 20, valueSource: 'literal', valueField: null, upperValueSource: 'literal', upperValueField: null },
  });
});

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

  await page.getByRole('tab', { name: '异常条件', exact: true }).click();
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
  await page.getByRole('tab', { name: '异常条件', exact: true }).click();
  await page.selectOption('.condition-row [data-c="field"]', 'license_plate');
  await page.getByRole('tab', { name: '异常条件', exact: true }).click();
  await page.selectOption('.condition-row [data-c="op"]', 'eq');
  await page.fill('.condition-row [data-c="value"]', 'q皖H0BCB7');
  await page.click('#f-save');
  await page.waitForTimeout(25);

  assert.deepEqual(await page.evaluate(() => window.updatedRule.conditions), [{
    field: 'license_plate', op: 'eq', value: 'q皖H0BCB7', baseline: null, value_source: 'literal', upper_value_source: 'literal',
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
  await page.getByRole('tab', { name: '关联数据集', exact: true }).click();
  await page.selectOption('#f-dataset', 'dataset-1');
  await page.getByRole('tab', { name: '异常条件', exact: true }).click();
  await page.selectOption('.condition-row [data-c="field"]', 'amount');
  await page.fill('.condition-row [data-c="value"]', '100');
  await page.getByRole('tab', { name: '私聊通知', exact: true }).click();
  await page.fill('#f-userids-input', 'u_123456');
  await page.click('#f-save');
  assert.equal(await page.evaluate(() => window.createdRule), null, 'an anomaly key remains required');
  assert.equal(await page.getByRole('tab', { selected: true }).textContent(), '关联数据集');
  assert.equal(await page.locator('#f-key-fields').evaluate(node => node === document.activeElement), true);
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

  await page.getByRole('tab', { name: '关联数据集', exact: true }).click();
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

  await page.getByRole('tab', { name: '关联数据集', exact: true }).click();
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
        enabled: true,
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/saved-webhook',
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
  assert.equal(await page.locator('#f-group-webhook').getAttribute('type'), 'text');
  assert.equal(await page.locator('#f-group-webhook').inputValue(), 'https://open.feishu.cn/open-apis/bot/v2/hook/saved-webhook');
  assert.deepEqual(await page.locator('#f-group-userids .tag-pill').allTextContents(), ['fixed-user']);
  const groupFieldTrigger = page.locator('#f-group-fields');
  const groupFieldListbox = page.locator('#f-group-fields-listbox');
  assert.deepEqual(await groupFieldTrigger.locator('.key-field-picker-tag').allTextContents(), ['owner_user_id']);

  await page.getByRole('tab', { name: '群聊播报', exact: true }).click();
  await page.fill('#f-group-userids-input', 'extra-user');
  await groupFieldTrigger.click();
  await groupFieldListbox.locator('[data-key-field="backup_user_id"]').click();
  await page.click('#f-save');
  await page.waitForTimeout(25);

  assert.deepEqual(await page.evaluate(() => window.updatedRule.groupBroadcast), {
    webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/saved-webhook',
    situation: { enabled: true,
    mentionTargets: [
      { source: 'literal', value: 'fixed-user' },
      { source: 'literal', value: 'extra-user' },
      { source: 'field', field: 'owner_user_id' },
      { source: 'field', field: 'backup_user_id' },
    ],
    messageTemplate: null,
    },
    timeout: { enabled: false, mentionTargets: [], messageTemplate: null },
  });

  await page.evaluate(() => RulesModule.openItem('rule-1'));
  await page.getByRole('tab', { name: '群聊播报', exact: true }).click();
  await page.uncheck('#f-group-broadcast-enabled');
  await page.fill('#f-group-webhook', '');
  await page.click('#f-save');
  await page.waitForTimeout(25);
  assert.equal(await page.evaluate(() => window.updatedRule.groupBroadcast.webhookUrl), null);
});

test('rule form inserts template parameters and links from nested drawers and validates manual URLs', async t => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body><div id="toast-container"></div><div id="actions"></div><div id="content"></div></body></html>');
  await page.addStyleTag({ path: path.join(frontendRoot, 'styles', 'base.css') });
  await page.addStyleTag({ path: path.join(frontendRoot, 'styles', 'components.css') });
  await page.addStyleTag({ path: path.join(frontendRoot, 'styles', 'pages.css') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'icons.js') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'components.js') });
  await page.evaluate(() => {
    const dataset = {
      id: 'dataset-1', name: '运输途中车辆温度', rowCount: 2,
      fields: [
        { name: '车牌号', type: 'VARCHAR' },
        { name: 'frozen_temperature', type: 'DECIMAL' },
      ],
    };
    const rule = {
      id: 'rule-1', name: '冻库温度异常', description: '', datasetId: dataset.id,
      datasetName: dataset.name, severity: 'high', enabled: true, anomalyCount: 0,
      lastRun: null, logic: 'AND',
      conditions: [{ field: 'frozen_temperature', op: 'gt', value: -10 }],
      anomalyKeyFields: ['车牌号'],
      schedule: { frequency: 'day', interval: 1, time: '09:00', start: '2026-08-23', end: '' },
      notify: { mode: 'manual', openIds: [], userIds: ['owner'], fieldSource: null },
      notificationTargets: [{ receive_id_type: 'user_id', source: 'literal', value: 'owner' }],
      privateMessageTemplate: '异常记录：',
      validationEnabled: false, validationTargets: [], validationTimeoutMinutes: 1440,
      validationMethod: 'pseudo', sqlValidationConfig: null,
      groupBroadcast: {
        enabled: false, webhookUrl: '', mentionTargets: [], messageTemplate: '异常记录组：',
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

  const privateEditor = page.locator('#f-private-message-template');
  await page.getByRole('tab', { name: '私聊通知', exact: true }).click();
  await privateEditor.focus();
  await privateEditor.evaluate(input => input.setSelectionRange(input.value.length, input.value.length));
  await page.click('[data-template-picker="parameter"][data-template-context="private"]');
  await page.click('.template-picker-option[data-template-value="{车牌号}"]');
  await page.click('[data-template-picker="link"][data-template-context="private"]');
  await page.click('.template-picker-option[data-template-value="[查看异常记录明细]({异常记录链接})"]');
  assert.equal(
    await privateEditor.inputValue(),
    '异常记录：{车牌号}[查看异常记录明细]({异常记录链接})',
  );

  const groupEditor = page.locator('#f-group-message-template');
  await page.getByRole('tab', { name: '群聊播报', exact: true }).click();
  await groupEditor.focus();
  await groupEditor.evaluate(input => input.setSelectionRange(input.value.length, input.value.length));
  await page.click('[data-template-picker="parameter"][data-template-context="group"]');
  await page.click('.template-picker-option[data-template-value="{车牌号列表}"]');
  assert.equal(await groupEditor.inputValue(), '异常记录组：{车牌号列表}');

  await page.getByRole('tab', { name: '私聊通知', exact: true }).click();
  await privateEditor.fill('[不安全](http://example.com)');
  await page.click('#f-save');
  assert.match(await page.locator('#f-private-template-error').textContent(), /必须使用 HTTPS/);
  assert.equal(await page.evaluate(() => window.updatedRule), null);

  await page.getByRole('tab', { name: '私聊通知', exact: true }).click();
  await privateEditor.fill('[错误目标]({车牌号})');
  await page.click('#f-save');
  assert.match(await page.locator('#f-private-template-error').textContent(), /仅支持系统深链/);
  assert.equal(await page.evaluate(() => window.updatedRule), null);

  await page.getByRole('tab', { name: '私聊通知', exact: true }).click();
  await privateEditor.fill('异常记录：{车牌号}\n[查看]({异常记录链接})');
  await page.click('#f-save');
  await page.waitForTimeout(25);
  assert.equal(
    await page.evaluate(() => window.updatedRule.privateMessageTemplate),
    '异常记录：{车牌号}\n[查看]({异常记录链接})',
  );
  assert.equal(
    await page.evaluate(() => window.updatedRule.groupBroadcast.situation.messageTemplate),
    '异常记录组：{车牌号列表}',
  );
});

test('repeat push defaults off and survives tabs when enabled', async t => {
  const page = await openTabbedRule(t);
  await page.getByRole('tab', { name: '关联数据集' }).click();
  assert.equal(await page.getByRole('checkbox', { name: '允许重复推送' }).count(), 1);
  assert.equal(await page.locator('#f-repeat-push-enabled').isChecked(), false);
  await page.locator('label').filter({ has: page.locator('#f-repeat-push-enabled') }).click();
  await page.getByRole('tab', { name: '基本信息' }).click();
  await page.click('#f-save');
  assert.equal(await page.evaluate(() => window.savedRule.repeatPushEnabled), true);
});

test('field operands preserve independent bounds and literal drafts through operators and tabs', async t => {
  const page = await openTabbedRule(t);
  await page.getByRole('tab', { name: '异常条件' }).click();
  await page.selectOption('[data-c="op"]', 'between');
  assert.equal(await page.locator('.condition-row [data-operand="value"] [data-source="field"]').count(), 1);
  await page.click('.condition-row [data-operand="value"] [data-source="field"]');
  await page.selectOption('[data-c="value_field"]', 'limit');
  await page.fill('[data-c="upper_value"]', '300');
  await page.selectOption('[data-c="op"]', 'is_null');
  assert.equal(await page.locator('.condition-operand:visible').count(), 0);
  await page.selectOption('[data-c="op"]', 'between');
  assert.equal(await page.locator('[data-c="value_field"]').inputValue(), 'limit');
  assert.equal(await page.locator('[data-c="upper_value"]').inputValue(), '300');
  await page.click('.condition-row [data-operand="value"] [data-source="literal"]');
  assert.equal(await page.locator('[data-c="value"]').inputValue(), '100');
  await page.click('.condition-row [data-operand="value"] [data-source="field"]');
  await page.getByRole('tab', { name: '基本信息' }).click();
  await page.click('#f-save');
  const condition = await page.evaluate(() => window.savedRule.conditions[0]);
  assert.equal(condition.value_source, 'field');
  assert.equal(condition.value_field, 'limit');
  assert.equal(condition.upper_value_source, 'literal');
  assert.equal(condition.upper_value, '300');
});

test('field operand validation focuses missing or incompatible dataset references and clears stale fields', async t => {
  const page = await openTabbedRule(t, { rulePatch: { conditions: [{ field: 'amount', op: 'gt', value_source: 'field', value_field: 'missing' }] } });
  await page.click('#f-save');
  assert.equal(await page.evaluate(() => window.savedRule), null);
  assert.equal(await page.getByRole('tab', { selected: true }).textContent(), '异常条件');
  assert.equal(await page.locator('[data-c="value_field"]').inputValue(), '');
  await page.selectOption('[data-c="value_field"]', 'owner_id');
  await page.click('#f-save');
  assert.equal(await page.evaluate(() => window.savedRule), null);
  assert.match(await page.locator('#toast-container').textContent(), /类型|数值/);
  await page.selectOption('[data-c="value_field"]', 'limit');
  await page.click('#f-save');
  assert.equal(await page.evaluate(() => window.savedRule.conditions[0].value_field), 'limit');
});

test('SQL result field operands persist and hide for null operators without losing drafts', async t => {
  const page = await openTabbedRule(t);
  await page.getByRole('tab', { name: '实时校验' }).click();
  await page.click('[data-validation-method="sql"]');
  await page.fill('#f-validation-sql', 'SELECT amount, low, high FROM orders');
  await page.fill('#f-sql-result-field', 'amount');
  await page.selectOption('#f-sql-operator', 'between');
  assert.equal(await page.locator('#f-sql-value-operand [data-source="field"]').count(), 1);
  await page.click('#f-sql-value-operand [data-source="field"]');
  await page.fill('#f-sql-value-field', 'low');
  await page.click('#f-sql-upper-value-operand [data-source="field"]');
  await page.fill('#f-sql-upper-value-field', 'high');
  await page.selectOption('#f-sql-operator', 'is_null');
  assert.equal(await page.locator('#f-sql-value-operand').isVisible(), false);
  await page.selectOption('#f-sql-operator', 'between');
  await page.getByRole('tab', { name: '基本信息' }).click();
  await page.click('#f-save');
  const condition = await page.evaluate(() => window.savedRule.sqlValidationConfig.trueCondition);
  assert.equal(condition.valueSource, 'field');
  assert.equal(condition.valueField, 'low');
  assert.equal(condition.upperValueSource, 'field');
  assert.equal(condition.upperValueField, 'high');
});

test('group broadcasts save independently with optional situation mentions and mandatory timeout validators', async t => {
  const page = await openTabbedRule(t);
  await page.getByRole('tab', { name: '群聊播报' }).click();
  assert.equal(await page.getByText('异常情况播报', { exact: true }).count(), 1);
  await page.locator('label').filter({ has: page.locator('#f-group-broadcast-enabled') }).click();
  await page.fill('#f-group-webhook', 'https://open.feishu.cn/open-apis/bot/v2/hook/example');
  await page.locator('label').filter({ has: page.locator('#f-timeout-broadcast-enabled') }).click();
  await page.fill('#f-timeout-userids-input', 'extra_handler');
  await page.fill('#f-timeout-message-template', '超时 {order_id列表}');
  assert.equal(await page.locator('#f-timeout-all-validators').isChecked(), true);
  assert.equal(await page.locator('#f-timeout-all-validators').isDisabled(), true);
  await page.click('#f-save');
  assert.equal(await page.evaluate(() => window.savedRule), null);
  assert.match(await page.locator('#f-group-broadcast-error').textContent(), /实时校验/);
  await page.getByRole('tab', { name: '实时校验' }).click();
  await page.locator('label').filter({ has: page.locator('#f-validation-enabled') }).click();
  await page.fill('#f-validation-userids-input', 'validator');
  await page.click('#f-save');
  assert.deepEqual(await page.evaluate(() => window.savedRule.groupBroadcast), {
    webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/example',
    situation: { enabled: true, mentionTargets: [], messageTemplate: null },
    timeout: { enabled: true, mentionTargets: [{ source: 'literal', value: 'extra_handler' }], messageTemplate: '超时 {order_id列表}' },
  });
});

test('ratio conditions accept a numeric field multiplier and retain baseline across operator changes', async t => {
  const page = await openTabbedRule(t);
  await page.getByRole('tab', { name: '异常条件' }).click();
  await page.selectOption('[data-c="op"]', 'gt_threshold_ratio');
  await page.selectOption('[data-c="baseline"]', '7d_avg');
  await page.click('.condition-row [data-operand="value"] [data-source="field"]');
  await page.selectOption('[data-c="value_field"]', 'limit');
  await page.selectOption('[data-c="op"]', 'is_not_null');
  await page.selectOption('[data-c="op"]', 'gt_threshold_ratio');
  assert.equal(await page.locator('[data-c="baseline"]').inputValue(), '7d_avg');
  await page.click('#f-save');
  const saved = await page.evaluate(() => window.savedRule.conditions[0]);
  assert.equal(saved.value_source, 'field');
  assert.equal(saved.value_field, 'limit');
  assert.equal(saved.baseline, '7d_avg');
});

test('switching datasets clears both field operand references without discarding literal drafts', async t => {
  const page = await openTabbedRule(t, { rulePatch: {
    conditions: [{ field: 'amount', op: 'between', value: '10', upper_value: '30', value_source: 'field', value_field: 'limit', upper_value_source: 'field', upper_value_field: 'amount' }],
  } });
  await page.getByRole('tab', { name: '关联数据集' }).click();
  await page.selectOption('#f-dataset', '');
  await page.selectOption('#f-dataset', 'dataset-1');
  await page.getByRole('tab', { name: '异常条件' }).click();
  assert.equal(await page.locator('[data-c="field"]').inputValue(), '');
  assert.equal(await page.locator('[data-c="value_field"]').inputValue(), '');
  assert.equal(await page.locator('[data-c="upper_value_field"]').inputValue(), '');
  await page.click('.condition-row [data-operand="value"] [data-source="literal"]');
  await page.click('.condition-row [data-operand="upper_value"] [data-source="literal"]');
  assert.equal(await page.locator('[data-c="value"]').inputValue(), '10');
  assert.equal(await page.locator('[data-c="upper_value"]').inputValue(), '30');
});

test('timeout template uses group list parameters and links and focuses invalid template on save', async t => {
  const page = await openTabbedRule(t);
  await page.getByRole('tab', { name: '群聊播报' }).click();
  await page.fill('#f-timeout-message-template', '{order_id}');
  await page.getByRole('tab', { name: '基本信息' }).click();
  await page.click('#f-save');
  assert.equal(await page.getByRole('tab', { selected: true }).textContent(), '群聊播报');
  assert.equal(await page.locator('#f-timeout-message-template').evaluate(node => node === document.activeElement), true);
  await page.fill('#f-timeout-message-template', '');
  await page.click('[data-template-picker="parameter"][data-template-context="timeout"]');
  await page.click('.template-picker-option[data-template-value="{order_id列表}"]');
  await page.click('[data-template-picker="link"][data-template-context="timeout"]');
  await page.click('.template-picker-option[data-template-value="[查看异常记录组明细]({异常记录组链接})"]');
  await page.click('#f-save');
  assert.equal(await page.evaluate(() => window.savedRule.groupBroadcast.timeout.messageTemplate), '{order_id列表}[查看异常记录组明细]({异常记录组链接})');
  assert.equal(await page.evaluate(() => window.savedRule.groupBroadcast.situation.messageTemplate), null);
});
