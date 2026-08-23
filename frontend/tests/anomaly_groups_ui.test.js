const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');

const frontendRoot = path.join(__dirname, '..');
const executablePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function browserPage(t) {
  const browser = await chromium.launch({ headless: true, executablePath });
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
  await link.click();
  assert.deepEqual(await page.evaluate(() => window.openedRoutes), ['records/record-1']);
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
