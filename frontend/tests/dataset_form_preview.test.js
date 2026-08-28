const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('./browser');

const frontendRoot = path.join(__dirname, '..');

async function datasetPage(t) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(2000);
  await page.setContent('<div id="actions"></div><main id="content"></main><div id="toast-container"></div>');
  for (const script of ['icons', 'components']) await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', `${script}.js`) });
  await page.evaluate(() => {
    window.calls = { save: 0, execute: 0, validate: [] };
    const source = { id: 'source-1', name: '<img src=x onerror="window.injected=true">', type: 'mysql' };
    window.dataset = { id: 'dataset-1', name: 'Saved', datasourceId: source.id, datasourceName: source.name, fields: [{ name: 'value', type: 'varchar' }], rowCount: 1, sql: 'SELECT 1' };
    window.Store = {
      getDatasources: () => [source], getDatasource: () => source,
      getDatasets: () => [], getDataset: () => dataset,
      validateDatasetSql: async sql => { calls.validate.push(sql); return { valid: true }; },
      executeDatasetSql: async () => { calls.execute++; return new Promise(resolve => { window.finishQuery = resolve; }); },
      addDataset: async () => { calls.save++; return new Promise(resolve => { window.finishSave = () => resolve(dataset); }); },
      executeDataset: async () => { throw new Error('preview unavailable'); },
      refresh: async () => new Promise(resolve => { window.finishRefresh = resolve; }),
    };
  });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'dataset.js') });
  await page.evaluate(() => DatasetModule.render(document.querySelector('#content'), { actionsEl: document.querySelector('#actions') }));
  return page;
}

test('explicit SQL validation uses server semantics for SELECT 1 and CTE', async t => {
  const page = await datasetPage(t);
  await page.click('#ds-add');
  for (const sql of ['SELECT 1', 'WITH x AS (SELECT 1) SELECT * FROM x']) {
    await page.locator('.sql-textarea').fill(sql);
    await page.locator('#editor-validate-btn').dispatchEvent('click');
    await page.waitForFunction(count => calls.validate.length === count, sql.startsWith('WITH') ? 2 : 1);
  }
  assert.deepEqual(await page.evaluate(() => calls.validate), ['SELECT 1', 'WITH x AS (SELECT 1) SELECT * FROM x']);
});

test('dataset creation is single flight and remains successful if its preview fails', async t => {
  const page = await datasetPage(t);
  await page.click('#ds-add');
  await page.fill('#f-name', 'New dataset');
  await page.selectOption('#f-datasource', 'source-1');
  await page.evaluate(() => { document.querySelector('#f-save').click(); document.querySelector('#f-save').click(); });
  assert.equal(await page.evaluate(() => calls.save), 1);
  assert.equal(await page.locator('#f-save').isDisabled(), true);
  await page.evaluate(() => finishSave());
  await page.waitForFunction(() => !document.querySelector('#f-save'));
  assert.match(await page.locator('#toast-container').innerText(), /已创建/);
  assert.match(await page.locator('#toast-container').innerText(), /预览.*失败/);
  assert.doesNotMatch(await page.locator('#toast-container').innerText(), /保存失败/);
});

test('a closed dataset form does not repaint a different route after save', async t => {
  const page = await datasetPage(t);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.click('#ds-add'); await page.fill('#f-name', 'New'); await page.selectOption('#f-datasource', 'source-1');
  await page.click('#f-save');
  await page.click('[data-action="cancel"]');
  await page.evaluate(() => { document.querySelector('#content').innerHTML = '<div id="ds-table">Other page</div><div id="ds-stats">Other stats</div>'; finishSave(); });
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#ds-table').innerText(), 'Other page');
  assert.equal(await page.locator('#toast-container').innerText(), '');
  assert.deepEqual(errors, []);
});

