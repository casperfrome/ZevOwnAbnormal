const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('./browser');

const frontendRoot = path.join(__dirname, '..');

async function datasourcePage(t) {
  const page = await browserPage(t);
  await page.setContent('<div id="actions"></div><div id="content"></div><div id="toast-container"></div>');
  for (const script of ['icons', 'components']) await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', `${script}.js`) });
  await page.evaluate(() => {
    const ds = { id: 'source-1', name: 'Source', type: 'mysql', host: 'localhost', port: 3306, database: 'test', username: 'reader', password: '', hasPassword: true, status: 'online' };
    window.source = ds; window.saveCalls = 0; window.refreshCalls = 0;
    window.Store = {
      getDatasources: () => [ds], getDatasource: () => ds,
      updateDatasource: async () => { saveCalls++; return new Promise(resolve => { window.finishSave = resolve; }); },
      testDatasourceConfig: async payload => { window.testPayload = payload; },
      testDatasource: async () => ({ ok: true, refreshWarning: 'refresh offline' }),
      refresh: async () => { refreshCalls++; return new Promise(resolve => { window.finishRefresh = resolve; }); },
    };
  });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'datasource.js') });
  await page.evaluate(() => DatasourceModule.render(document.querySelector('#content'), { actionsEl: document.querySelector('#actions') }));
  return page;
}

test('datasource edit locks type and tests with saved identity without an empty password', async t => {
  const page = await datasourcePage(t);
  assert.doesNotMatch(await page.locator('#ds-stats').innerText(), /覆盖 2 种类型/);
  await page.evaluate(() => DatasourceModule.openItem('source-1'));
  assert.match(await page.getByRole('dialog').innerText(), /类型.*不可修改/);
  assert.match(await page.getByRole('dialog').innerText(), /留空.*保留/);
  assert.equal(await page.locator('[data-type="starrocks"]').getAttribute('aria-disabled'), 'true');
  await page.locator('[data-type="starrocks"]').dispatchEvent('click');
  assert.equal(await page.locator('.radio-card.selected').getAttribute('data-type'), 'mysql');
  await page.click('#f-test');
  assert.equal(await page.evaluate(() => testPayload.id), 'source-1');
  assert.equal(await page.evaluate(() => Object.hasOwn(testPayload, 'password')), false);
});

test('datasource API username survives Store mapping into the edit form', async t => {
  const page = await datasourcePage(t);
  await page.evaluate(() => {
    window.fetch = async url => ({ ok: true, status: 200, json: async () => url.endsWith('/datasources') ? [{ id: 'source-1', name: 'MySQL', type: 'mysql', username: 'root', host: 'localhost', port: 3306, database: 'audit', has_password: true }] : url.endsWith('/overview') ? { stats: {} } : url.includes('/anomalies?') ? { items: [] } : [] });
  });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'data.js') });
  await page.evaluate(async () => { await Store.refresh(); DatasourceModule.openItem('source-1'); });
  assert.equal(await page.locator('#f-username').inputValue(), 'root');
  assert.equal(await page.locator('#f-password').inputValue(), '');
});

test('datasource save blocks duplicates and leaves a newly mounted dataset list untouched', async t => {
  const page = await datasourcePage(t);
  await page.evaluate(() => DatasourceModule.openItem('source-1'));
  await page.evaluate(() => { document.querySelector('#f-save').click(); document.querySelector('#f-save').click(); });
  assert.equal(await page.evaluate(() => saveCalls), 1);
  assert.equal(await page.locator('#f-save').isDisabled(), true);
  await page.click('[data-action="cancel"]');
  await page.evaluate(() => { document.querySelector('#content').innerHTML = '<div id="ds-table">Datasets</div><div id="ds-stats">Stats</div>'; finishSave(source); });
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#ds-table').innerText(), 'Datasets');
  assert.equal(await page.locator('#toast-container').innerText(), '');
});

test('datasource refresh awaits a real request and respects replaced child ownership', async t => {
  const page = await datasourcePage(t);
  await page.click('#ds-refresh');
  assert.equal(await page.evaluate(() => refreshCalls), 1);
  assert.equal(await page.locator('#ds-refresh').isDisabled(), true);
  await page.evaluate(() => { document.querySelector('#content').innerHTML = '<div id="ds-table">Datasets</div><div id="ds-stats">Stats</div>'; finishRefresh(); });
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#ds-table').innerText(), 'Datasets');
});

test('datasource connection success keeps refresh failure as a separate warning', async t => {
  const page = await datasourcePage(t);
  await page.click('[data-action="test"]');
  assert.match(await page.locator('#toast-container').innerText(), /连接成功/);
  assert.match(await page.locator('#toast-container').innerText(), /刷新.*失败/);
  assert.doesNotMatch(await page.locator('#toast-container').innerText(), /连接失败/);
});

