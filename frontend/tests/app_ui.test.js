const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');

const frontendRoot = path.join(__dirname, '..');
const executablePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function browserPage(t, viewport = { width: 1280, height: 720 }) {
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(1500);
  return page;
}

async function mountApp(t, scenario = {}, initialHash = '') {
  const page = await browserPage(t);
  await page.setContent(`<!doctype html><html><body>
    <div id="toast-container"></div>
    <div class="app-shell"><aside id="sidebar">
      <div class="nav-item" data-route="records"></div>
      <div class="nav-item" data-route="anomaly-groups"></div>
      <div class="nav-item" data-route="rules"></div>
      <div class="nav-item" data-route="datasets"></div>
      <div class="nav-item" data-route="datasources"></div>
    </aside>
    <div id="sidebar-backdrop"></div><button id="sidebar-toggle"></button>
    <div id="breadcrumb"><span class="crumb-current"></span></div>
    <span id="nav-anomaly-count"></span>
    <button id="global-search-trigger" aria-label="打开全局搜索"></button>
    <button id="global-search-mobile-trigger" aria-label="打开全局搜索"></button>
    <main id="page-root"></main></div>
  </body></html>`);
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'icons.js') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'components.js') });
  await page.evaluate(testScenario => {
    const record = {
      id: 'record-1', ruleId: 'rule-1', ruleName: '门店 GMV 异常', datasetName: '门店日经营',
      severity: 'critical', status: 'pending', occurredAt: '2026-08-22 10:00', field: 'gmv', value: 999,
    };
    let initCalls = 0;
    window.searchRecordQueries = [];
    window.openedItems = [];
    window.loginAttempts = 0;
    window.releasePendingLogin = null;
    window.Store = {
      init: async () => {
        initCalls += 1;
        window.initCalls = initCalls;
        const status = testScenario.initStatuses?.[initCalls - 1];
        if (status) throw Object.assign(new Error(status === 401 ? 'Unauthorized' : 'service unavailable'), { status });
      },
      login: async () => {
        window.loginAttempts += 1;
        if (testScenario.pendingLogin401) {
          await new Promise(resolve => { window.releasePendingLogin = resolve; });
          throw Object.assign(new Error('用户名或密码错误'), { status: 401 });
        }
        return { id: 'user-1', username: 'admin', is_superuser: true };
      },
      setUnauthorizedHandler: handler => { window.unauthorizedHandler = handler; },
      getStats: () => ({ pendingRecords: 1, processingRecords: 0, timedOutRecords: 0, resolvedToday: 0 }),
      getRecords: () => [record],
      getRules: () => [{ id: 'rule-1', name: '门店 GMV 异常', description: '监控营业额' }],
      getDatasets: () => [{ id: 'dataset-1', name: '门店日经营', description: '每日经营汇总', datasourceName: 'StarRocks' }],
      getDatasources: () => [{ id: 'source-1', name: '经营分析库', type: 'starrocks', host: '127.0.0.1', database: 'ads' }],
      peekRecordsPage: async query => {
        window.searchRecordQueries.push({ ...query });
        return { items: query.search.includes('GMV') ? [record] : [], total: 1, page: 1, pageSize: 5 };
      },
    };
    const module = name => ({
      render: content => { content.innerHTML = `<div>${name}</div>`; },
      openItem: id => window.openedItems.push([name, id]),
    });
    window.RecordsModule = { render: content => { content.innerHTML = '<div>records</div>'; }, openDetail: id => window.openedItems.push(['records', id]) };
    window.AnomalyGroupsModule = { render: content => { content.innerHTML = '<div>groups</div>'; }, openDetail: id => window.openedItems.push(['anomaly-groups', id]) };
    window.RulesModule = module('rules');
    window.DatasetModule = module('datasets');
    window.DatasourceModule = module('datasources');
  }, scenario);
  if (initialHash) await page.evaluate(hash => history.replaceState(null, '', hash), initialHash);
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'app.js') });
  return page;
}

test('an initial authentication 401 hides the business shell and presents an accessible login form', async t => {
  const page = await mountApp(t, { initStatuses: [401] });

  await page.getByRole('heading', { name: '登录 Sentinel' }).waitFor();
  await page.addStyleTag({ path: path.join(frontendRoot, 'styles', 'base.css') });
  await page.addStyleTag({ path: path.join(frontendRoot, 'styles', 'layout.css') });
  await page.addStyleTag({ path: path.join(frontendRoot, 'styles', 'components.css') });
  await page.addStyleTag({ path: path.join(frontendRoot, 'styles', 'pages.css') });
  assert.equal(await page.locator('.app-shell').isHidden(), true);
  assert.equal(await page.getByRole('textbox', { name: '用户名' }).count(), 1);
  assert.equal(await page.getByLabel('密码').getAttribute('type'), 'password');
  assert.equal(await page.getByRole('button', { name: '登录' }).count(), 1);
});

