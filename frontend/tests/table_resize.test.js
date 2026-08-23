const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');

const frontendRoot = path.join(__dirname, '..');
const executablePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function openResizableTable(page) {
  await page.route('http://resizer.test/**', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><body>
      <div class="table-wrap" style="width:260px;">
        <table class="data-table" data-table-id="test-records">
          <thead><tr>
            <th data-column-key="name" data-default-width="160" style="width:160px">Name</th>
            <th data-column-key="status" data-default-width="120" style="width:120px">Status</th>
          </tr></thead>
          <tbody><tr><td>A very long record name that cannot fit inside the default column width</td><td>Pending</td></tr></tbody>
        </table>
      </div>
    </body></html>`,
  }));
  await page.goto('http://resizer.test/');
  await page.addStyleTag({ path: path.join(frontendRoot, 'styles', 'base.css') });
  await page.addStyleTag({ path: path.join(frontendRoot, 'styles', 'components.css') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'icons.js') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'components.js') });
  await page.evaluate(() => UI.initResizableTables(document));
}

test('resizable tables persist widths, enforce a minimum, and do not trigger header clicks', async t => {
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await openResizableTable(page);

  const longCell = page.locator('tbody td').first();
  assert.equal(await longCell.evaluate(node => getComputedStyle(node).whiteSpace), 'nowrap');
  await longCell.hover();
  assert.match(await longCell.getAttribute('title'), /A very long record name/);

  await page.evaluate(() => {
    window.headerClicks = 0;
    document.querySelector('[data-column-key="name"]').addEventListener('click', () => { window.headerClicks += 1; });
  });
  const handle = page.locator('[data-column-key="name"] .column-resize-handle');
  assert.equal(await handle.count(), 1);
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 86, box.y + box.height / 2);
  await page.mouse.up();

  const expandedWidth = await page.locator('[data-column-key="name"]').evaluate(node => Math.round(node.getBoundingClientRect().width));
  assert.ok(expandedWidth >= 230, `expected dragged width >= 230px, got ${expandedWidth}px`);
  assert.equal(await page.evaluate(() => window.headerClicks), 0);

  await page.reload();
  await page.addStyleTag({ path: path.join(frontendRoot, 'styles', 'base.css') });
  await page.addStyleTag({ path: path.join(frontendRoot, 'styles', 'components.css') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'icons.js') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'components.js') });
  await page.evaluate(() => UI.initResizableTables(document));
  const restoredWidth = await page.locator('[data-column-key="name"]').evaluate(node => Math.round(node.getBoundingClientRect().width));
  assert.ok(Math.abs(restoredWidth - expandedWidth) <= 1, `expected ${expandedWidth}px after reload, got ${restoredWidth}px`);

  const restoredHandle = page.locator('[data-column-key="name"] .column-resize-handle');
  await restoredHandle.dispatchEvent('pointerdown', { pointerId: 7, clientX: 200, button: 0, isPrimary: true });
  assert.equal(await page.locator('body').evaluate(node => node.classList.contains('is-resizing-column')), true);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal(await page.locator('body').evaluate(node => node.classList.contains('is-resizing-column')), false);

  const restoredBox = await restoredHandle.boundingBox();
  await page.mouse.move(restoredBox.x + restoredBox.width / 2, restoredBox.y + restoredBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(restoredBox.x - 500, restoredBox.y + restoredBox.height / 2);
  await page.mouse.up();
  const minimumWidth = await page.locator('[data-column-key="name"]').evaluate(node => Math.round(node.getBoundingClientRect().width));
  assert.ok(minimumWidth >= 72, `expected minimum width >= 72px, got ${minimumWidth}px`);

  assert.equal(await page.evaluate(() => {
    localStorage.setItem('sentinel.table-widths.v1', 'null');
    const table = document.createElement('table');
    table.dataset.tableId = 'late-table';
    table.innerHTML = '<thead><tr><th data-column-key="late">Late</th></tr></thead><tbody><tr><td>Value</td></tr></tbody>';
    document.body.appendChild(table);
    UI.initResizableTables(table);
    return table.querySelectorAll('.column-resize-handle').length;
  }), 1);
});

test('tables fill wide containers, map drags 1:1, and reset on double-click', async t => {
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.route('http://resizer.test/**', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><body>
      <div class="table-wrap" style="width:600px;">
        <table class="data-table" data-table-id="wide-records">
          <thead><tr>
            <th data-column-key="name" data-default-width="160">Name</th>
            <th data-column-key="status" data-default-width="120">Status</th>
          </tr></thead>
          <tbody><tr><td>Record name</td><td>Pending</td></tr></tbody>
        </table>
      </div>
    </body></html>`,
  }));
  await page.goto('http://resizer.test/');
  await page.addStyleTag({ path: path.join(frontendRoot, 'styles', 'base.css') });
  await page.addStyleTag({ path: path.join(frontendRoot, 'styles', 'components.css') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'icons.js') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'components.js') });
  await page.evaluate(() => UI.initResizableTables(document));

  // Defaults are smaller than the wrapper: the table fills it and stretches columns.
  const table = page.locator('[data-table-id="wide-records"]');
  const filled = await table.evaluate(node => ({
    table: Math.round(node.getBoundingClientRect().width),
    name: Math.round(node.querySelector('[data-column-key="name"]').getBoundingClientRect().width),
  }));
  assert.ok(Math.abs(filled.table - 600) <= 1, `expected table to fill the 600px wrapper, got ${filled.table}px`);
  assert.ok(filled.name > 160, `expected the name column to stretch beyond its 160px default, got ${filled.name}px`);

  // Dragging maps 1:1 to rendered pixels even while the table is stretched.
  const handle = page.locator('[data-column-key="name"] .column-resize-handle');
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2);
  await page.mouse.up();
  const dragged = await table.evaluate(node => ({
    table: Math.round(node.getBoundingClientRect().width),
    name: Math.round(node.querySelector('[data-column-key="name"]').getBoundingClientRect().width),
  }));
  assert.ok(Math.abs(dragged.name - (filled.name + 50)) <= 1,
    `expected drag to add exactly 50px (${filled.name} -> ${dragged.name})`);
  assert.ok(dragged.table > 600, 'growing a column beyond the container should widen the table');

  // Double-click resets the column to its default and clears the stored width.
  await handle.dblclick();
  const reset = await table.evaluate(node => ({
    spec: node.querySelector('[data-column-key="name"]').style.width,
    stored: JSON.parse(localStorage.getItem('sentinel.table-widths.v1') || '{}')['wide-records'] || {},
  }));
  assert.equal(reset.spec, '160px');
  assert.equal('name' in reset.stored, false);

  // Shrinking columns below the container keeps the table filled instead of leaving a gap.
  const shrinkBox = await handle.boundingBox();
  await page.mouse.move(shrinkBox.x + shrinkBox.width / 2, shrinkBox.y + shrinkBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(shrinkBox.x - 40, shrinkBox.y + shrinkBox.height / 2);
  await page.mouse.up();
  const shrunk = await table.evaluate(node => Math.round(node.getBoundingClientRect().width));
  assert.ok(Math.abs(shrunk - 600) <= 1, `expected the table to keep filling the wrapper after shrinking, got ${shrunk}px`);
});

