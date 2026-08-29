/* Personal account profile and credential settings. */
window.AccountModule = (function () {
  const escapeHtml = value => UI.escapeHtml(String(value ?? ''));

  function render(container, options = {}) {
    const user = Store.getCurrentUser();
    if (!user) return;
    const initials = [...(user.display_name || user.login_name || '?')].slice(0, 2).join('').toUpperCase();
    container.innerHTML = `
      <div class="identity-band animate-rise">
        <div class="identity-avatar">${escapeHtml(initials)}</div>
        <div><div class="identity-name">${escapeHtml(user.display_name)}</div><div class="identity-login">@${escapeHtml(user.login_name)}</div></div>
        <span class="account-status active"><i></i>账号正常</span>
      </div>
      <div class="account-settings-grid">
        <section class="settings-card">
          <div class="settings-card-heading"><div>${Icon.user({ size: 18 })}</div><div><h2>个人资料</h2><p>这些信息会显示在平台侧栏和账号列表中。</p></div></div>
          <form id="profile-form">
            ${UI.field('姓名', `<input class="input" id="account-display-name" aria-label="姓名" value="${escapeHtml(user.display_name)}" autocomplete="name" required />`, { required: true })}
            ${UI.field('岗位', `<input class="input" id="account-job-title" aria-label="岗位" value="${escapeHtml(user.job_title)}" placeholder="例如：数据工程师" />`, { optional: true })}
            <div class="form-actions"><button class="btn btn-primary" type="submit">保存个人资料</button></div>
          </form>
        </section>
        <section class="settings-card">
          <div class="settings-card-heading"><div>${Icon.lock({ size: 18 })}</div><div><h2>登录与安全</h2><p>修改后，其他设备上的登录会立即失效。</p></div></div>
          <form id="credentials-form">
            ${UI.field('登录名', `<input class="input mono" id="account-login-name" aria-label="登录名" value="${escapeHtml(user.login_name)}" autocomplete="username" required />`, { required: true })}
            ${UI.field('新密码', '<input class="input" id="account-password" aria-label="新密码" type="password" autocomplete="new-password" placeholder="留空表示不修改" />', { optional: true, help: '密码非空即可，最多 72 个 UTF-8 字节。' })}
            <div class="form-actions"><button class="btn btn-primary" type="submit">保存登录设置</button></div>
          </form>
          ${user.auto_login ? '<div class="auto-login-note">当前为自动登录模式，退出登录不可用。</div>' : '<div class="settings-danger-row"><div><strong>退出当前会话</strong><span>返回登录页，不影响其他设备。</span></div><button class="btn btn-secondary" id="account-logout" type="button">退出登录</button></div>'}
        </section>
      </div>`;

    const owned = () => container.isConnected && container.querySelector('#profile-form');
    const runForm = (form, action, success) => {
      let pending = false;
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (pending) return;
        pending = true;
        const button = form.querySelector('[type="submit"]');
        button.disabled = true;
        try {
          const updated = await action();
          if (!owned()) return;
          container.querySelector('.identity-name').textContent = updated.display_name;
          container.querySelector('.identity-login').textContent = `@${updated.login_name}`;
          container.querySelector('.identity-avatar').textContent = [...(updated.display_name || updated.login_name || '?')].slice(0, 2).join('').toUpperCase();
          options.onUserChanged?.(updated);
          UI.toast(success, 'success');
        } catch (error) {
          if (owned()) UI.toast(error.message || '保存失败', 'error');
        } finally {
          pending = false;
          if (owned()) button.disabled = false;
        }
      });
    };

    runForm(container.querySelector('#profile-form'), () => Store.updateOwnProfile({
      display_name: container.querySelector('#account-display-name').value.trim(),
      job_title: container.querySelector('#account-job-title').value.trim(),
    }), '个人资料已保存');
    runForm(container.querySelector('#credentials-form'), () => {
      const payload = { login_name: container.querySelector('#account-login-name').value.trim() };
      const password = container.querySelector('#account-password').value;
      if (password) payload.password = password;
      return Store.updateOwnCredentials(payload);
    }, '登录设置已保存');
    container.querySelector('#account-logout')?.addEventListener('click', async event => {
      if (event.currentTarget.disabled) return;
      event.currentTarget.disabled = true;
      try { await Store.logout(); options.onLogout?.(); }
      catch (error) { event.currentTarget.disabled = false; UI.toast(error.message || '退出失败', 'error'); }
    });
  }

  return { render };
})();
