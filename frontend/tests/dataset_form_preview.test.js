const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('./browser');

const frontendRoot = path.join(__dirname, '..');

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
