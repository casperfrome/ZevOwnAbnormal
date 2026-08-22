const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');

const frontendRoot = path.join(__dirname, '..');

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
      field: 'amount',
      severity: 'medium',
      enabled: true,
      anomalyCount: 0,
      lastRun: null,
      logic: 'AND',
      conditions: [{ field: 'amount', op: 'gt', value: '100', baseline: null }],
      anomalyKeyFields: ['order_id'],
      schedule: { frequency: 'day', interval: 1, time: '09:00', start: '2026-08-09', end: '' },
      notify: { mode: 'manual', openIds: ['ou_test'], userIds: [], fieldSource: null },
      notificationTargets: [{ receive_id_type: 'open_id', source: 'literal', value: 'ou_test' }],
    };

    window.Store = {
      getRules: () => [rule],
      getRule: id => id === rule.id ? rule : null,
      getDatasets: () => [dataset],
      getDataset: id => id === dataset.id ? dataset : null,
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
  assert.deepEqual(pageErrors, []);
});

test('creating a rule commits a typed user_id even when Enter was not pressed', async t => {
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
  await page.fill('#f-name', 'User ID notification');
  await page.selectOption('#f-dataset', 'dataset-1');
  await page.selectOption('#f-field', 'amount');
  await page.selectOption('#f-key-fields', 'order_id');
  await page.selectOption('.condition-row [data-c="field"]', 'amount');
  await page.fill('#f-userids-input', 'u_123456');
  await page.click('#f-save');
  await page.waitForTimeout(25);

  const createdRule = await page.evaluate(() => window.createdRule);
  assert.ok(createdRule, 'the rule should be submitted without requiring Enter in the user_id field');
  assert.deepEqual(createdRule.notificationTargets, [
    { receive_id_type: 'user_id', source: 'literal', value: 'u_123456' },
  ]);
  assert.deepEqual(pageErrors, []);
});