test('pending datasource tests survive matching search rerenders and release replacement controls', async t => {
  const page = await datasourcePage(t);
  await page.evaluate(() => { window.testCalls = 0; Store.testDatasource = async () => { testCalls++; return new Promise(resolve => { window.finishTest = resolve; }); }; });
  await page.click('[data-action="test"]');
  await page.fill('#ds-search', 'Source');
  await page.locator('[data-action="test"]').dispatchEvent('click');
  assert.equal(await page.evaluate(() => testCalls), 1);
  assert.equal(await page.locator('[data-action="test"]').isDisabled(), true);
  await page.evaluate(() => finishTest({ ok: true }));
  await page.waitForFunction(() => !document.querySelector('[data-action="test"]').disabled);
});

test('datasource deletion stays single flight through confirmation and request rerenders', async t => {
  const page = await datasourcePage(t);
  await page.evaluate(() => { window.deleteCalls = 0; Store.deleteDatasource = async () => { deleteCalls++; return new Promise((resolve, reject) => { window.failDelete = () => reject(new Error('delete failed')); }); }; });
  await page.click('[data-action="delete"]');
  assert.equal(await page.locator('[data-action="delete"]').isDisabled(), true);
  await page.click('[data-action="cancel"]');
  assert.equal(await page.locator('[data-action="delete"]').isDisabled(), false);
  await page.click('[data-action="delete"]'); await page.click('[data-action="confirm"]');
  await page.fill('#ds-search', 'Source');
  await page.locator('[data-action="delete"]').dispatchEvent('click');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.locator('[data-action="delete"]').isDisabled(), true);
  assert.equal(await page.evaluate(() => deleteCalls), 1);
  await page.evaluate(() => failDelete());
  await page.waitForFunction(() => !document.querySelector('[data-action="delete"]').disabled);
  assert.match(await page.locator('#toast-container').innerText(), /删除失败/);
});

test('late datasource deletion failure cannot notify a replacement page', async t => {
  const page = await datasourcePage(t);
  await page.evaluate(() => { Store.deleteDatasource = async () => new Promise((resolve, reject) => { window.failDelete = () => reject(new Error('late delete failed')); }); });
  await page.click('[data-action="delete"]'); await page.click('[data-action="confirm"]');
  await page.evaluate(() => { document.querySelector('#content').innerHTML = '<h2>Other page</h2>'; failDelete(); });
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#toast-container').innerText(), '');
});

async function browserPage(t, viewport = { width: 1280, height: 720 }) {
  const browser = await chromium.launch({ headless: true });
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
      <div class="nav-item" data-route="account"></div>
      <div class="nav-item" data-route="accounts" hidden></div>
      <button class="sidebar-user"><span class="user-avatar"></span><span class="user-name"></span><span class="user-role"></span></button>
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
      severity: 'high', status: 'pending', occurredAt: '2026-08-22 10:00', field: 'gmv', value: 999,
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
      getCurrentUser: () => testScenario.user || { id: 'user-1', display_name: '管理员', job_title: '', login_name: 'admin', is_superuser: true, is_active: true, auto_login: false },
      isSuperuser: () => (testScenario.user?.is_superuser ?? true) === true,
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
    window.AccountModule = module('account');
    window.AccountsModule = module('accounts');
  }, scenario);
  if (initialHash) await page.evaluate(hash => history.replaceState(null, '', hash), initialHash);
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'app.js') });
  return page;
}

test('authenticated identity populates the sidebar and only administrators see account management', async t => {
  const admin = await mountApp(t, { user: { id: 'u1', display_name: '沈一鸣', job_title: '数据工程师', login_name: 'shen', is_superuser: true, is_active: true, auto_login: false } });
  await admin.getByText('records', { exact: true }).waitFor();
  assert.equal(await admin.locator('.user-name').innerText(), '沈一鸣');
  assert.equal(await admin.locator('.user-role').innerText(), '数据工程师');
  assert.equal(await admin.locator('[data-route="accounts"]').getAttribute('hidden'), null);

  const reader = await mountApp(t, { user: { id: 'u2', display_name: '王小明', job_title: '', login_name: 'reader', is_superuser: false, is_active: true, auto_login: false } });
  await reader.getByText('records', { exact: true }).waitFor();
  assert.equal(await reader.locator('[data-route="accounts"]').getAttribute('hidden'), '');
  await reader.evaluate(() => App.navigate('accounts'));
  assert.match(await reader.locator('#page-root').innerText(), /我的账号/);
});

test('page headers omit the eyebrow label', async t => {
  const page = await mountApp(t);
  await page.getByRole('heading', { name: '异常记录' }).waitFor();

  assert.equal(await page.locator('.page-eyebrow').count(), 0);
});

test('page titles use the primary purple theme color', async t => {
  const page = await mountApp(t);
  await page.addStyleTag({ path: path.join(frontendRoot, 'styles', 'base.css') });
  await page.addStyleTag({ path: path.join(frontendRoot, 'styles', 'layout.css') });
  const title = page.getByRole('heading', { name: '异常记录' });
  await title.waitFor();

  const colors = await title.evaluate(element => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--color-primary)';
    document.body.appendChild(probe);
    const result = {
      title: getComputedStyle(element).color,
      primary: getComputedStyle(probe).color,
    };
    probe.remove();
    return result;
  });
  assert.equal(colors.title, colors.primary);
});

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