test('a later unauthorized API response returns the app to the login form', async t => {
  const page = await mountApp(t);
  await page.getByText('records', { exact: true }).waitFor();

  await page.evaluate(() => window.unauthorizedHandler(Object.assign(new Error('登录已失效'), { status: 401 })));

  await page.getByRole('heading', { name: '登录 Sentinel' }).waitFor();
  assert.equal(await page.locator('.app-shell').isHidden(), true);
});

test('an unauthorized transition closes business overlays and blocks the global-search shortcut', async t => {
  const page = await mountApp(t);
  await page.getByText('records', { exact: true }).waitFor();
  await page.keyboard.press('Control+K');
  await page.getByRole('dialog', { name: '全局搜索' }).waitFor();
  await page.evaluate(() => UI.modal({ title: '编辑数据源', body: '敏感业务内容' }));
  assert.equal(await page.locator('.modal-backdrop').count(), 1);
  assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden');

  await page.evaluate(() => window.unauthorizedHandler(Object.assign(new Error('登录已失效'), { status: 401 })));

  await page.getByRole('heading', { name: '登录 Sentinel' }).waitFor();
  assert.equal(await page.locator('.command-backdrop').count(), 0);
  assert.equal(await page.locator('.modal-backdrop, .drawer-backdrop').count(), 0);
  assert.equal(await page.evaluate(() => document.body.style.overflow), '');
  await page.keyboard.press('Control+K');
  assert.equal(await page.locator('.command-backdrop').count(), 0);
});

test('a non-authentication startup failure stays on the backend connection failure surface', async t => {
  const page = await mountApp(t, { initStatuses: [503] });

  await page.getByRole('heading', { name: '后端连接失败' }).waitFor();
  assert.equal(await page.locator('.login-screen').count(), 0);
  assert.match(await page.getByRole('alert').textContent(), /service unavailable/);
});

test('the login form keeps invalid credentials inline and prevents duplicate pending submissions', async t => {
  const page = await mountApp(t, { initStatuses: [401], pendingLogin401: true });

  await page.getByRole('heading', { name: '登录 Sentinel' }).waitFor();
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('wrong');
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByRole('button', { name: '正在登录…' }).waitFor();
  await page.getByRole('button', { name: '正在登录…' }).click({ force: true });
  assert.equal(await page.evaluate(() => window.loginAttempts), 1);

  await page.evaluate(() => window.releasePendingLogin());
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').textContent(), /用户名或密码错误/);
  assert.equal(await page.getByLabel('用户名').inputValue(), 'admin');
  assert.equal(await page.getByLabel('密码').inputValue(), 'wrong');
});

test('a successful Enter login reloads the session and restores the original route', async t => {
  const page = await mountApp(t, { initStatuses: [401] }, '#rules');
  await page.getByRole('heading', { name: '登录 Sentinel' }).waitFor();
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('correct');
  await page.getByLabel('密码').press('Enter');

  await page.getByText('rules', { exact: true }).waitFor();
  assert.equal(await page.locator('.login-screen').count(), 0);
  assert.equal(await page.evaluate(() => location.hash), '#rules');
  assert.equal(await page.evaluate(() => window.initCalls), 2);
});

test('anomaly group deep links render the group module and open its detail', async t => {
  const page = await mountApp(t);

  await page.evaluate(() => App.navigate('anomaly-groups/run-1'));

  assert.match(await page.evaluate(() => location.hash), /anomaly-groups\/run-1/);
  assert.deepEqual(await page.evaluate(() => window.openedItems), [['anomaly-groups', 'run-1']]);
});

test('toolbar search reserves enough inline space for its icon at desktop and mobile widths', async t => {
  const page = await browserPage(t);
  await page.setContent(`<!doctype html><html><head></head><body>
    <div class="toolbar-search">
      <span class="search-icon"><svg width="16" height="16"></svg></span>
      <input placeholder="搜索规则、数据集、字段…" />
    </div>
  </body></html>`);
  await page.addStyleTag({ path: path.join(frontendRoot, 'styles', 'base.css') });
  await page.addStyleTag({ path: path.join(frontendRoot, 'styles', 'components.css') });
  await page.waitForTimeout(180);

  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const geometry = await page.evaluate(() => {
      const input = document.querySelector('.toolbar-search input');
      const icon = document.querySelector('.search-icon');
      const inputRect = input.getBoundingClientRect();
      const iconRect = icon.getBoundingClientRect();
      return {
        iconRight: iconRect.right,
        textStart: inputRect.left + Number.parseFloat(getComputedStyle(input).paddingLeft),
      };
    });
    assert.ok(
      geometry.textStart >= geometry.iconRight + 8,
      `${viewport.width}px search text overlaps its icon: ${JSON.stringify(geometry)}`,
    );
  }
});

test('mobile global-search trigger is hidden on desktop and visible below the sidebar breakpoint', async t => {
  const page = await browserPage(t);
  await page.setContent('<!doctype html><html><body><button class="topbar-icon-btn global-search-mobile-trigger"></button></body></html>');
  await page.addStyleTag({ path: path.join(frontendRoot, 'styles', 'base.css') });
  await page.addStyleTag({ path: path.join(frontendRoot, 'styles', 'layout.css') });
  await page.waitForTimeout(180);

  assert.equal(await page.locator('.global-search-mobile-trigger').evaluate(el => getComputedStyle(el).display), 'none');
  await page.setViewportSize({ width: 768, height: 1024 });
  assert.equal(await page.locator('.global-search-mobile-trigger').evaluate(el => getComputedStyle(el).display), 'grid');
});

