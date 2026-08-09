const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');

const frontendRoot = path.join(__dirname, '..');

test('running StarRocks SQL in the dataset form renders the returned preview rows', async t => {
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
