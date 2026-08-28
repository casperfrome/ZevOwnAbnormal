const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('./browser');

async function overviewPage(t) {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(2000);
  await page.setContent('<div id="actions"></div><main id="content"></main><div id="toast-container"></div>');
  for (const script of ['icons', 'components']) await page.addScriptTag({ path: path.join(__dirname, '..', 'scripts', `${script}.js`) });
  await page.evaluate(() => {
    window.daysRequested = [];
    window.overview = { days: 14, timezone: 'Asia/Shanghai', trend: [{ date: '2026-08-27', count: 0 }, { date: '2026-08-28', count: 0 }], recent_anomalies: [{ id: 'server-record', rule_name: 'Server recent', dataset_name: 'Server dataset', first_seen_at: '2026-08-27T18:00:00Z', severity: 'high', status: 'pending' }], top_rules: [{ id: 'server-rule', name: 'Server top', dataset_name: 'Server dataset', anomaly_count: 42 }] };
    window.Store = {
      getOverview: () => overview,
      getStats: () => ({ activeRules: 1, totalRules: 1, pendingRecords: 1, processingRecords: 0, timedOutRecords: 0, onlineDatasources: 0, totalDatasources: 0, resolvedToday: 0 }),
      getRecords: () => [], getRules: () => [], getDatasources: () => [],
      refreshOverview: async days => { daysRequested.push(days); return new Promise(resolve => { window.finishOverview = () => { overview = { ...overview, days, trend: [{ date: '2026-08-28', count: 3 }] }; resolve(overview); }; }); },
    };
  });
  await page.addScriptTag({ path: path.join(__dirname, '..', 'scripts', 'overview.js') });
  await page.evaluate(() => OverviewModule.render(document.querySelector('#content'), { actionsEl: document.querySelector('#actions') }));
  return page;
}

test('overview uses authoritative recent/top lists, Beijing trend labels and zero-safe bars without fabricated health', async t => {
  const page = await overviewPage(t);
  const text = await page.locator('#content').innerText();
  assert.match(text, /Server recent/); assert.match(text, /Server top/); assert.match(text, /42/);
  assert.match(text, /北京时间/); assert.match(text, /暂无数据/);
  assert.doesNotMatch(text, /连接正常|监控中/);
  assert.doesNotMatch(text, /87|92%|78%|2h 14m/);
  assert.equal(await page.locator('[data-trend-date="2026-08-27"]').getAttribute('data-count'), '0');
  assert.doesNotMatch(await page.locator('#content').innerHTML(), /NaN|Infinity/);
});

test('overview range and refresh controls fetch selected server days once and safely rerender', async t => {
  const page = await overviewPage(t); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: '30 天', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => daysRequested), [30]);
  await page.evaluate(() => finishOverview());
  await page.waitForFunction(() => document.querySelector('#content').textContent.includes('近 30 天'));
  await page.click('#ov-refresh');
  assert.equal(await page.locator('#ov-refresh').isDisabled(), true);
  await page.evaluate(() => finishOverview());
  await page.waitForFunction(() => !document.querySelector('#ov-refresh').disabled);
  assert.deepEqual(await page.evaluate(() => daysRequested), [30, 30]);
  assert.deepEqual(errors, []);
});

test('overview response cannot overwrite a route reusing the same main container', async t => {
  const page = await overviewPage(t);
  await page.click('#ov-refresh');
  await page.evaluate(() => { document.querySelector('#content').innerHTML = '<h2>New route</h2>'; finishOverview(); });
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#content').innerText(), 'New route');
});

test('ninety-day chart keeps nonzero bars visible and every day reachable without overflowing the card', async t => {
  const page = await overviewPage(t);
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.evaluate(() => {
    overview.days = 90;
    overview.trend = Array.from({ length: 90 }, (_, index) => ({ date: new Date(Date.UTC(2026, 5, 1 + index)).toISOString().slice(0, 10), count: index === 89 ? 4 : 0 }));
    OverviewModule.render(document.querySelector('#content'), { actionsEl: document.querySelector('#actions') });
  });
  const last = page.locator('[data-trend-date]').last();
  assert.equal(await last.evaluate(el => el.style.width), '100%');
  assert.ok((await last.boundingBox()).width > 0);
  const scroll = page.locator('[data-trend-scroll]');
  await last.scrollIntoViewIfNeeded();
  const sizes = await scroll.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, x: el.scrollLeft }));
  assert.ok(sizes.scroll >= sizes.width);
  assert.ok((await last.boundingBox()).x + (await last.boundingBox()).width <= 1000);
});