test('global search opens from the platform shortcut and groups matching entities', async t => {
  const page = await mountApp(t);
  await page.keyboard.press('Control+K');
  const input = page.getByRole('combobox', { name: '全局搜索' });
  await input.fill('GMV');
  await page.getByText('门店 GMV 异常', { exact: true }).first().waitFor({ timeout: 1500 });

  assert.equal(await page.getByRole('dialog', { name: '全局搜索' }).count(), 1);
  assert.deepEqual(await page.evaluate(() => window.searchRecordQueries.at(-1)), {
    search: 'GMV', page: 1, pageSize: 5,
  });
  assert.match(await page.locator('#global-search-results').innerText(), /异常记录/);
  assert.match(await page.locator('#global-search-results').innerText(), /异常规则/);
  const groupSemantics = await page.locator('#global-search-results > .command-group').evaluateAll(groups => groups.map(group => ({
    role: group.getAttribute('role'),
    labelledBy: group.getAttribute('aria-labelledby'),
    hasLabel: !!document.getElementById(group.getAttribute('aria-labelledby')),
  })));
  assert.ok(groupSemantics.length > 0);
  assert.ok(groupSemantics.every(group => group.role === 'group' && group.labelledBy && group.hasLabel));
  assert.match(await page.locator('#global-search-status').textContent(), /找到 \d+ 个结果/);
});

test('global search selection opens the existing entity surface and Escape restores focus', async t => {
  const page = await mountApp(t);
  await page.locator('#global-search-trigger').focus();
  await page.locator('#global-search-trigger').click();
  await page.getByRole('combobox', { name: '全局搜索' }).fill('经营分析库');
  await page.getByText('经营分析库', { exact: true }).waitFor();
  await page.keyboard.press('ArrowDown');
  const activeOption = await page.getByRole('combobox', { name: '全局搜索' }).getAttribute('aria-activedescendant');
  assert.ok(activeOption);
  assert.equal(await page.locator(`#${activeOption}`).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Enter');

  assert.deepEqual(await page.evaluate(() => window.openedItems), [['datasources', 'source-1']]);
  assert.match(await page.evaluate(() => location.hash), /datasources/);

  await page.locator('#global-search-trigger').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'global-search-trigger');
});

test('global search traps keyboard focus inside its modal surface', async t => {
  const page = await mountApp(t);
  await page.locator('#global-search-trigger').click();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('command-close')), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'global-search-input');
});

test('global search ignores stale record responses and renders failures inline', async t => {
  const page = await mountApp(t);
  await page.evaluate(() => {
    Store.peekRecordsPage = async query => {
      if (query.search === 'slow') {
        await new Promise(resolve => setTimeout(resolve, 320));
        return { items: [{ id: 'old', ruleName: '过期结果', datasetName: '旧数据', field: 'old' }], total: 1 };
      }
      if (query.search === 'broken') throw new Error('搜索服务连接失败');
      await new Promise(resolve => setTimeout(resolve, 10));
      return { items: [{ id: 'new', ruleName: '最新结果', datasetName: '新数据', field: 'new' }], total: 1 };
    };
  });
  await page.locator('#global-search-trigger').click();
  const input = page.getByRole('combobox', { name: '全局搜索' });
  await input.fill('slow');
  await page.waitForTimeout(170);
  await input.fill('fast');
  await page.getByText('最新结果', { exact: true }).waitFor();
  await page.waitForTimeout(220);
  assert.equal(await page.getByText('过期结果', { exact: true }).count(), 0);

  await input.fill('broken');
  await page.locator('.command-state-error strong').getByText('搜索暂时不可用', { exact: true }).waitFor();
  assert.match(await page.locator('#global-search-results').innerText(), /搜索服务连接失败/);
  assert.equal(await page.locator('#global-search-status').textContent(), '搜索暂时不可用');
});

test('opening an existing datasource directly shows its edit surface', async t => {
  const page = await browserPage(t);
  await page.setContent('<!doctype html><html><body><div id="toast-container"></div></body></html>');
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'icons.js') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'components.js') });
  await page.evaluate(() => {
    const source = {
      id: 'source-1', name: '经营分析库', description: '经营 ADS', type: 'starrocks', host: '127.0.0.1',
      port: 9030, database: 'ads', username: 'analyst', password: '', ssl: false,
    };
    window.Store = { getDatasource: id => id === source.id ? source : null };
  });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'datasource.js') });

  await page.evaluate(() => DatasourceModule.openItem('source-1'));

  assert.match(await page.getByRole('dialog').innerText(), /编辑数据源/);
  assert.equal(await page.locator('#f-name').inputValue(), '经营分析库');
});