test('dataset refresh fetches once and does not repaint a reused route container', async t => {
  const page = await datasetPage(t);
  await page.click('#ds-refresh-list');
  assert.equal(await page.locator('#ds-refresh-list').isDisabled(), true);
  await page.evaluate(() => { document.querySelector('#content').innerHTML = '<div id="ds-table">Other page</div><div id="ds-stats">Other stats</div>'; finishRefresh(); });
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#ds-table').innerText(), 'Other page');
});

test('query preview executes legal SELECT 1, escapes loading names and downloads safe CSV bytes', async t => {
  const page = await datasetPage(t);
  await page.evaluate(() => DatasetModule.openItem('dataset-1'));
  await page.click('#q-run');
  assert.equal(await page.evaluate(() => calls.execute), 1);
  assert.equal(await page.locator('#result-area img').count(), 0);
  await page.evaluate(() => finishQuery({ rows: [{ value: '=SUM(1,2)', n: -7 }, { value: 'line "one"\n二', n: 2 }, { value: '\t +cmd', n: 3 }], fields: [{ name: 'value', type: 'varchar' }, { name: 'n', type: 'int' }], elapsed_ms: 2 }));
  const downloadPromise = page.waitForEvent('download');
  await page.click('#result-export');
  const download = await downloadPromise;
  const bytes = require('node:fs').readFileSync(await download.path());
  assert.equal(bytes.subarray(0, 3).toString('hex'), 'efbbbf');
  const csv = bytes.toString('utf8');
  assert.match(csv, /"'=SUM\(1,2\)"/);
  assert.match(csv, /"line ""one""\n二"/);
  assert.match(csv, /'\t \+cmd/);
  assert.match(csv, /-7/);
  assert.equal(await page.evaluate(() => window.injected), undefined);
});

test('closing a query drawer cancels its delayed automatic execution', async t => {
  const page = await datasetPage(t);
  await page.evaluate(() => { dataset.sql = 'SELECT * FROM sample'; DatasetModule.openItem('dataset-1'); document.querySelector('#q-close').click(); });
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => calls.execute), 0);
});

test('a query response does not write into or notify a closed drawer', async t => {
  const page = await datasetPage(t);
  await page.evaluate(() => { dataset.sql = 'SELECT * FROM sample'; DatasetModule.openItem('dataset-1'); });
  await page.click('#q-run'); await page.click('#q-close');
  await page.evaluate(() => finishQuery({ rows: [{ value: 'late' }], fields: dataset.fields, elapsed_ms: 1 }));
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#toast-container').innerText(), '');
});

test('an empty manual query does not auto-execute twice and cannot produce an export success', async t => {
  const page = await datasetPage(t);
  await page.evaluate(() => { DatasetModule.openItem('dataset-1'); document.querySelector('#q-run').click(); finishQuery({ rows: [], fields: dataset.fields, elapsed_ms: 1 }); });
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => calls.execute), 1);
  await page.click('#result-export');
  assert.match(await page.locator('#toast-container').innerText(), /暂无数据可导出/);
  assert.doesNotMatch(await page.locator('#toast-container').innerText(), /导出已开始/);
});

async function deletableDatasetPage(t) {
  const page = await datasetPage(t);
  await page.evaluate(() => {
    window.deleteCalls = 0; Store.getDatasets = () => [dataset];
    Store.deleteDataset = async () => { deleteCalls++; return new Promise((resolve, reject) => { window.finishDelete = resolve; window.failDelete = () => reject(new Error('late delete failed')); }); };
    DatasetModule.render(document.querySelector('#content'), { actionsEl: document.querySelector('#actions') });
  });
  return page;
}

