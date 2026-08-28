/* ============================================================
   datasource.js — Data Source Management module
   ============================================================ */
window.DatasourceModule = (function () {
  const { escapeHtml, formatTime } = UI;
  let state = { search: '', typeFilter: 'all', statusFilter: 'all', page: 1, pageSize: 8, sortKey: 'createdAt', sortDir: 'desc' };
  let pageRoot = null;
  const ownsPage = root => root?.isConnected && root === pageRoot;

  function renderActions(actionsEl) {
    actionsEl.innerHTML = `
      <button class="btn btn-secondary btn-sm" id="ds-refresh">
        ${Icon.refresh({ size: 14 })}<span>刷新</span>
      </button>
      <button class="btn btn-accent" id="ds-add">
        ${Icon.plus({ size: 16 })}<span>添加数据源</span>
      </button>
    `;
    actionsEl.querySelector('#ds-add').addEventListener('click', () => openForm());
    actionsEl.querySelector('#ds-refresh').addEventListener('click', async (event) => {
      const btn = event.currentTarget, root = pageRoot;
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        await Store.refresh();
        if (!ownsPage(root)) return;
        renderList(); renderStats();
        UI.toast({ type: 'success', title: '已刷新数据源列表' });
      } catch (error) { if (ownsPage(root)) UI.toast({ type: 'error', title: '刷新失败', desc: error.message }); }
      finally { if (btn.isConnected) btn.disabled = false; }
    });
  }

  function render(contentEl, opts) {
    renderActions(opts.actionsEl);
    contentEl.innerHTML = `
      <div class="stat-strip" id="ds-stats"></div>
      <div class="section" id="ds-list-section">
        <div class="toolbar" id="ds-toolbar"></div>
        <div id="ds-table"></div>
      </div>
    `;
    pageRoot = contentEl.querySelector('#ds-stats');
    renderStats();
    renderToolbar();
    renderList();
  }

  function renderStats() {
    const all = Store.getDatasources();
    const online = all.filter(d => d.status === 'online').length;
    const error = all.filter(d => d.status === 'error').length;
    const offline = all.filter(d => d.status === 'offline').length;
    document.getElementById('ds-stats').innerHTML = `
      <div class="stat-card animate-rise" style="animation-delay:60ms;">
        <div class="stat-card-header">
          <span class="stat-card-label">数据源总数</span>
          <div class="stat-card-icon" style="background: var(--color-primary-soft); color: var(--color-primary);">${Icon.database({ size: 16 })}</div>
        </div>
        <div class="stat-card-value">${all.length}</div>
        <div class="stat-card-delta neutral">${Icon.users({ size: 12 })}<span>覆盖 ${new Set(all.map(item => item.type)).size} 种类型</span></div>
      </div>
      <div class="stat-card animate-rise" style="animation-delay:120ms;">
        <div class="stat-card-header">
          <span class="stat-card-label">在线</span>
          <div class="stat-card-icon" style="background: var(--color-success-soft); color: var(--color-success);">${Icon.wifi({ size: 16 })}</div>
        </div>
        <div class="stat-card-value">${online}</div>
        <div class="stat-card-delta up">运行正常</div>
      </div>
      <div class="stat-card animate-rise" style="animation-delay:180ms;">
        <div class="stat-card-header">
          <span class="stat-card-label">异常</span>
          <div class="stat-card-icon" style="background: var(--color-danger-soft); color: var(--color-danger);">${Icon.alert({ size: 16 })}</div>
        </div>
        <div class="stat-card-value">${error}</div>
        <div class="stat-card-delta ${error > 0 ? 'down' : 'neutral'}">${error > 0 ? '需立即处理' : '无异常'}</div>
      </div>
      <div class="stat-card animate-rise" style="animation-delay:240ms;">
        <div class="stat-card-header">
          <span class="stat-card-label">离线</span>
          <div class="stat-card-icon" style="background: var(--color-surface-alt); color: var(--color-ink-muted);">${Icon.cloudOff({ size: 16 })}</div>
        </div>
        <div class="stat-card-value">${offline}</div>
        <div class="stat-card-delta neutral">未启用</div>
      </div>
    `;
  }

  function renderToolbar() {
    document.getElementById('ds-toolbar').innerHTML = `
      <div class="toolbar-search">
        <span class="search-icon">${Icon.search({ size: 16 })}</span>
        <input type="search" placeholder="搜索数据源名称、主机…" aria-label="搜索数据源" id="ds-search" value="${escapeHtml(state.search)}" />
        <button type="button" class="toolbar-search-clear" aria-label="清空搜索" ${state.search ? '' : 'hidden'}>${Icon.x({ size: 14 })}</button>
      </div>
      <select class="filter-select" id="ds-type-filter">
        <option value="all">全部类型</option>
        <option value="mysql" ${state.typeFilter === 'mysql' ? 'selected' : ''}>MySQL</option>
        <option value="starrocks" ${state.typeFilter === 'starrocks' ? 'selected' : ''}>StarRocks</option>
      </select>
      <select class="filter-select" id="ds-status-filter">
        <option value="all">全部状态</option>
        <option value="online" ${state.statusFilter === 'online' ? 'selected' : ''}>在线</option>
        <option value="error" ${state.statusFilter === 'error' ? 'selected' : ''}>异常</option>
        <option value="offline" ${state.statusFilter === 'offline' ? 'selected' : ''}>离线</option>
      </select>
      <div class="toolbar-divider"></div>
      <span class="text-xs text-muted" id="ds-count-text"></span>
    `;
    document.getElementById('ds-search').addEventListener('input', (e) => { state.search = e.target.value; state.page = 1; document.querySelector('#ds-toolbar .toolbar-search-clear').hidden = !state.search; renderList(); });
    document.querySelector('#ds-toolbar .toolbar-search-clear').addEventListener('click', () => {
      const input = document.getElementById('ds-search'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
    });
    document.getElementById('ds-type-filter').addEventListener('change', (e) => { state.typeFilter = e.target.value; state.page = 1; renderList(); });
    document.getElementById('ds-status-filter').addEventListener('change', (e) => { state.statusFilter = e.target.value; state.page = 1; renderList(); });
  }

  function getFiltered() {
    let list = Store.getDatasources();
    if (state.search) {
      const q = state.search.toLowerCase();
      list = list.filter(d => d.name.toLowerCase().includes(q) || d.host.toLowerCase().includes(q) || (d.database || '').toLowerCase().includes(q));
    }
    if (state.typeFilter !== 'all') list = list.filter(d => d.type === state.typeFilter);
    if (state.statusFilter !== 'all') list = list.filter(d => d.status === state.statusFilter);
    list.sort((a, b) => {
      const dir = state.sortDir === 'asc' ? 1 : -1;
      if (state.sortKey === 'name') return a.name.localeCompare(b.name) * dir;
      if (state.sortKey === 'createdAt') return (a.createdAt || '').localeCompare(b.createdAt || '') * dir;
      return 0;
    });
    return list;
  }

  function renderList() {
    const all = getFiltered();
    const total = all.length;
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page > totalPages) state.page = totalPages;
    const pageItems = all.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);

    const countText = document.getElementById('ds-count-text');
    if (countText) countText.textContent = `共 ${total} 个数据源`;

    const tableEl = document.getElementById('ds-table');
    if (total === 0) {
      tableEl.innerHTML = UI.emptyState({
        icon: Icon.database({ size: 24 }),
        iconCls: 'muted',
        title: state.search || state.typeFilter !== 'all' || state.statusFilter !== 'all' ? '没有匹配的数据源' : '还没有数据源',
        desc: state.search ? '尝试调整搜索条件或筛选器' : '添加你的第一个数据源以开始监控',
        action: !state.search && state.typeFilter === 'all' && state.statusFilter === 'all'
          ? `<button class="btn btn-accent" onclick="document.getElementById('ds-add').click()">${Icon.plus({ size: 16 })}添加数据源</button>` : '',
      });
      return;
    }

    const sortIcon = (key) => {
      if (state.sortKey !== key) return Icon.sort({ size: 12 });
      return state.sortDir === 'asc' ? Icon.arrowUp({ size: 12 }) : Icon.arrowDown({ size: 12 });
    };

    tableEl.innerHTML = `
      <div class="table-wrap">
        <table class="data-table" data-table-id="datasource-list">
          <thead>
            <tr>
              <th class="sortable" data-sort="name" data-column-key="name" data-default-width="180"><span class="th-sort">名称 ${sortIcon('name')}</span></th>
              <th data-column-key="type" data-default-width="140">类型</th>
              <th data-column-key="connection" data-default-width="220">连接信息</th>
              <th data-column-key="status" data-default-width="120">状态</th>
              <th class="sortable" data-sort="createdAt" data-column-key="created-at" data-default-width="180"><span class="th-sort">创建时间 ${sortIcon('createdAt')}</span></th>
              <th data-column-key="last-checked" data-default-width="180">最近检测</th>
              <th data-column-key="actions" data-min-width="140" data-default-width="140" style="text-align:right;">操作</th>
            </tr>
          </thead>
          <tbody>
            ${pageItems.map((d, i) => `
              <tr class="animate-fade" style="animation-delay:${i * 30}ms;">
                <td>
                  <div class="cell-strong">${escapeHtml(d.name)}</div>
                  ${d.description ? `<div class="cell-muted">${escapeHtml(d.description)}</div>` : ''}
                </td>
                <td>${UI.dsTypeBadge(d.type)}</td>
                <td>
                  <div class="cell-mono">${escapeHtml(d.host)}:${d.port}</div>
                  <div class="cell-muted">${escapeHtml(d.database)}</div>
                </td>
                <td>${renderStatusCell(d)}</td>
                <td class="cell-muted">${escapeHtml(formatTime(d.createdAt))}</td>
                <td class="cell-muted">${escapeHtml(formatTime(d.lastChecked))}</td>
                <td>
                  <div class="cell-actions">
                    <button class="row-action" data-action="test" data-id="${d.id}" data-tooltip="测试连接" aria-label="测试连接">${Icon.zap({ size: 15 })}</button>
                    <button class="row-action" data-action="edit" data-id="${d.id}" data-tooltip="编辑" aria-label="编辑">${Icon.edit({ size: 15 })}</button>
                    <button class="row-action danger" data-action="delete" data-id="${d.id}" data-tooltip="删除" aria-label="删除">${Icon.trash({ size: 15 })}</button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      ${UI.renderPagination(state.page, totalPages, total, state.pageSize)}
    `;

    // Wire sort
    tableEl.querySelectorAll('th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.sortKey = key; state.sortDir = 'asc'; }
        renderList();
      });
    });

    // Wire actions
    tableEl.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const action = btn.dataset.action;
        if (action === 'test') testConnection(id, btn);
        else if (action === 'edit') openForm(id);
        else if (action === 'delete') confirmDelete(id);
      });
    });

    // Wire pagination
    tableEl.querySelectorAll('.page-btn[data-page]').forEach(btn => {
      btn.addEventListener('click', () => { state.page = parseInt(btn.dataset.page); renderList(); });
    });
  }

  function renderStatusCell(d) {
    const map = {
      online: { cls: 'online', label: '在线' },
      offline: { cls: 'offline', label: '离线' },
      error: { cls: 'error', label: '异常' },
      checking: { cls: 'checking', label: '检测中' },
    };
    const m = map[d.status] || map.offline;
    return `<span class="status-indicator ${m.cls}"><span class="dot"></span>${m.label}</span>`;
  }

  // ---------- Test connection ----------
  async function testConnection(id, btn) {
    if (btn.disabled) return;
    const root = pageRoot;
    const ds = Store.getDatasource(id);
    if (!ds) return;
    const original = btn.innerHTML;
    btn.innerHTML = `<span class="btn-spinner"></span>`;
    btn.disabled = true;
    try {
      const result = await Store.testDatasource(id);
      if (!ownsPage(root)) return;
      renderList();
      renderStats();
      UI.toast({ type: 'success', title: '连接成功', desc: ds.name });
      if (result?.refreshWarning) UI.toast({ type: 'warning', title: '连接成功，列表刷新失败', desc: result.refreshWarning });
    } catch (error) {
      try { await Store.refresh(); } catch (_) { /* Keep the original connection error. */ }
      if (!ownsPage(root)) return;
      renderList(); renderStats();
      UI.toast({ type: 'error', title: '连接失败', desc: error.message });
    } finally {
      if (btn.isConnected) { btn.innerHTML = original; btn.disabled = false; }
    }
  }

  // ---------- Delete ----------
  async function confirmDelete(id) {
    const root = pageRoot;
    const ds = Store.getDatasource(id);
    if (!ds) return;
    const ok = await UI.confirm({
      title: '删除数据源',
      desc: `确定要删除「${ds.name}」吗？关联的数据集与规则可能受到影响。`,
      confirmText: '删除',
      danger: true,
    });
    if (ok) {
      try {
        await Store.deleteDatasource(id);
        if (!ownsPage(root)) return;
        UI.toast({ type: 'success', title: '已删除', desc: ds.name });
        renderList(); renderStats();
      } catch (error) { UI.toast({ type: 'error', title: '删除失败', desc: error.message }); }
    }
  }

  // ---------- Form (add / edit) ----------
  function openForm(id) {
    const root = pageRoot;
    const editing = id ? Store.getDatasource(id) : null;
    const data = editing || { name: '', type: 'mysql', host: '', port: 3306, database: '', username: '', password: '', description: '', ssl: false };

    const m = UI.modal({
      title: editing ? '编辑数据源' : '添加数据源',
      subtitle: editing ? `修改 ${data.name} 的连接配置` : '配置一个新的数据源连接',
      size: 'lg',
      body: `
        <div class="form-section">
          <div class="form-section-title">${Icon.info({ size: 14 })}基本信息</div>
          <div class="form-section-desc">${editing ? '数据源类型创建后不可修改；如需更换类型，请新建数据源。' : '数据源的类型与显示名称'}</div>
          <div class="form-grid">
            ${UI.field('数据源名称', `<input class="input" id="f-name" value="${escapeHtml(data.name)}" placeholder="例如：订单主库 (production)" />`, { required: true })}
            ${UI.field('描述', `<input class="input" id="f-desc" value="${escapeHtml(data.description || '')}" placeholder="可选，便于团队识别用途" />`, { optional: true })}
          </div>
          <div class="field">
            <label class="field-label"><span>数据源类型<span class="field-required">*</span></span></label>
            <div class="radio-cards" style="grid-template-columns: 1fr 1fr;">
              <div class="radio-card ${data.type === 'mysql' ? 'selected' : ''}" data-type="mysql" aria-disabled="${!!editing}" ${editing ? 'style="cursor:not-allowed;opacity:0.7;"' : ''}>
                <div class="radio-card-icon mysql">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M5.76 21.07c-.32.07-.66.13-1.01.16-.36.03-.69.04-1.01.04-.36 0-.71-.02-1.05-.07-.34-.05-.65-.13-.93-.25-.28-.12-.51-.28-.69-.49-.18-.21-.27-.49-.27-.83 0-.4.12-.71.36-.95.24-.24.55-.43.93-.58.38-.15.81-.26 1.29-.34.48-.08.97-.15 1.47-.21.5-.06.99-.13 1.47-.21.48-.08.91-.19 1.29-.34.38-.15.69-.34.93-.58.24-.24.36-.55.36-.95 0-.4-.12-.71-.36-.95-.24-.24-.55-.43-.93-.58-.38-.15-.81-.26-1.29-.34-.48-.08-.97-.15-1.47-.21-.5-.06-.99-.13-1.47-.21-.48-.08-.91-.19-1.29-.34-.38-.15-.69-.34-.93-.58-.24-.24-.36-.55-.36-.95 0-.34.09-.62.27-.83.18-.21.41-.37.69-.49.28-.12.59-.2.93-.25.34-.05.69-.07 1.05-.07.32 0 .65.01 1.01.04.36.03.7.09 1.01.16.32.07.61.18.88.32.27.14.5.34.69.59.19.25.29.57.29.96h-.84c0-.27-.07-.49-.21-.66-.14-.17-.32-.31-.54-.41-.22-.1-.47-.18-.74-.22-.27-.04-.55-.07-.83-.07-.34 0-.66.02-.97.07-.31.05-.58.12-.81.22-.23.1-.42.24-.56.41-.14.17-.21.39-.21.66 0 .27.07.49.21.66.14.17.32.31.56.41.24.1.51.18.81.22.3.04.62.07.97.07h.83v.84h-.83c-.5 0-.97.06-1.42.18-.45.12-.84.29-1.18.51-.34.22-.6.49-.8.81-.2.32-.29.69-.29 1.11 0 .42.09.79.29 1.11.2.32.46.59.8.81.34.22.73.39 1.18.51.45.12.92.18 1.42.18.34 0 .69-.02 1.05-.07.36-.05.7-.13 1.01-.25.32-.12.61-.28.88-.49.27-.21.5-.46.69-.76.19-.3.29-.66.29-1.07h.84c0 .5-.11.93-.32 1.29-.21.36-.49.66-.83.89-.34.23-.74.41-1.18.52-.44.11-.91.17-1.4.17h-.83z"/></svg>
                </div>
                <div class="radio-card-text">
                  <div class="radio-card-title">MySQL</div>
                  <div class="radio-card-desc">关系型数据库 · 默认端口 3306</div>
                </div>
                <div class="radio-card-dot"></div>
              </div>
              <div class="radio-card ${data.type === 'starrocks' ? 'selected' : ''}" data-type="starrocks" aria-disabled="${!!editing}" ${editing ? 'style="cursor:not-allowed;opacity:0.7;"' : ''}>
                <div class="radio-card-icon starrocks">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
                </div>
                <div class="radio-card-text">
                  <div class="radio-card-title">StarRocks</div>
                  <div class="radio-card-desc">MPP 数据仓库 · 默认端口 9030</div>
                </div>
                <div class="radio-card-dot"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="form-section">
          <div class="form-section-title">${Icon.server({ size: 14 })}连接信息</div>
          <div class="form-section-desc">数据库服务地址与认证凭据</div>
          <div class="form-grid">
            ${UI.field('主机地址', `<input class="input mono" id="f-host" value="${escapeHtml(data.host)}" placeholder="10.20.30.11" />`, { required: true })}
            ${UI.field('端口', `<div class="input-group"><input class="input mono" id="f-port" type="number" value="${data.port}" placeholder="3306" style="border:none;box-shadow:none;" /></div>`, { required: true })}
            ${UI.field('数据库名', `<input class="input mono" id="f-database" value="${escapeHtml(data.database)}" placeholder="orders" />`, { required: true })}
            ${UI.field('用户名', `<input class="input mono" id="f-username" value="${escapeHtml(data.username)}" placeholder="analytics_ro" />`, { required: true })}
            ${UI.field('密码', `<div class="input-group"><input class="input mono" id="f-password" type="password" value="" placeholder="${editing ? '留空保留原密码' : '输入密码'}" style="border:none;box-shadow:none;" /><button type="button" class="input-adornment right" id="f-toggle-pw" style="cursor:pointer;color:var(--color-ink-muted);">${Icon.eye({ size: 16 })}</button></div>`, { optional: true, help: editing ? '密码留空则保留原密码，测试连接也使用已保存的凭据。' : '' })}
            ${UI.field('SSL', `<label class="checkbox"><input type="checkbox" id="f-ssl" ${data.ssl ? 'checked' : ''} /><span class="checkbox-box">${Icon.check({ size: 12 })}</span><span>启用 SSL 加密连接</span></label>`, { help: '建议生产环境启用' })}
          </div>
        </div>
      `,
      footer: `
        <button class="btn btn-secondary" id="f-test">${Icon.zap({ size: 16 })}测试连接</button>
        <div style="flex:1;"></div>
        <button class="btn btn-ghost" data-action="cancel">取消</button>
        <button class="btn btn-accent" id="f-save">${Icon.check({ size: 16 })}${editing ? '保存修改' : '创建数据源'}</button>
      `,
    });

    // Type selection
    m.dialog.querySelectorAll('.radio-card').forEach(card => {
      card.addEventListener('click', () => {
        if (editing) return;
        m.dialog.querySelectorAll('.radio-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        const type = card.dataset.type;
        const portInput = m.dialog.querySelector('#f-port');
        if (type === 'mysql' && (portInput.value === '9030' || !portInput.value)) portInput.value = 3306;
        if (type === 'starrocks' && (portInput.value === '3306' || !portInput.value)) portInput.value = 9030;
      });
    });

    // Password toggle
    m.dialog.querySelector('#f-toggle-pw').addEventListener('click', (e) => {
      const inp = m.dialog.querySelector('#f-password');
      const isPw = inp.type === 'password';
      inp.type = isPw ? 'text' : 'password';
      e.currentTarget.innerHTML = isPw ? Icon.eyeOff({ size: 16 }) : Icon.eye({ size: 16 });
    });

    // Cancel
    m.dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => m.close());

    // Test
    m.dialog.querySelector('#f-test').addEventListener('click', async () => {
      const btn = m.dialog.querySelector('#f-test');
      if (btn.disabled || !m.dialog.isConnected) return;
      const original = btn.innerHTML;
      btn.innerHTML = `<span class="btn-spinner"></span>测试中…`;
      btn.disabled = true;
      try {
        const selectedType = m.dialog.querySelector('.radio-card.selected').dataset.type;
        await Store.testDatasourceConfig({
          ...(editing ? { id } : {}),
          name: m.dialog.querySelector('#f-name').value || '临时连接', type: selectedType,
          host: m.dialog.querySelector('#f-host').value, port: Number(m.dialog.querySelector('#f-port').value),
          database: m.dialog.querySelector('#f-database').value, username: m.dialog.querySelector('#f-username').value,
          ...(!editing || m.dialog.querySelector('#f-password').value ? { password: m.dialog.querySelector('#f-password').value } : {}), ssl: m.dialog.querySelector('#f-ssl').checked,
        });
        if (!m.dialog.isConnected) return;
        UI.toast({ type: 'success', title: '连接成功', desc: '真实查询 SELECT 1 已通过' });
      } catch (error) {
        if (m.dialog.isConnected) UI.toast({ type: 'error', title: '连接失败', desc: error.message });
      } finally {
        if (btn.isConnected) { btn.innerHTML = original; btn.disabled = false; }
      }
    });

    // Save
    m.dialog.querySelector('#f-save').addEventListener('click', async () => {
      const btn = m.dialog.querySelector('#f-save');
      if (btn.disabled || !m.dialog.isConnected) return;
      const name = m.dialog.querySelector('#f-name').value.trim();
      const host = m.dialog.querySelector('#f-host').value.trim();
      const database = m.dialog.querySelector('#f-database').value.trim();
      const username = m.dialog.querySelector('#f-username').value.trim();

      // Validation
      if (!name) { UI.toast({ type: 'warning', title: '请填写数据源名称' }); return; }
      if (!host) { UI.toast({ type: 'warning', title: '请填写主机地址' }); return; }
      if (!database) { UI.toast({ type: 'warning', title: '请填写数据库名' }); return; }
      if (!username) { UI.toast({ type: 'warning', title: '请填写用户名' }); return; }

      const selectedType = m.dialog.querySelector('.radio-card.selected').dataset.type;
      const payload = {
        name,
        type: selectedType,
        host,
        port: parseInt(m.dialog.querySelector('#f-port').value) || (selectedType === 'mysql' ? 3306 : 9030),
        database,
        username,
        password: m.dialog.querySelector('#f-password').value,
        description: m.dialog.querySelector('#f-desc').value.trim(),
        ssl: m.dialog.querySelector('#f-ssl').checked,
      };

      const original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="btn-spinner"></span>保存中…';
      try {
        if (editing) await Store.updateDatasource(id, payload); else await Store.addDatasource(payload);
        if (!m.dialog.isConnected) return;
        UI.toast({ type: 'success', title: editing ? '已保存' : '已创建', desc: name });
        m.close(); if (ownsPage(root)) { renderList(); renderStats(); }
      } catch (error) { if (m.dialog.isConnected) UI.toast({ type: 'error', title: '保存失败', desc: error.message }); }
      finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = original; } }
    });
  }

  return { render, openItem: openForm };
})();