test('all primary lists and anomaly detail tables opt into the shared resizer', async t => {
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.setContent('<!doctype html><html><body><div id="toast-container"></div><div id="actions"></div><div id="content"></div></body></html>');
  for (const style of ['base.css', 'layout.css', 'components.css', 'pages.css']) {
    await page.addStyleTag({ path: path.join(frontendRoot, 'styles', style) });
  }
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'icons.js') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'components.js') });
  await page.evaluate(() => {
    const datasource = {
      id: 'source-1', name: 'Source', description: '', type: 'mysql', host: '127.0.0.1', port: 3306,
      database: 'app', status: 'online', createdAt: '2026-08-23T00:00:00', lastChecked: null,
    };
    const dataset = {
      id: 'dataset-1', name: 'Dataset', description: '', datasourceId: datasource.id,
      datasourceName: datasource.name, fields: [{ name: 'amount', type: 'decimal' }], rowCount: 1,
      updatedAt: '2026-08-23T00:00:00',
    };
    const rule = {
      id: 'rule-1', name: 'Rule', description: '', datasetId: dataset.id, datasetName: dataset.name,
      severity: 'high', enabled: true, anomalyCount: 1, lastRun: null,
      schedule: { frequency: 'day', interval: 1, time: '09:00' }, conditions: [], notify: {},
    };
    const record = {
      id: 'record-1', ruleId: rule.id, ruleName: rule.name, datasetName: dataset.name,
      severity: 'high', status: 'pending', occurredAt: '2026-08-23T00:00:00', lastSeenAt: '2026-08-23T00:00:00',
      field: 'amount', value: 99, expected: 'gte', assignee: null, description: '', businessKey: { id: 1 },
      details: { amount: 99 }, hitCount: 1, validationDeadline: null, timedOutAt: null,
      resolutionSource: null, resolvedByUserId: null, validationMethod: 'pseudo', timeline: [],
      validationRequests: [{ recipientUserId: 'u1', deliveryStatus: 'delivered', deliveryAttempts: 1, deliveredAt: null, messageId: 'm1' }],
      validationSubmission: null,
      deliveries: [{ receive_id_type: 'user_id', recipient: 'u1', status: 'sent', attempts: 1, message_id: 'm1' }],
    };
    window.fixtureRecord = record;
    window.Store = {
      isSuperuser: () => false,
      getDatasources: () => [datasource], getDatasource: () => datasource,
      getDatasets: () => [dataset], getDataset: () => dataset,
      getRules: () => [rule], getRule: () => null,
      getRecords: () => [record], getRecord: () => record,
      getStats: () => ({ pendingRecords: 1, processingRecords: 0, timedOutRecords: 0, resolvedToday: 0, criticalAnomalies: 0 }),
      loadRecordsPage: async () => ({ items: [record], total: 1, page: 1, pageSize: 10 }),
      loadRecord: async () => record,
      peekRecordsPage: async () => ({ items: [], total: 0, page: 1, pageSize: 1 }),
      refresh: async () => {}, exportUrl: () => '/export',
    };
  });
  for (const script of ['datasource.js', 'dataset.js', 'rules.js', 'records.js']) {
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', script) });
  }

  const expectedLists = [
    ['DatasourceModule', 'datasource-list', 7],
    ['DatasetModule', 'dataset-list', 6],
    ['RulesModule', 'rules-list', 8],
    ['RecordsModule', 'records-list', 9],
  ];
  for (const [moduleName, tableId, columns] of expectedLists) {
    await page.evaluate(moduleName => window[moduleName].render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'), navigate: () => {},
    }), moduleName);
    const table = page.locator(`[data-table-id="${tableId}"]`);
    await table.waitFor();
    await page.waitForFunction(({ tableId, columns }) => (
      document.querySelectorAll(`[data-table-id="${tableId}"] .column-resize-handle`).length === columns
    ), { tableId, columns });
    assert.equal(await table.evaluate(node => [...node.querySelectorAll('tbody tr:first-child .row-action, tbody tr:first-child .switch, tbody tr:first-child .checkbox')].every(control => {
      const cell = control.closest('td').getBoundingClientRect();
      const box = control.getBoundingClientRect();
      return box.left >= cell.left && box.right <= cell.right;
    })), true, `${tableId} keeps row controls inside their cells`);
    if (tableId === 'records-list') {
      const widths = await table.evaluate(node => ({
        table: Math.round(node.getBoundingClientRect().width),
        container: Math.round(node.parentElement.getBoundingClientRect().width),
        fieldValue: Math.round(node.querySelector('[data-column-key="field-value"]').getBoundingClientRect().width),
        occurredAt: Math.round(node.querySelector('[data-column-key="occurred-at"]').getBoundingClientRect().width),
      }));
      assert.ok(widths.fieldValue >= 180, `expected field/value default >= 180px, got ${widths.fieldValue}px`);
      assert.ok(widths.occurredAt >= 160, `expected occurred-at default >= 160px, got ${widths.occurredAt}px`);
      assert.ok(widths.table > widths.container, 'record defaults should enable horizontal scrolling instead of crushing columns');
    }
  }

  await page.evaluate(() => RecordsModule.openDetail(window.fixtureRecord.id));
  for (const [tableId, columns] of [
    ['record-validation-requests', 5], ['record-row-details', 2], ['record-deliveries', 5],
  ]) {
    await page.waitForFunction(({ tableId, columns }) => (
      document.querySelectorAll(`[data-table-id="${tableId}"] .column-resize-handle`).length === columns
    ), { tableId, columns });
    const overflow = await page.locator(`[data-table-id="${tableId}"]`).evaluate(table => ({
      overflowX: getComputedStyle(table.closest('.results-wrap')).overflowX,
      tableWidth: table.getBoundingClientRect().width,
      wrapperWidth: table.closest('.results-wrap').getBoundingClientRect().width,
    }));
    assert.equal(overflow.overflowX, 'auto');
    if (tableId !== 'record-row-details') assert.ok(overflow.tableWidth > overflow.wrapperWidth);
  }
});