test('dataset deletion stays single flight through confirmation and request rerenders', async t => {
  const page = await deletableDatasetPage(t);
  await page.click('[data-action="delete"]');
  assert.equal(await page.locator('[data-action="delete"]').isDisabled(), true);
  await page.click('[data-action="cancel"]');
  assert.equal(await page.locator('[data-action="delete"]').isDisabled(), false);
  await page.click('[data-action="delete"]'); await page.click('[data-action="confirm"]');
  await page.fill('#ds-search', 'Saved');
  await page.locator('[data-action="delete"]').dispatchEvent('click');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.locator('[data-action="delete"]').isDisabled(), true);
  assert.equal(await page.evaluate(() => deleteCalls), 1);
  await page.evaluate(() => finishDelete());
  await page.waitForFunction(() => !document.querySelector('[data-action="delete"]').disabled);
});

test('late dataset deletion failure cannot notify a replacement page', async t => {
  const page = await deletableDatasetPage(t);
  await page.click('[data-action="delete"]'); await page.click('[data-action="confirm"]');
  await page.evaluate(() => { document.querySelector('#content').innerHTML = '<h2>Other page</h2>'; failDelete(); });
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#toast-container').innerText(), '');
});

test('opening an existing dataset directly shows its query preview', async t => {
  const browser = await chromium.launch({
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body><div id="toast-container"></div></body></html>');
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'icons.js') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'components.js') });
  await page.evaluate(() => {
    const source = { id: 'source-1', name: '经营 ADS', type: 'starrocks' };
    const dataset = {
      id: 'dataset-1', name: '门店日经营', datasourceId: source.id, datasourceName: source.name,
      description: '', sql: 'SELECT store_id FROM store_daily LIMIT 10', rowCount: 12,
      fields: [{ name: 'store_id', type: 'VARCHAR' }],
    };
    window.Store = {
      getDataset: id => id === dataset.id ? dataset : null,
      getDatasource: id => id === source.id ? source : null,
      executeDatasetSql: async () => ({ fields: dataset.fields, rows: [], elapsed_ms: 1 }),
    };
  });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'dataset.js') });

  await page.evaluate(() => DatasetModule.openItem('dataset-1'));

  assert.equal(await page.getByRole('dialog').count(), 1);
  assert.match(await page.getByRole('dialog').innerText(), /门店日经营/);
  assert.match(await page.locator('.sql-textarea').inputValue(), /SELECT store_id/);
});

test('running StarRocks SQL in the dataset form renders the returned preview rows', async t => {
  const browser = await chromium.launch({
    headless: true,
  });
  t.after(() => browser.close());

  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.setContent(`
    <!doctype html>
    <html>
      <body>
        <div id="actions"></div>
        <div id="content"></div>
        <div id="toast-container"></div>
      </body>
    </html>
  `);
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'icons.js') });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'components.js') });
  await page.evaluate(() => {
    const datasource = {
      id: 'starrocks-1',
      name: '经营 ADS',
      type: 'starrocks',
    };
    window.Store = {
      getDatasets: () => [],
      getDatasources: () => [datasource],
      getDatasource: id => id === datasource.id ? datasource : null,
      executeDatasetSql: async () => ({
        fields: [
          { name: 'store_id', type: 'VARCHAR' },
          { name: 'revenue', type: 'DECIMAL' },
        ],
        rows: [
          { store_id: 'SH-001', revenue: '1288.50' },
          { store_id: 'BJ-002', revenue: '956.00' },
        ],
        row_count: 2,
        truncated: false,
        elapsed_ms: 12.5,
      }),
    };
  });
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', 'dataset.js') });
  await page.evaluate(() => {
    DatasetModule.render(document.getElementById('content'), {
      actionsEl: document.getElementById('actions'),
    });
  });

  await page.click('#ds-add');
  await page.selectOption('#f-datasource', 'starrocks-1');
  await page.click('#f-run');

  await page.locator('#form-preview-area .results-table').waitFor();
  assert.equal(await page.locator('#form-preview-area tbody tr').count(), 2);
  assert.deepEqual(
    await page.locator('#form-preview-area tbody tr').first().locator('td').allTextContents(),
    ['1', 'SH-001', '1288.50'],
  );
  assert.match(await page.locator('#form-preview-count').textContent(), /2/);
  assert.deepEqual(pageErrors, []);
});
