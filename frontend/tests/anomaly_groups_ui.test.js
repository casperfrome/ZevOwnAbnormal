const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('./browser');

const frontendRoot = path.join(__dirname, '..');

async function browserPage(t) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(1800);
  return page;
}

test('anomaly group module renders summaries and links every member to record detail', async t => {
  const page = await browserPage(t);
  await page.setContent('<!doctype html><html><body><div id="toast-container"></div><div id="actions"></div><div id="content"></div></body></html>');
  for (const style of ['base.css', 'layout.css', 'components.css', 'pages.css']) {
    await page.addStyleTag({ path: path.join(frontendRoot, 'styles', style) });
  }
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'icons.js') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'components.js') });
  await page.evaluate(() => {
    window.openedRoutes = [];
    const group = {
      groupId: 'run-1', ruleId: 'rule-1', ruleName: 'GMV check', detectedAt: '2026-08-23T01:00:00',
      scannedRows: 10, matchedRows: 2, newAnomalies: 1,
      statusCounts: { pending: 1, processing: 0, timed_out: 0, resolved: 1 },
      broadcastStatus: 'partial_failed',
    };
    window.Store = {
      loadAnomalyGroupsPage: async () => ({ items: [group], total: 1, page: 1, pageSize: 10 }),
      loadAnomalyGroup: async () => ({
        group,
        items: [{
          id: 'record-1', ruleName: 'GMV check', datasetName: 'Orders', severity: 'high', status: 'pending',
          businessKey: { store_id: 1 }, occurredAt: '2026-08-23T01:00:00',
        }],
        total: 1, page: 1, pageSize: 20,
      }),
    };
  });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'anomaly_groups.js') });
  await page.evaluate(() => AnomalyGroupsModule.render(document.getElementById('content'), {
    actionsEl: document.getElementById('actions'),
    navigate: route => window.openedRoutes.push(route),
  }));

  await page.getByText('GMV check', { exact: true }).waitFor();
  assert.match(await page.locator('#anomaly-group-table').innerText(), /待处理 1/);
  assert.match(await page.locator('#anomaly-group-table').innerText(), /部分失败/);
  await page.locator('[data-group-id="run-1"]').click();
  const drawer = page.getByRole('dialog');
  await drawer.getByText('查看明细', { exact: true }).waitFor();
  const link = drawer.getByRole('link', { name: '查看明细' });
  assert.equal(await link.getAttribute('href'), '#records/record-1');
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
  await link.click({ modifiers: ['Control'] });
  assert.deepEqual(await page.evaluate(() => window.openedRoutes), []);
  assert.equal(await drawer.isVisible(), true);
});

test('monitor navigation places anomaly groups immediately after anomaly records', async t => {
  const page = await browserPage(t);
  const markup = fs.readFileSync(path.join(frontendRoot, 'index.html'), 'utf8')
    .replace(/<link[^>]+>/g, '')
    .replace(/<script[^>]*><\/script>/g, '');
  await page.setContent(markup, { waitUntil: 'domcontentloaded' });
  const monitorItems = await page.locator('.sidebar-nav .nav-item').evaluateAll(items => (
    items.slice(0, 3).map(item => item.textContent.trim().replace(/\s+/g, ' '))
  ));
  assert.match(monitorItems[0], /^异常记录/);
  assert.equal(monitorItems[1], '异常记录组');
  assert.equal(monitorItems[2], '异常规则');
});

test('group list and detail distinguish situation and timeout status including waiting and skipped', async t => {
  const page = await browserPage(t);
  await page.setContent('<div id="content"></div>');
  for (const file of ['icons', 'components']) await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', `${file}.js`) });
  await page.evaluate(() => {
    const groups = [
      { groupId: 'waiting', ruleName: 'Waiting', situationBroadcastStatus: 'sent', timeoutBroadcastStatus: 'waiting' },
      { groupId: 'skipped', ruleName: 'Skipped', situationBroadcastStatus: 'skipped', timeoutBroadcastStatus: 'skipped' },
    ];
    window.Store = {
      loadAnomalyGroupsPage: async () => ({ items: groups, total: 2, page: 1, pageSize: 10 }),
      loadAnomalyGroup: async () => ({ group: groups[0], items: [], total: 0, page: 1, pageSize: 20, deliveries: [{ broadcast_kind: 'timeout', status: 'failed', last_error: 'retry later', attempts: 1 }] }),
    };
  });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'anomaly_groups.js') });
  await page.evaluate(() => AnomalyGroupsModule.render(document.getElementById('content'), {}));
  await page.locator('[data-group-id="waiting"]').waitFor();
  const text = await page.locator('#content').textContent();
  assert.match(text, /异常情况/);
  assert.match(text, /异常超时/);
  assert.match(text, /等待到期/);
  assert.match(text, /已跳过/);
  await page.evaluate(() => AnomalyGroupsModule.openDetail('waiting'));
  assert.match(await page.locator('.drawer').textContent(), /等待到期/);
  assert.match(await page.locator('.drawer').textContent(), /retry later/);
});
