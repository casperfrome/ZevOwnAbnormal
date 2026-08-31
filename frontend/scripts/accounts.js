/* Administrator account lifecycle management. */
window.AccountsModule = (function () {
  const escapeHtml = value => UI.escapeHtml(String(value ?? ''));
  let container;
  let actionsEl;
  let query = '';

  const matches = account => [account.display_name, account.login_name, account.job_title]
    .some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(query));

  function badge(account) {
    return `<span class="account-status ${account.is_active ? 'active' : 'disabled'}"><i></i>${account.is_active ? '正常' : '已停用'}</span>`;
  }

  function renderList() {
    if (!container?.isConnected) return;
    const accounts = Store.getAccounts().filter(matches);
    const total = container.querySelector('#account-total');
    if (total) total.textContent = `共 ${accounts.length} 个账号`;
    const rows = accounts.map(account => `
      <tr>
        <td><div class="account-identity-cell"><span class="mini-avatar">${escapeHtml([...(account.display_name || account.login_name)].slice(0, 2).join(''))}</span><span><strong>${escapeHtml(account.display_name)}</strong><small>@${escapeHtml(account.login_name)}</small></span></div></td>
        <td>${escapeHtml(account.job_title || '—')}</td>
        <td><span class="badge ${account.is_superuser ? 'badge-primary' : 'badge-neutral'}">${account.is_superuser ? '管理员' : '普通用户'}</span></td>
        <td>${badge(account)}</td>
        <td class="cell-muted">${UI.formatTime(account.updated_at)}</td>
        <td><div class="cell-actions">
          <button class="row-action" data-action="toggle" data-id="${escapeHtml(account.id)}" aria-label="${account.is_active ? '停用' : '启用'}${escapeHtml(account.display_name)}">${account.is_active ? Icon.pause({ size: 15 }) : Icon.play({ size: 15 })}</button>
          <button class="row-action" data-action="more" data-id="${escapeHtml(account.id)}" aria-label="更多操作 ${escapeHtml(account.display_name)}">${Icon.moreV({ size: 16 })}</button>
        </div></td>
      </tr>`).join('');
    const cards = accounts.map(account => `<article class="account-mobile-card"><div class="account-card-top"><strong>${escapeHtml(account.display_name)}</strong>${badge(account)}</div><div class="cell-muted">@${escapeHtml(account.login_name)} · ${escapeHtml(account.job_title || '未设置岗位')}</div><div class="account-card-actions"><button class="btn btn-sm btn-secondary" data-action="toggle" data-id="${escapeHtml(account.id)}">${account.is_active ? '停用' : '启用'}</button><button class="btn btn-sm btn-secondary" data-action="more" data-id="${escapeHtml(account.id)}" aria-label="更多操作 ${escapeHtml(account.display_name)}">更多</button></div></article>`).join('');
    container.querySelector('#account-list').innerHTML = accounts.length ? `
      <div class="table-wrap accounts-table"><table class="data-table"><thead><tr><th>账号</th><th>岗位</th><th>权限</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="accounts-mobile-list">${cards}</div>` : UI.emptyState({ icon: Icon.users({ size: 24 }), title: '没有匹配的账号', desc: '调整搜索条件后再试。' });
  }

  function accountForm(account) {
    const creating = !account;
    const drawer = UI.drawer({
      title: creating ? '添加账号' : '编辑账号',
      subtitle: creating ? '创建一个可立即登录的平台账号' : `@${account.login_name}`,
      body: `<form id="account-editor">
        ${UI.field('姓名', `<input class="input" id="managed-display-name" aria-label="姓名" value="${escapeHtml(account?.display_name)}" required />`, { required: true })}
        ${UI.field('岗位', `<input class="input" id="managed-job-title" aria-label="岗位" value="${escapeHtml(account?.job_title)}" />`, { optional: true })}
        ${UI.field('登录名', `<input class="input mono" id="managed-login-name" aria-label="登录名" value="${escapeHtml(account?.login_name)}" required />`, { required: true })}
        ${creating ? UI.field('密码', '<input class="input" id="managed-password" aria-label="密码" type="password" autocomplete="new-password" required />', { required: true }) : ''}
        <label class="checkbox-row"><input id="managed-superuser" type="checkbox" ${account?.is_superuser ? 'checked' : ''}/><span><strong>管理员</strong><small>可以管理平台配置和其他账号</small></span></label>
      </form>`,
      footer: `<button class="btn btn-secondary" data-action="cancel">取消</button><button class="btn btn-primary" data-action="save">${creating ? '添加账号' : '保存更改'}</button>`,
    });
    drawer.drawer.querySelector('[data-action="cancel"]').addEventListener('click', drawer.close);
    drawer.drawer.querySelector('[data-action="save"]').addEventListener('click', async event => {
      if (event.currentTarget.disabled) return;
      const payload = {
        display_name: drawer.drawer.querySelector('#managed-display-name').value.trim(),
        job_title: drawer.drawer.querySelector('#managed-job-title').value.trim(),
        login_name: drawer.drawer.querySelector('#managed-login-name').value.trim(),
        is_superuser: drawer.drawer.querySelector('#managed-superuser').checked,
      };
      if (creating) payload.password = drawer.drawer.querySelector('#managed-password').value;
      if (!payload.display_name || !payload.login_name || (creating && !payload.password)) return;
      event.currentTarget.disabled = true;
      try {
        if (creating) await Store.createAccount(payload); else await Store.updateAccount(account.id, payload);
        drawer.close(); renderList(); UI.toast(creating ? '账号已添加' : '账号已更新', 'success');
      } catch (error) { event.currentTarget.disabled = false; UI.toast(error.message || '保存失败', 'error'); }
    });
  }

  function resetPassword(account) {
    const modal = UI.modal({
      title: '重置密码', subtitle: `为 ${account.display_name} 设置新密码`,
      body: UI.field('新密码', '<input class="input" id="reset-account-password" aria-label="新密码" type="password" autocomplete="new-password" />', { required: true }),
      footer: '<button class="btn btn-secondary" data-action="cancel">取消</button><button class="btn btn-primary" data-action="reset">重置密码</button>',
    });
    modal.dialog.querySelector('[data-action="cancel"]').addEventListener('click', modal.close);
    modal.dialog.querySelector('[data-action="reset"]').addEventListener('click', async event => {
      const password = modal.dialog.querySelector('#reset-account-password').value;
      if (!password || event.currentTarget.disabled) return;
      event.currentTarget.disabled = true;
      try { await Store.resetAccountPassword(account.id, password); modal.close(); UI.toast('密码已重置', 'success'); }
      catch (error) { event.currentTarget.disabled = false; UI.toast(error.message || '重置失败', 'error'); }
    });
  }

  function moreActions(account) {
    const modal = UI.modal({
      title: account.display_name, subtitle: `@${account.login_name}`,
      body: `<div class="account-action-menu"><button class="btn btn-secondary" data-action="edit">${Icon.edit({ size: 15 })}编辑账号</button><button class="btn btn-secondary" data-action="password">${Icon.lock({ size: 15 })}重置密码</button><button class="btn btn-danger" data-action="delete">${Icon.trash({ size: 15 })}永久删除</button></div>`,
    });
    modal.dialog.querySelector('[data-action="edit"]').addEventListener('click', () => { modal.close(); accountForm(account); });
    modal.dialog.querySelector('[data-action="password"]').addEventListener('click', () => { modal.close(); resetPassword(account); });
    modal.dialog.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      modal.close();
      const confirmed = await UI.confirm({ title: '永久删除账号', desc: `删除 ${account.display_name}（@${account.login_name}）后无法恢复。`, confirmText: '永久删除', danger: true });
      if (!confirmed) return;
      try { await Store.deleteAccount(account.id); renderList(); UI.toast('账号已删除', 'success'); }
      catch (error) { UI.toast(error.message || '删除失败', 'error'); }
    });
  }

  async function toggle(account) {
    const next = !account.is_active;
    const confirmed = await UI.confirm({ title: next ? '启用账号' : '停用账号', desc: `${next ? '启用' : '停用'} ${account.display_name}？`, confirmText: `确认${next ? '启用' : '停用'}`, danger: !next });
    if (!confirmed) return;
    try { await Store.updateAccount(account.id, { is_active: next }); renderList(); UI.toast(`账号已${next ? '启用' : '停用'}`, 'success'); }
    catch (error) { UI.toast(error.message || '操作失败', 'error'); }
  }

  async function render(root, options = {}) {
    container = root; actionsEl = options.actionsEl; query = '';
    actionsEl.innerHTML = '<button class="btn btn-primary" id="account-add" type="button">' + Icon.plus({ size: 15 }) + '添加账号</button>';
    container.innerHTML = `<div class="account-toolbar"><div class="search-box">${Icon.search({ size: 15 })}<input id="account-search" type="search" placeholder="搜索姓名、登录名或岗位" /></div><span class="cell-muted" id="account-total"></span></div><div id="account-list">${UI.loadingState(5, 5)}</div>`;
    actionsEl.querySelector('#account-add').addEventListener('click', () => accountForm(null));
    container.querySelector('#account-search').addEventListener('input', event => { query = event.target.value.trim().toLocaleLowerCase('zh-CN'); renderList(); });
    container.querySelector('#account-list').addEventListener('click', event => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const account = Store.getAccounts().find(item => item.id === button.dataset.id);
      if (!account) return;
      if (button.dataset.action === 'toggle') toggle(account);
      if (button.dataset.action === 'more') moreActions(account);
    });
    try { await Store.loadAccounts(); if (container === root && root.isConnected) renderList(); }
    catch (error) { if (root.isConnected) root.querySelector('#account-list').innerHTML = UI.emptyState({ icon: Icon.alert({ size: 24 }), title: '账号加载失败', desc: error.message }); }
  }

  return { render };
})();
