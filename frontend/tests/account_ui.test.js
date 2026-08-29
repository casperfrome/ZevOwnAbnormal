const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('./browser');

const frontendRoot = path.join(__dirname, '..');

async function pageWithAccountModule(t, moduleName, store) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setContent('<div id="toast-container"></div><div id="actions"></div><main id="content"></main>');
  for (const script of ['icons', 'components']) {
    await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', `${script}.js`) });
  }
  await page.evaluate(value => { window.Store = value; }, store);
  await page.addScriptTag({ path: path.join(frontendRoot, 'scripts', `${moduleName}.js`) });
  return page;
}

test('my account renders real identity and saves profile and credentials once', async t => {
  const page = await pageWithAccountModule(t, 'account', {
    currentUser: { id: 'u1', display_name: '沈一鸣', job_title: '数据工程师', login_name: 'shen', is_superuser: false, is_active: true, auto_login: false },
  });
  await page.evaluate(() => {
    Store.getCurrentUser = () => Store.currentUser;
    Store.updateOwnProfile = async payload => { window.profilePayload = payload; Store.currentUser = { ...Store.currentUser, ...payload }; return Store.currentUser; };
    Store.updateOwnCredentials = async payload => { window.credentialsPayload = payload; Store.currentUser = { ...Store.currentUser, ...payload }; return Store.currentUser; };
    Store.logout = async () => { window.loggedOut = true; };
    AccountModule.render(document.querySelector('#content'), { actionsEl: document.querySelector('#actions'), onUserChanged: user => { window.changedUser = user; } });
  });

  assert.equal(await page.getByLabel('姓名').inputValue(), '沈一鸣');
  assert.equal(await page.getByLabel('岗位').inputValue(), '数据工程师');
  await page.getByLabel('姓名').fill('沈一');
  await page.getByRole('button', { name: '保存个人资料' }).click();
  assert.deepEqual(await page.evaluate(() => profilePayload), { display_name: '沈一', job_title: '数据工程师' });
  assert.equal(await page.locator('.identity-name').innerText(), '沈一');

  await page.getByLabel('登录名').fill('shen-new');
  await page.getByLabel('新密码').fill('secret');
  await page.getByRole('button', { name: '保存登录设置' }).click();
  assert.deepEqual(await page.evaluate(() => credentialsPayload), { login_name: 'shen-new', password: 'secret' });
  assert.equal(await page.evaluate(() => changedUser.login_name), 'shen-new');
  assert.equal(await page.locator('.identity-login').innerText(), '@shen-new');
});

test('administrator can search, add, edit status, reset password and delete accounts', async t => {
  const page = await pageWithAccountModule(t, 'accounts', {
    accounts: [
      { id: 'admin', display_name: '管理员', job_title: '', login_name: 'admin', is_superuser: true, is_active: true, created_at: '2026-08-29T00:00:00', updated_at: '2026-08-29T00:00:00' },
      { id: 'u2', display_name: '王小明', job_title: '分析师', login_name: 'analyst', is_superuser: false, is_active: true, created_at: '2026-08-29T00:00:00', updated_at: '2026-08-29T00:00:00' },
    ],
  });
  await page.evaluate(() => {
    Store.getAccounts = () => [...Store.accounts];
    Store.loadAccounts = async () => [...Store.accounts];
    Store.createAccount = async payload => { window.createdPayload = payload; Store.accounts.push({ id: 'u3', ...payload, is_active: true, created_at: '2026-08-29T00:00:00', updated_at: '2026-08-29T00:00:00' }); };
    Store.updateAccount = async (id, payload) => { window.updatedPayload = [id, payload]; Store.accounts = Store.accounts.map(item => item.id === id ? { ...item, ...payload } : item); };
    Store.resetAccountPassword = async (id, password) => { window.resetPayload = [id, password]; };
    Store.deleteAccount = async id => { window.deletedId = id; Store.accounts = Store.accounts.filter(item => item.id !== id); };
    AccountsModule.render(document.querySelector('#content'), { actionsEl: document.querySelector('#actions') });
  });

  await page.getByPlaceholder('搜索姓名、登录名或岗位').fill('王小明');
  assert.match(await page.locator('#account-list').innerText(), /王小明/);
  assert.doesNotMatch(await page.locator('#account-list').innerText(), /管理员/);

  await page.getByRole('button', { name: '添加账号' }).click();
  await page.getByLabel('姓名').fill('李雷');
  await page.getByLabel('登录名').fill('lilei');
  await page.getByLabel('密码').fill('pw');
  await page.getByRole('dialog').getByRole('button', { name: '添加账号' }).click();
  assert.equal(await page.evaluate(() => createdPayload.login_name), 'lilei');

  await page.getByPlaceholder('搜索姓名、登录名或岗位').fill('王小明');
  await page.getByRole('button', { name: '停用王小明' }).click();
  await page.getByRole('button', { name: '确认停用' }).click();
  assert.deepEqual(await page.evaluate(() => updatedPayload), ['u2', { is_active: false }]);

  await page.getByRole('button', { name: '更多操作 王小明' }).first().click();
  await page.getByRole('button', { name: '重置密码' }).click();
  await page.getByLabel('新密码').fill('reset');
  await page.getByRole('dialog').getByRole('button', { name: '重置密码' }).click();
  assert.deepEqual(await page.evaluate(() => resetPayload), ['u2', 'reset']);

  await page.getByRole('button', { name: '更多操作 王小明' }).first().click();
  await page.getByRole('button', { name: '永久删除' }).click();
  await page.getByRole('button', { name: '永久删除' }).click();
  assert.equal(await page.evaluate(() => deletedId), 'u2');

  await page.evaluate(() => AccountsModule.render(document.querySelector('#content'), { actionsEl: document.querySelector('#actions') }));
  await page.getByPlaceholder('搜索姓名、登录名或岗位').waitFor();
  assert.match(await page.locator('#account-list').innerText(), /管理员/);
});
