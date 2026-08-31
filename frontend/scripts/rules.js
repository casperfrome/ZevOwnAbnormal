/* ============================================================
   rules.js — Anomaly Rule Configuration module
   Features: CRUD, condition builder, scheduling, Feishu notification
   ============================================================ */
window.RulesModule = (function () {
  const { escapeHtml, formatTime } = UI;
  let state = { search: '', statusFilter: 'all', page: 1, pageSize: 8 };
  let pageRoot = null;
  const ownsPage = root => root?.isConnected && root === pageRoot;
  const runningRules = new Set();
  const pendingToggles = new Map();
  const deletingIds = new Set();

  function syncPendingControls() {
    if (!ownsPage(pageRoot)) return;
    document.querySelectorAll('#r-table [data-action]').forEach(control => {
      const { action, id } = control.dataset;
      if (action === 'run') control.disabled = runningRules.has(id);
      if (action === 'delete') control.disabled = deletingIds.has(id);
      if (action === 'toggle') {
        control.disabled = pendingToggles.has(id);
        control.checked = pendingToggles.has(id) ? pendingToggles.get(id) : !!Store.getRule(id)?.enabled;
      }
    });
  }

  function renderActions(actionsEl) {
    actionsEl.innerHTML = `
      <button class="btn btn-secondary btn-sm" id="r-refresh">${Icon.refresh({ size: 14 })}<span>刷新</span></button>
      <button class="btn btn-accent" id="r-add">${Icon.plus({ size: 16 })}<span>新建规则</span></button>
    `;
    actionsEl.querySelector('#r-add').addEventListener('click', () => openForm());
    actionsEl.querySelector('#r-refresh').addEventListener('click', async event => {
      const btn = event.currentTarget, root = pageRoot;
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        await Store.refresh();
        if (!ownsPage(root)) return;
        renderStats();
        renderList();
        UI.toast({ type: 'info', title: '已刷新' });
      } catch (error) {
        if (ownsPage(root)) UI.toast({ type: 'error', title: '刷新失败', desc: error.message });
      }
      finally { if (btn.isConnected) btn.disabled = false; }
    });
  }

  function render(contentEl, opts) {
    renderActions(opts.actionsEl);
    contentEl.innerHTML = `
      <div class="stat-strip" id="r-stats"></div>
      <div class="section">
        <div class="toolbar" id="r-toolbar"></div>
        <div id="r-table"></div>
      </div>
    `;
    pageRoot = contentEl.querySelector('#r-stats');
    renderStats();
    renderToolbar();
    renderList();
  }

  function renderStats() {
    const all = Store.getRules();
    const active = all.filter(r => r.enabled).length;
    const totalAnomalies = all.reduce((s, r) => s + (r.anomalyCount || 0), 0);
    const recentTriggered = all.filter(r => r.anomalyCount > 0).length;
    const pushInTransit = typeof Store.getStats === 'function'
      ? (Store.getStats().pushInTransitAnomalies ?? 0)
      : 0;
    const statsEl = document.getElementById('r-stats');
    statsEl.classList.add('five-up');
    statsEl.innerHTML = `
      <div class="stat-card animate-rise" style="animation-delay:60ms;">
        <div class="stat-card-header"><span class="stat-card-label">规则总数</span><div class="stat-card-icon" style="background:var(--color-primary-soft);color:var(--color-primary);">${Icon.shield({ size: 16 })}</div></div>
        <div class="stat-card-value">${all.length}</div>
        <div class="stat-card-delta up">${active} 个启用中</div>
      </div>
      <div class="stat-card animate-rise" style="animation-delay:120ms;">
        <div class="stat-card-header"><span class="stat-card-label">累计异常</span><div class="stat-card-icon" style="background:var(--color-accent-soft);color:var(--color-accent);">${Icon.alert({ size: 16 })}</div></div>
        <div class="stat-card-value">${totalAnomalies}</div>
        <div class="stat-card-delta ${totalAnomalies > 0 ? 'down' : 'neutral'}">触发次数</div>
      </div>
      <div class="stat-card animate-rise" style="animation-delay:180ms;">
        <div class="stat-card-header"><span class="stat-card-label">触发规则</span><div class="stat-card-icon" style="background:var(--color-warning-soft);color:var(--color-warning);">${Icon.zap({ size: 16 })}</div></div>
        <div class="stat-card-value">${recentTriggered}</div>
        <div class="stat-card-delta neutral">最近 7 天</div>
      </div>
      <div class="stat-card animate-rise" style="animation-delay:240ms;">
        <div class="stat-card-header"><span class="stat-card-label">已停用</span><div class="stat-card-icon" style="background:var(--color-surface-alt);color:var(--color-ink-muted);">${Icon.pause({ size: 16 })}</div></div>
        <div class="stat-card-value">${all.length - active}</div>
        <div class="stat-card-delta neutral">暂停监控</div>
      </div>
      <div class="stat-card animate-rise" style="animation-delay:300ms;${pushInTransit > 0 ? 'border-left:3px solid var(--color-warning);' : ''}">
        <div class="stat-card-header"><span class="stat-card-label">推送途中</span><div class="stat-card-icon" style="background:var(--color-warning-soft);color:var(--color-warning);">${Icon.send({ size: 16 })}</div></div>
        <div class="stat-card-value">${pushInTransit}</div>
        <div class="stat-card-delta ${pushInTransit > 0 ? 'down' : 'neutral'}">${pushInTransit > 0 ? '等待送达飞书' : '均已送达'}</div>
      </div>
    `;
  }

  function renderToolbar() {
    document.getElementById('r-toolbar').innerHTML = `
      <div class="toolbar-search">
        <span class="search-icon">${Icon.search({ size: 16 })}</span>
        <input type="search" placeholder="搜索规则名称…" aria-label="搜索异常规则" id="r-search" value="${escapeHtml(state.search)}" />
        <button type="button" class="toolbar-search-clear" aria-label="清空搜索" ${state.search ? '' : 'hidden'}>${Icon.x({ size: 14 })}</button>
      </div>
      <select class="filter-select" id="r-status-filter">
        <option value="all">全部状态</option>
        <option value="enabled" ${state.statusFilter === 'enabled' ? 'selected' : ''}>已启用</option>
        <option value="disabled" ${state.statusFilter === 'disabled' ? 'selected' : ''}>已停用</option>
        <option value="triggered" ${state.statusFilter === 'triggered' ? 'selected' : ''}>已触发</option>
      </select>
      <div class="toolbar-divider"></div>
      <span class="text-xs text-muted" id="r-count-text"></span>
    `;
    document.getElementById('r-search').addEventListener('input', (e) => { state.search = e.target.value; state.page = 1; document.querySelector('#r-toolbar .toolbar-search-clear').hidden = !state.search; renderList(); });
    document.querySelector('#r-toolbar .toolbar-search-clear').addEventListener('click', () => {
      const input = document.getElementById('r-search'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
    });
    document.getElementById('r-status-filter').addEventListener('change', (e) => { state.statusFilter = e.target.value; state.page = 1; renderList(); });
  }

  function getFiltered() {
    let list = Store.getRules();
    if (state.search) {
      const q = state.search.toLowerCase();
      list = list.filter(r => r.name.toLowerCase().includes(q) || (r.datasetName || '').toLowerCase().includes(q));
    }
    if (state.statusFilter === 'enabled') list = list.filter(r => r.enabled);
    else if (state.statusFilter === 'disabled') list = list.filter(r => !r.enabled);
    else if (state.statusFilter === 'triggered') list = list.filter(r => r.anomalyCount > 0);
    return list;
  }

  function renderList() {
    const all = getFiltered();
    const total = all.length;
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page > totalPages) state.page = totalPages;
    const pageItems = all.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);

    const countText = document.getElementById('r-count-text');
    if (countText) countText.textContent = `共 ${total} 条规则`;

    const tableEl = document.getElementById('r-table');
    if (total === 0) {
      tableEl.innerHTML = UI.emptyState({
        icon: Icon.shield({ size: 24 }),
        iconCls: 'muted',
        title: state.search || state.statusFilter !== 'all' ? '没有匹配的规则' : '还没有异常规则',
        desc: state.search ? '尝试调整搜索条件' : '创建第一个规则以开始监控数据异常',
        action: !state.search && state.statusFilter === 'all' ? `<button class="btn btn-accent" onclick="document.getElementById('r-add').click()">${Icon.plus({ size: 16 })}新建规则</button>` : '',
      });
      return;
    }

    tableEl.innerHTML = `
      <div class="table-wrap">
        <table class="data-table" data-table-id="rules-list">
          <thead>
            <tr>
              <th data-column-key="enabled" data-min-width="80" data-default-width="80" style="width:80px;"></th>
              <th data-column-key="rule" data-default-width="220">规则</th>
              <th data-column-key="dataset" data-default-width="180">关联数据集</th>
              <th data-column-key="severity" data-default-width="120">严重程度</th>
              <th data-column-key="schedule" data-default-width="180">调度</th>
              <th data-column-key="last-run" data-default-width="180">最近执行</th>
              <th data-column-key="anomaly-count" data-default-width="110">异常次数</th>
              <th data-column-key="actions" data-min-width="140" data-default-width="140" style="text-align:right;">操作</th>
            </tr>
          </thead>
          <tbody>
            ${pageItems.map((r, i) => `
              <tr class="animate-fade" style="animation-delay:${i * 30}ms;${r.anomalyCount > 0 && r.enabled ? 'background: rgba(249, 112, 102, 0.04);' : ''}">
                <td>
                  <label class="switch" style="display:inline-flex;">
                    <input type="checkbox" ${r.enabled ? 'checked' : ''} data-action="toggle" data-id="${r.id}" aria-label="启用/停用" />
                    <span class="switch-slider"></span>
                  </label>
                </td>
                <td>
                  <div class="cell-strong">${escapeHtml(r.name)}</div>
                  ${r.description ? `<div class="cell-muted" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(r.description)}</div>` : ''}
                </td>
                <td>
                  <div class="flex items-center gap-2">
                    ${Icon.table({ size: 14 })}
                    <span class="cell-muted">${escapeHtml(r.datasetName)}</span>
                  </div>
                </td>
                <td>${UI.severityBadge(r.severity)}</td>
                <td>
                  ${renderScheduleCell(r)}
                </td>
                <td class="cell-muted">${escapeHtml(formatTime(r.lastRun))}</td>
                <td>
                  ${r.anomalyCount > 0
                    ? `<span class="badge ${r.anomalyCount > 5 ? 'danger' : 'accent'}">${r.anomalyCount}</span>`
                    : `<span class="cell-muted">0</span>`}
                </td>
                <td>
                  <div class="cell-actions">
                    <button class="row-action" data-action="run" data-id="${r.id}" data-tooltip="立即执行" aria-label="执行">${Icon.play({ size: 15 })}</button>
                    <button class="row-action" data-action="edit" data-id="${r.id}" data-tooltip="编辑" aria-label="编辑">${Icon.edit({ size: 15 })}</button>
                    <button class="row-action danger" data-action="delete" data-id="${r.id}" data-tooltip="删除" aria-label="删除">${Icon.trash({ size: 15 })}</button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      ${UI.renderPagination(state.page, totalPages, total, state.pageSize)}
    `;

    syncPendingControls();
    tableEl.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const action = btn.dataset.action;
        if (action === 'toggle') return; // handled separately
        if (action === 'run') runRule(id);
        else if (action === 'edit') openForm(id);
        else if (action === 'delete') confirmDelete(id);
      });
    });
    tableEl.querySelectorAll('input[data-action="toggle"]').forEach(inp => {
      inp.addEventListener('change', async () => {
        const id = inp.dataset.id;
        if (inp.disabled || pendingToggles.has(id)) return;
        const root = pageRoot;
        const enabled = inp.checked;
        pendingToggles.set(id, enabled);
        inp.disabled = true;
        const r = Store.getRule(id);
        try {
          await Store.enableRule(id, enabled);
          if (!ownsPage(root)) return;
          UI.toast({ type: enabled ? 'success' : 'info', title: enabled ? '已启用' : '已停用', desc: r.name });
          renderList(); renderStats();
        } catch (error) { if (ownsPage(root)) { inp.checked = !inp.checked; UI.toast({ type: 'error', title: '调度同步失败', desc: error.message }); } }
        finally { pendingToggles.delete(id); syncPendingControls(); }
      });
    });
    tableEl.querySelectorAll('.page-btn[data-page]').forEach(btn => {
      btn.addEventListener('click', () => { state.page = parseInt(btn.dataset.page); renderList(); });
    });
  }

  function renderScheduleCell(r) {
    if (!r.enabled) return '<span class="cell-muted">已停用</span>';
    const map = { day: '每日', hour: '每小时', min: '每分钟' };
    const s = r.schedule;
    let label;
    if (s.frequency === 'min') label = `每 ${s.interval} 分钟`;
    else if (s.frequency === 'hour') label = `每 ${s.interval} 小时`;
    else label = `每日 ${s.time || '00:00'}`;
    return `<div class="flex items-center gap-2"><span class="cell-muted">${Icon.clock({ size: 14 })}</span><span class="text-xs">${label}</span></div>`;
  }

  async function runRule(id) {
    if (runningRules.has(id)) return;
    const root = pageRoot;
    const r = Store.getRule(id);
    if (!r) return;
    runningRules.add(id);
    const buttons = [...document.querySelectorAll(`[data-action="run"][data-id="${id}"]`)];
    buttons.forEach(button => { button.disabled = true; });
    UI.toast({ type: 'info', title: '开始执行', desc: r.name });
    try {
      const run = await Store.executeRule(id);
      if (!ownsPage(root)) return;
      const type = run.new_anomalies > 0 ? 'warning' : 'success';
      UI.toast({ type, title: run.new_anomalies > 0 ? '检测到异常' : '执行完成', desc: `扫描 ${run.scanned_rows} 行 · 新增 ${run.new_anomalies} 条` });
      if (run.refreshWarning) UI.toast({ type: 'warning', title: '执行完成，页面刷新失败', desc: run.refreshWarning });
      renderList(); renderStats();
    } catch (error) { if (ownsPage(root)) UI.toast({ type: 'error', title: '执行失败', desc: error.message }); }
    finally { runningRules.delete(id); syncPendingControls(); }
  }

  async function confirmDelete(id) {
    const root = pageRoot;
    const r = Store.getRule(id);
    if (!r || deletingIds.has(id)) return;
    deletingIds.add(id);
    syncPendingControls();
    try {
      const ok = await UI.confirm({ title: '删除规则', desc: `确定要删除「${r.name}」吗？历史异常记录将保留。`, confirmText: '删除', danger: true });
      if (!ok || !ownsPage(root)) return;
      await Store.deleteRule(id);
      if (!ownsPage(root)) return;
      UI.toast({ type: 'success', title: '已删除', desc: r.name }); renderList(); renderStats();
    } catch (error) { if (ownsPage(root)) UI.toast({ type: 'error', title: '删除失败', desc: error.message }); }
    finally { deletingIds.delete(id); syncPendingControls(); }
  }

  // ---------- Form (add/edit) ----------
  function openForm(id) {
    const root = pageRoot;
    const editing = id ? Store.getRule(id) : null;
    const data = editing || {
      name: '', description: '', datasetId: '', severity: 'medium',
      conditions: [{ field: '', op: 'gt', value: '', baseline: null }],
      logic: 'AND',
      schedule: { frequency: 'day', interval: 1, time: '09:00', start: '2026-08-09', end: '' },
      enabled: true,
      notify: { type: 'feishu', openIds: [], userIds: [], fieldSource: null, mode: 'manual' },
      privateMessageTemplate: '',
      validationEnabled: false,
      validationTargets: [],
      deadlineSeconds: 86400,
      validationMethod: 'pseudo',
      sqlValidationConfig: null,
      groupBroadcast: { enabled: false, webhookUrl: '', mentionTargets: [], messageTemplate: '' },
    };
    const duration = data.deadlineSeconds ?? (data.validationTimeoutMinutes ?? 1440) * 60;
    const deadlineParts = [Math.floor(duration / 86400), Math.floor(duration % 86400 / 3600), Math.floor(duration % 3600 / 60), duration % 60];
    const groupBroadcast = data.groupBroadcast || { enabled: false, webhookUrl: '', mentionTargets: [], messageTemplate: '' };
    const situationBroadcast = groupBroadcast.situation || groupBroadcast;
    const timeoutBroadcast = groupBroadcast.timeout || {};
    const sqlCondition = data.sqlValidationConfig?.trueCondition || {};
    const datasources = Store.getDatasources();
    // Resolve legacy configuration only when opening an existing SQL rule.
    // Dataset changes below must never replace the validation datasource draft.
    const sqlDatasourceId = data.sqlValidationConfig?.datasourceId === undefined && editing?.validationMethod === 'sql'
      ? (Store.getDataset(data.datasetId)?.datasourceId || '')
      : (data.sqlValidationConfig?.datasourceId || '');
    const missingSqlDatasource = sqlDatasourceId && !datasources.some(source => source.id === sqlDatasourceId);

    function operandSwitch(source) {
      return `<div class="segmented operand-source" role="group" aria-label="比较值来源">
        ${[['literal', '具体值'], ['field', '字段值']].map(([value, label]) => `<button type="button" data-source="${value}" class="${source === value ? 'active' : ''}" aria-pressed="${source === value}">${label}</button>`).join('')}
      </div>`;
    }

    function sqlOperand(upper = false) {
      const prefix = upper ? 'upper-value' : 'value';
      const source = sqlCondition[upper ? 'upperValueSource' : 'valueSource'] || 'literal';
      return `<div class="condition-operand" id="f-sql-${prefix}-operand" data-operand="${prefix}">
        <input class="input mono" id="f-sql-${prefix}" placeholder="${upper ? '范围上界' : '期望值'}" value="${escapeHtml(sqlCondition[upper ? 'upperValue' : 'value'] ?? '')}" aria-label="SQL True 条件${upper ? '范围上界' : '期望值'}" ${source === 'field' ? 'hidden' : ''} />
        <input class="input mono" id="f-sql-${prefix}-field" placeholder="结果字段名" value="${escapeHtml(sqlCondition[upper ? 'upperValueField' : 'valueField'] || '')}" aria-label="SQL True 条件${upper ? '上界' : '比较'}字段" ${source === 'field' ? '' : 'hidden'} />
        ${operandSwitch(source)}
      </div>`;
    }

    const datasets = Store.getDatasets();

    let cleanupKeyFieldPicker = () => {};
    const m = UI.modal({
      title: editing ? '编辑异常规则' : '新建异常规则',
      subtitle: editing ? `修改 ${data.name}` : '配置检测条件、调度策略与通知方式',
      size: 'xl',
      onClose: () => cleanupKeyFieldPicker(),
      body: `
        <div class="form-section rule-form-panel" id="rule-panel-basic" data-rule-panel="basic" role="tabpanel" aria-labelledby="rule-tab-basic">
          <div class="form-grid">
            ${UI.field('规则名称', `<input class="input" id="f-name" value="${escapeHtml(data.name)}" placeholder="例如：订单金额突增检测" />`, { required: true })}
            ${UI.field('严重程度', `
              <select class="select" id="f-severity">
                <option value="low" ${data.severity === 'low' ? 'selected' : ''}>低</option>
                <option value="medium" ${data.severity === 'medium' ? 'selected' : ''}>中</option>
                <option value="high" ${['high', 'critical'].includes(data.severity) ? 'selected' : ''}>高</option>
              </select>
            `, { required: true })}
            ${UI.field('截止时间', `<div class="deadline-inputs"><span>收到异常推送后</span>${[
              ['days', '天', 30], ['hours', '小时', 23], ['minutes', '分钟', 59], ['seconds', '秒', 59],
            ].map(([unit, label, max], index) => `<label class="deadline-unit"><input class="input mono" id="f-deadline-${unit}" aria-label="截止时间${label}" type="number" min="0" max="${max}" step="1" required value="${deadlineParts[index]}" /><span>${label}</span></label>`).join('')}</div>`, { required: true, span2: true, help: '首次推送成功后开始计时；总时长 1 秒至 30 天，与严重程度、实时校验开关无关' })}
            ${UI.field('异常描述', `<input class="input" id="f-desc" value="${escapeHtml(data.description || '')}" placeholder="说明异常现象与验证人需要确认的内容" />`, { optional: true, span2: true })}
          </div>
        </div>

        <div class="form-section rule-form-panel" id="rule-panel-dataset" data-rule-panel="dataset" role="tabpanel" aria-labelledby="rule-tab-dataset" hidden>
          <div class="form-section-desc">规则将基于此数据集的查询结果进行检测</div>
          <div class="form-grid">
            ${UI.field('数据集', `
              <select class="select" id="f-dataset">
                <option value="">请选择数据集…</option>
                ${datasets.map(d => `<option value="${d.id}" ${data.datasetId === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
              </select>
            `, { required: true })}
            ${UI.field('异常主键字段', `
              <div class="key-field-picker">
                <button type="button" class="key-field-picker-trigger" id="f-key-fields" role="combobox"
                  aria-label="异常主键字段" aria-required="true" aria-haspopup="listbox"
                  aria-expanded="false" aria-controls="f-key-fields-listbox" disabled>
                  <span class="key-field-picker-summary"><span class="key-field-picker-placeholder">请先选择数据集…</span></span>
                  <span class="key-field-picker-chevron" aria-hidden="true">${Icon.chevronDown({ size: 14 })}</span>
                </button>
                <div class="key-field-picker-listbox" id="f-key-fields-listbox" role="listbox"
                  aria-label="异常主键字段" aria-multiselectable="true" hidden></div>
              </div>
            `, { required: true, help: '可选择多个字段；建议包含门店 ID 与日期字段' })}
          </div>
          <div id="dataset-fields-preview"></div>
          <div class="validation-toggle-row">
            <div><div class="cell-strong">允许重复推送</div><div class="cell-muted">默认关闭；开启后，同一异常主键再次命中也会推送通知</div></div>
            <label class="switch"><input type="checkbox" id="f-repeat-push-enabled" ${data.repeatPushEnabled ? 'checked' : ''} aria-label="允许重复推送" /><span class="switch-slider"></span></label>
          </div>
        </div>

        <div class="form-section rule-form-panel" id="rule-panel-conditions" data-rule-panel="conditions" role="tabpanel" aria-labelledby="rule-tab-conditions" hidden>
          <div class="form-section-desc">支持多条件组合，可使用 AND / OR 逻辑连接</div>
          <div class="field">
            <label class="field-label"><span>逻辑关系</span></label>
            <div class="segmented" id="f-logic">
              <button type="button" data-logic="AND" class="${data.logic === 'AND' ? 'active' : ''}">满足全部 (AND)</button>
              <button type="button" data-logic="OR" class="${data.logic === 'OR' ? 'active' : ''}">满足任一 (OR)</button>
            </div>
          </div>
          <div id="conditions-container"></div>
          <button type="button" class="condition-add" id="add-condition">${Icon.plus({ size: 14 })}添加条件</button>
        </div>

        <div class="form-section rule-form-panel" id="rule-panel-schedule" data-rule-panel="schedule" role="tabpanel" aria-labelledby="rule-tab-schedule" hidden>
          <div class="form-section-desc">设置规则的执行频率与有效时间窗口</div>
          <div class="form-grid">
            ${UI.field('调度频率', `
              <select class="select" id="f-freq">
                <option value="min" ${data.schedule.frequency === 'min' ? 'selected' : ''}>按分钟</option>
                <option value="hour" ${data.schedule.frequency === 'hour' ? 'selected' : ''}>按小时</option>
                <option value="day" ${data.schedule.frequency === 'day' ? 'selected' : ''}>按天</option>
              </select>
            `, { required: true })}
            ${UI.field('间隔', `<input class="input mono" id="f-interval" type="number" min="1" value="${data.schedule.interval}" />`, { required: true, help: '执行频率的间隔数' })}
            ${UI.field('执行时间', `<input class="input mono" id="f-time" type="time" value="${data.schedule.time || '09:00'}" ${data.schedule.frequency !== 'day' ? 'disabled' : ''} />`, { optional: true, help: '仅按天调度时有效' })}
            ${UI.field('开始日期', `<input class="input mono" id="f-start" type="date" value="${data.schedule.start || ''}" />`, { required: true })}
            ${UI.field('结束日期', `<input class="input mono" id="f-end" type="date" value="${data.schedule.end || ''}" />`, { optional: true, help: '留空表示长期有效' })}
          </div>
          <div id="schedule-preview"></div>
        </div>

        <div class="form-section rule-form-panel validation-config" id="rule-panel-validation" data-rule-panel="validation" role="tabpanel" aria-labelledby="rule-tab-validation" hidden>
          <div class="form-section-desc">异常触发后，将校验卡片发送给指定 user_id，首位有效提交人完成闭环</div>
          <div class="validation-toggle-row">
            <div>
              <div class="cell-strong">启用实时校验</div>
              <div class="cell-muted">关闭时保留目标配置，但不会发起校验请求</div>
            </div>
            <label class="switch">
              <input type="checkbox" id="f-validation-enabled" ${data.validationEnabled ? 'checked' : ''} aria-label="启用实时校验" />
              <span class="switch-slider"></span>
            </label>
          </div>
          <div class="field validation-method-field">
            <label class="field-label"><span>校验方式<span class="field-required">*</span></span></label>
            <div class="segmented validation-method-segmented" id="f-validation-method" role="group" aria-label="校验方式">
              <button type="button" data-validation-method="pseudo" class="${(data.validationMethod || 'pseudo') === 'pseudo' ? 'active' : ''}">伪校验</button>
              <button type="button" data-validation-method="sql" class="${data.validationMethod === 'sql' ? 'active' : ''}">SQL 校验</button>
            </div>
          </div>
          <div class="form-grid validation-fields-grid">
            ${UI.field('固定处理人 user_id', `<div class="tag-input" id="f-validation-userids"><input type="text" placeholder="输入 user_id 后回车" id="f-validation-userids-input" /></div>`, { optional: true, help: '可配置多个；保存时会自动收录尚未回车的内容' })}
            ${UI.field('数据集字段处理人', `<select class="select" id="f-validation-fields" multiple size="4"><option value="">请先选择数据集…</option></select>`, { optional: true, span2: true, help: '可多选；每行从所选字段读取 user_id' })}
          </div>
          <div id="f-pseudo-validation-panel" class="validation-method-panel validation-pseudo-note" ${data.validationMethod === 'sql' ? 'hidden' : ''}>
            ${Icon.info({ size: 14 })}<span>处理人在飞书卡片填写说明并提交后，异常即视为校验通过。</span>
          </div>
          <div id="f-sql-validation-panel" class="validation-method-panel sql-validation-panel" ${data.validationMethod === 'sql' ? '' : 'hidden'}>
            <div class="field">
              <label class="field-label" for="f-sql-datasource"><span>校验数据源<span class="field-required">*</span></span></label>
              <select class="select" id="f-sql-datasource" aria-required="true" aria-describedby="f-sql-datasource-help">
                <option value="">请选择校验数据源…</option>
                ${missingSqlDatasource ? `<option value="${escapeHtml(sqlDatasourceId)}" selected disabled>数据源不可用（${escapeHtml(sqlDatasourceId)}），请重新选择</option>` : ''}
                ${datasources.map(source => `<option value="${escapeHtml(source.id)}" ${source.id === sqlDatasourceId ? 'selected' : ''}>${escapeHtml(source.name)} · ${escapeHtml({ mysql: 'MySQL', starrocks: 'StarRocks' }[source.type] || source.type)}${source.status === 'offline' ? ' · 离线' : ''}</option>`).join('')}
              </select>
              <div class="field-help" id="f-sql-datasource-help">${datasources.length ? '独立于异常数据集；离线数据源仍可选择，SQL 参数取自异常数据集字段。' : '暂无已有数据源，请先创建数据源后再配置 SQL 校验。'}</div>
            </div>
            <div class="field">
              <label class="field-label" for="f-validation-sql"><span>查询 SQL<span class="field-required">*</span></span></label>
              <textarea class="input mono sql-validation-editor" id="f-validation-sql" rows="6" placeholder="SELECT status FROM test_table WHERE id='{目标ID}'">${escapeHtml(data.sqlValidationConfig?.queryTemplate || '')}</textarea>
              <div class="field-help">仅允许一条只读 SELECT / WITH；支持完整的 <code>{参数名}</code> 或 <code>'{参数名}'</code>。</div>
            </div>
            <div class="sql-parameter-header">
              <div><div class="cell-strong">SQL 参数映射</div><div class="cell-muted">把每个占位符映射到异常数据集字段</div></div>
              <button type="button" class="btn btn-secondary btn-sm" id="f-add-sql-parameter">${Icon.plus({ size: 14 })}添加参数</button>
            </div>
            <div id="f-sql-parameters" class="sql-parameter-list"></div>
            <div class="field-label sql-condition-label"><span>True 条件<span class="field-required">*</span></span></div>
            <div class="sql-true-condition">
              <input class="input mono" id="f-sql-result-field" placeholder="结果字段，如 status" value="${escapeHtml(data.sqlValidationConfig?.trueCondition?.field || '')}" aria-label="SQL 结果字段" />
              <select class="select" id="f-sql-operator" aria-label="SQL True 条件运算符">
                ${[
                  ['eq', '等于 ='], ['neq', '不等于 ≠'], ['gt', '大于 >'], ['gte', '大于等于 ≥'],
                  ['lt', '小于 <'], ['lte', '小于等于 ≤'], ['between', '介于'],
                  ['is_null', '为空'], ['is_not_null', '不为空'],
                ].map(([value, label]) => `<option value="${value}" ${data.sqlValidationConfig?.trueCondition?.operator === value ? 'selected' : ''}>${label}</option>`).join('')}
              </select>
              ${sqlOperand()}
              ${sqlOperand(true)}
            </div>
          </div>
          <div class="field-error" id="f-validation-target-error" style="display:none;">${Icon.alert({ size: 12 })}<span></span></div>
        </div>

        <div class="form-section rule-form-panel" id="rule-panel-private" data-rule-panel="private" role="tabpanel" aria-labelledby="rule-tab-private" hidden>
          <div class="form-section-desc">异常触发时通过飞书推送告警</div>
          <div class="field">
            <label class="field-label"><span>通知方式</span></label>
            <div class="segmented" id="f-notify-mode">
              <button type="button" data-mode="manual" class="${data.notify.mode !== 'field' ? 'active' : ''}">手动输入 ID</button>
              <button type="button" data-mode="field" class="${data.notify.mode === 'field' ? 'active' : ''}">从数据集字段选择</button>
            </div>
          </div>
          <div id="notify-manual" style="display:${data.notify.mode !== 'field' ? 'block' : 'none'};">
            <div class="form-grid">
              ${UI.field('Open ID', `<div class="tag-input" id="f-openids"><input type="text" placeholder="输入 open_id 后回车，例如 ou_abc123def456" id="f-openids-input" /></div>`, { optional: true, help: '多个 ID 用回车分隔' })}
              ${UI.field('User ID', `<div class="tag-input" id="f-userids"><input type="text" placeholder="输入 user_id 后回车" id="f-userids-input" /></div>`, { optional: true })}
              ${UI.field('Union ID', `<div class="tag-input" id="f-unionids"><input type="text" placeholder="输入 union_id 后回车" id="f-unionids-input" /></div>`, { optional: true })}
              ${UI.field('Email', `<div class="tag-input" id="f-emails"><input type="text" placeholder="输入飞书邮箱后回车" id="f-emails-input" /></div>`, { optional: true })}
              ${UI.field('Chat ID', `<div class="tag-input" id="f-chatids"><input type="text" placeholder="输入 chat_id 后回车" id="f-chatids-input" /></div>`, { optional: true })}
            </div>
          </div>
          <div id="notify-field" style="display:${data.notify.mode === 'field' ? 'block' : 'none'};">
            ${UI.field('ID 类型', `<select class="select" id="f-field-id-type">
              ${['open_id','union_id','user_id','email','chat_id'].map(t => `<option value="${t}" ${data.notify.fieldIdType === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>`, { required: true })}
            ${UI.field('ID 字段', `
              <select class="select" id="f-field-source">
                <option value="">请选择字段…</option>
              </select>
            `, { help: '使用数据集结果中的字段值作为通知对象 ID' })}
          </div>
          <div class="message-template-editor" data-template-context="private">
            <div class="message-template-heading">
              <div>
                <div class="cell-strong">私聊推送内容</div>
                <div class="cell-muted">普通告警与实时验证卡片共用；留空时保持系统默认内容</div>
              </div>
              <div class="message-template-actions">
                <button type="button" class="btn btn-secondary btn-sm" data-template-picker="parameter" data-template-context="private">插入参数</button>
                <button type="button" class="btn btn-secondary btn-sm" data-template-picker="link" data-template-context="private">插入超链接</button>
              </div>
            </div>
            <textarea class="textarea mono message-template-input" id="f-private-message-template" rows="5" placeholder="例如：异常记录：{车牌号}">${escapeHtml(data.privateMessageTemplate || '')}</textarea>
            <div class="message-template-hint">字段参数按单条异常记录渲染；支持直接输入合法模板。</div>
            <div class="field-error" id="f-private-template-error" style="display:none;">${Icon.alert({ size: 12 })}<span></span></div>
          </div>
        </div>

        <div class="form-section rule-form-panel group-broadcast-config" id="rule-panel-group" data-rule-panel="group" role="tabpanel" aria-labelledby="rule-tab-group" hidden>
          <div class="form-section-desc">异常情况与异常超时分别配置，共用同一个飞书群机器人</div>
          ${UI.field('话题群机器人 webhook', `<input class="input mono" id="f-group-webhook" type="text" value="${escapeHtml(groupBroadcast.webhookUrl || '')}" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." />`, { optional: true, help: '两种播报共用；仅支持飞书机器人 HTTPS webhook' })}
          ${[['group', situationBroadcast, '异常情况播报'], ['timeout', timeoutBroadcast, '异常超时播报']].map(([context, config, title]) => `
            <section class="broadcast-kind-section" aria-label="${title}">
              <div class="validation-toggle-row">
                <div><div class="cell-strong">${title}</div><div class="cell-muted">${context === 'group' ? '规则检测完成后播报异常情况；艾特目标可留空' : '异常超时后分次汇总播报，自动艾特相关验证处理人及额外配置目标'}</div></div>
                <label class="switch"><input type="checkbox" id="f-${context}-broadcast-enabled" ${config.enabled ? 'checked' : ''} aria-label="启用${title}" /><span class="switch-slider"></span></label>
              </div>
              ${context === 'timeout' ? '<label class="timeout-validator-note"><input id="f-timeout-all-validators" type="checkbox" checked disabled />自动艾特全部验证处理人（不可关闭）</label>' : ''}
              <div class="form-grid">
                ${UI.field('额外固定艾特 user_id', `<div class="tag-input" id="f-${context}-userids"><input type="text" placeholder="输入 user_id 后回车" id="f-${context}-userids-input" /></div>`, { optional: true, help: '保存时会自动收录尚未回车的内容' })}
                ${UI.field('额外数据集字段 user_id', `
                  <div class="key-field-picker">
                    <button type="button" class="key-field-picker-trigger" id="f-${context}-fields" role="combobox" aria-label="${title}数据集字段 user_id" aria-haspopup="listbox" aria-expanded="false" aria-controls="f-${context}-fields-listbox" disabled>
                      <span class="key-field-picker-summary"><span class="key-field-picker-placeholder">请先选择数据集…</span></span>
                      <span class="key-field-picker-chevron" aria-hidden="true">${Icon.chevronDown({ size: 14 })}</span>
                    </button>
                    <div class="key-field-picker-listbox" id="f-${context}-fields-listbox" role="listbox" aria-label="${title}数据集字段 user_id" aria-multiselectable="true" hidden></div>
                  </div>
                `, { optional: true, help: '可多选；从对应异常记录读取 user_id' })}
              </div>
              <div class="message-template-editor" data-template-context="${context}">
                <div class="message-template-heading">
                  <div><div class="cell-strong">${title}内容</div><div class="cell-muted">字段按当前消息分段聚合、去重，并以“、”连接</div></div>
                  <div class="message-template-actions">
                    <button type="button" class="btn btn-secondary btn-sm" data-template-picker="parameter" data-template-context="${context}">插入参数</button>
                    <button type="button" class="btn btn-secondary btn-sm" data-template-picker="link" data-template-context="${context}">插入超链接</button>
                  </div>
                </div>
                <textarea class="textarea mono message-template-input" id="f-${context}-message-template" rows="5" placeholder="例如：异常记录组：{车牌号列表}">${escapeHtml(config.messageTemplate || '')}</textarea>
                <div class="message-template-hint">仅支持“字段列表”参数和异常记录组链接；留空使用系统默认播报。</div>
                <div class="field-error" id="f-${context}-template-error" style="display:none;">${Icon.alert({ size: 12 })}<span></span></div>
              </div>
            </section>
          `).join('')}
          <div class="field-error" id="f-group-broadcast-error" style="display:none;">${Icon.alert({ size: 12 })}<span></span></div>
        </div>
      `,
      footer: `
        <button type="button" class="btn btn-ghost" data-action="cancel">取消</button>
        <button type="button" class="btn btn-secondary" id="f-test">${Icon.zap({ size: 16 })}模拟执行</button>
        <button type="button" class="btn btn-accent" id="f-save">${Icon.check({ size: 16 })}${editing ? '保存规则' : '创建规则'}</button>
      `,
    });

    // Keep all controls mounted: switching sections must not reset pending input.
    m.dialog.classList.add('rule-form');
    const tabs = [
      ['basic', '基本信息'], ['dataset', '关联数据集'], ['conditions', '异常条件'],
      ['schedule', '调度规则'], ['validation', '实时校验'], ['private', '私聊通知'], ['group', '群聊播报'],
    ];
    const tabList = document.createElement('div');
    tabList.className = 'tabs rule-form-tabs';
    tabList.setAttribute('role', 'tablist');
    tabList.setAttribute('aria-label', '异常规则配置');
    tabList.innerHTML = tabs.map(([key, label], index) => `
      <button type="button" class="tab${index === 0 ? ' active' : ''}" id="rule-tab-${key}"
        data-rule-tab="${key}" role="tab" aria-controls="rule-panel-${key}"
        aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${label}</button>
    `).join('');
    m.body.before(tabList);
    const tabButtons = [...tabList.querySelectorAll('[role="tab"]')];
    const tabPanels = [...m.body.querySelectorAll('[data-rule-panel]')];

    function selectTab(key, focus = false) {
      cleanupKeyFieldPicker();
      tabPanels.forEach(panel => { panel.hidden = panel.dataset.rulePanel !== key; });
      tabButtons.forEach(button => {
        const selected = button.dataset.ruleTab === key;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
        if (selected) {
          if (focus) button.focus({ preventScroll: true });
          button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      });
      m.body.scrollTop = 0;
    }

    tabButtons.forEach((button, index) => {
      button.addEventListener('click', () => selectTab(button.dataset.ruleTab));
      button.addEventListener('keydown', event => {
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else return;
        event.preventDefault();
        selectTab(tabs[next][0], true);
      });
    });

    function revealField(selector) {
      const control = m.dialog.querySelector(selector);
      selectTab(control.closest('[data-rule-panel]').dataset.rulePanel);
      control.focus({ preventScroll: true });
      control.scrollIntoView({ block: 'nearest' });
    }

    // ---------- State within form ----------
    let conditions = data.conditions.map(({ operator, op, ...condition }) => ({
      ...condition,
      op: op || operator,
      value_source: condition.value_source || 'literal',
      upper_value_source: condition.upper_value_source || 'literal',
    }));
    let logic = data.logic;
    let notifyMode = data.notify.mode || 'manual';
    let openIds = [...(data.notify.openIds || [])];
    let userIds = [...(data.notify.userIds || [])];
    let unionIds = (data.notificationTargets || []).filter(t => t.source === 'literal' && t.receive_id_type === 'union_id').map(t => t.value);
    let emails = (data.notificationTargets || []).filter(t => t.source === 'literal' && t.receive_id_type === 'email').map(t => t.value);
    let chatIds = (data.notificationTargets || []).filter(t => t.source === 'literal' && t.receive_id_type === 'chat_id').map(t => t.value);
    let validationUserIds = (data.validationTargets || []).filter(t => t.source === 'literal').map(t => t.value);
    let validationFields = (data.validationTargets || []).filter(t => t.source === 'field').map(t => t.field);
    let groupUserIds = (situationBroadcast.mentionTargets || []).filter(t => t.source === 'literal').map(t => t.value);
    let groupFields = (situationBroadcast.mentionTargets || []).filter(t => t.source === 'field').map(t => t.field);
    let timeoutUserIds = (timeoutBroadcast.mentionTargets || []).filter(t => t.source === 'literal').map(t => t.value);
    let timeoutFields = (timeoutBroadcast.mentionTargets || []).filter(t => t.source === 'field').map(t => t.field);
    let validationMethod = data.validationMethod || 'pseudo';
    let sqlParameters = (data.sqlValidationConfig?.parameters || []).map(item => ({ ...item }));

    const templateEditor = context => m.dialog.querySelector(
      `#f-${context}-message-template`,
    );

    function insertTemplateValue(editor, value, selection) {
      const start = selection?.start ?? editor.selectionStart ?? editor.value.length;
      const end = selection?.end ?? editor.selectionEnd ?? start;
      editor.setRangeText(value, start, end, 'end');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.focus();
    }

    function openTemplatePicker(context, kind) {
      const editor = templateEditor(context);
      const selection = { start: editor.selectionStart, end: editor.selectionEnd };
      const ds = Store.getDataset(m.dialog.querySelector('#f-dataset').value);
      const fields = ds?.fields || [];
      const values = kind === 'parameter'
        ? fields.map(field => ({
            value: `{${field.name}${context !== 'private' ? '列表' : ''}}`,
            title: context !== 'private' ? `${field.name}列表` : field.name,
            meta: field.type || '字段',
          }))
        : [{
            value: context !== 'private'
              ? '[查看异常记录组明细]({异常记录组链接})'
              : '[查看异常记录明细]({异常记录链接})',
            title: context !== 'private' ? '异常记录组链接' : '异常记录链接',
            meta: '系统深链',
          }];
      const picker = UI.drawer({
        title: kind === 'parameter' ? '插入数据集参数' : '插入超链接',
        subtitle: context !== 'private' ? '用于群聊播报内容' : '用于私聊推送内容',
        body: `
          <div class="template-picker-list">
            ${values.length ? values.map(item => `
              <button type="button" class="template-picker-option" data-template-value="${escapeHtml(item.value)}">
                <span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.meta)}</small></span>
                <code>${escapeHtml(item.value)}</code>
              </button>
            `).join('') : '<div class="template-picker-empty">请先选择包含字段的数据集</div>'}
          </div>
          ${kind === 'link' ? `
            <div class="template-custom-link">
              <div class="form-section-title">自定义 HTTPS 链接</div>
              <label class="field-label" for="template-link-label">显示文字</label>
              <input class="input" id="template-link-label" value="查看相关说明" />
              <label class="field-label" for="template-link-url">链接地址</label>
              <input class="input mono" id="template-link-url" placeholder="https://example.com/path" />
              <div class="field-error" id="template-link-error" style="display:none;">${Icon.alert({ size: 12 })}<span></span></div>
              <button type="button" class="btn btn-accent" id="template-link-insert">插入自定义链接</button>
            </div>
          ` : ''}
        `,
      });
      picker.body.querySelectorAll('.template-picker-option').forEach(option => {
        option.addEventListener('click', () => {
          insertTemplateValue(editor, option.dataset.templateValue, selection);
          picker.close();
        });
      });
      picker.body.querySelector('#template-link-insert')?.addEventListener('click', () => {
        const label = picker.body.querySelector('#template-link-label').value.trim();
        const url = picker.body.querySelector('#template-link-url').value.trim();
        const error = picker.body.querySelector('#template-link-error');
        let message = '';
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== 'https:' || parsed.username || parsed.password) message = '自定义链接必须使用绝对 HTTPS 地址';
        } catch (_) { message = '请输入有效的 HTTPS 地址'; }
        if (!label) message = '请填写链接显示文字';
        error.querySelector('span').textContent = message;
        error.style.display = message ? 'flex' : 'none';
        if (message) return;
        insertTemplateValue(editor, `[${label}](${url})`, selection);
        picker.close();
      });
    }

    m.dialog.querySelectorAll('[data-template-picker]').forEach(button => {
      button.addEventListener('click', () => {
        openTemplatePicker(button.dataset.templateContext, button.dataset.templatePicker);
      });
    });

    function validateTemplateInput(template, fields, context) {
      if (!template.trim()) return '';
      const masked = template.replaceAll('{{', '').replaceAll('}}', '');
      const fieldNames = new Set(fields.map(field => field.name));
      const placeholders = [...masked.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]);
      for (const name of placeholders) {
        if (name === '异常记录链接') {
          if (context !== 'private') return '群聊模板不支持异常记录链接';
          continue;
        }
        if (name === '异常记录组链接') {
          if (context === 'private') return '私聊模板不支持异常记录组链接';
          continue;
        }
        if (name.endsWith('列表')) {
          if (context === 'private') return '私聊模板不支持字段列表参数';
          if (!fieldNames.has(name.slice(0, -2))) return `模板参数不存在：${name}`;
          continue;
        }
        if (context !== 'private' && fieldNames.has(name)) return '群聊模板仅支持字段列表参数';
        if (!fieldNames.has(name)) return `模板参数不存在：${name}`;
      }
      if (/\[[^\]\r\n]+\]\(http:\/\//i.test(template)) return '自定义链接必须使用 HTTPS';
      const placeholderLinks = [...template.matchAll(/\[[^\]\r\n]+\]\(\{([^{}]+)\}\)/g)];
      const expectedLink = context === 'private' ? '异常记录链接' : '异常记录组链接';
      if (placeholderLinks.some(match => match[1] !== expectedLink)) return '超链接目标仅支持系统深链参数';
      const linkStarts = [...template.matchAll(/\[[^\]\r\n]+\]\(/g)].length;
      const completeLinks = [...template.matchAll(/\[[^\]\r\n]+\]\((?:\{[^{}]+\}|https:\/\/[^)\s]+)\)/g)].length;
      if (linkStarts !== completeLinks) return '超链接格式不完整或不是有效的 HTTPS 地址';
      const withoutPlaceholders = masked.replace(/\{[^{}]+\}/g, '');
      if (withoutPlaceholders.includes('{') || withoutPlaceholders.includes('}')) return '模板参数花括号不完整';
      return '';
    }

    const sqlPanel = m.dialog.querySelector('#f-sql-validation-panel');
    const pseudoPanel = m.dialog.querySelector('#f-pseudo-validation-panel');
    const sqlParameterList = m.dialog.querySelector('#f-sql-parameters');

    function captureSqlParameters() {
      sqlParameters = [...sqlParameterList.querySelectorAll('.sql-parameter-row')].map(row => ({
        name: row.querySelector('[data-sql-param="name"]').value.trim(),
        field: row.querySelector('[data-sql-param="field"]').value,
      }));
      return sqlParameters;
    }

    function renderSqlParameters() {
      const ds = Store.getDataset(m.dialog.querySelector('#f-dataset').value);
      const fields = ds?.fields || [];
      sqlParameterList.innerHTML = sqlParameters.length ? sqlParameters.map((parameter, index) => `
        <div class="sql-parameter-row" data-sql-parameter-index="${index}">
          <input class="input mono" data-sql-param="name" value="${escapeHtml(parameter.name || '')}" placeholder="参数名，如 目标ID" aria-label="SQL 参数名" />
          <span class="sql-parameter-arrow" aria-hidden="true">→</span>
          <select class="select" data-sql-param="field" aria-label="SQL 参数数据集字段">
            <option value="">请选择异常字段…</option>
            ${fields.map(field => `<option value="${escapeHtml(field.name)}" ${parameter.field === field.name ? 'selected' : ''}>${escapeHtml(field.name)} · ${escapeHtml(field.type || '')}</option>`).join('')}
          </select>
          <button type="button" class="sql-parameter-remove" data-remove-sql-parameter="${index}" aria-label="删除 SQL 参数">${Icon.x({ size: 14 })}</button>
        </div>
      `).join('') : '<div class="sql-parameter-empty">尚未配置参数；无占位符 SQL 可保持为空。</div>';
    }

    function setValidationMethod(method) {
      validationMethod = method;
      m.dialog.querySelectorAll('[data-validation-method]').forEach(button => {
        button.classList.toggle('active', button.dataset.validationMethod === method);
      });
      sqlPanel.hidden = method !== 'sql';
      pseudoPanel.hidden = method === 'sql';
    }

    m.dialog.querySelectorAll('[data-validation-method]').forEach(button => {
      button.addEventListener('click', () => setValidationMethod(button.dataset.validationMethod));
    });
    m.dialog.querySelector('#f-add-sql-parameter').addEventListener('click', () => {
      captureSqlParameters();
      sqlParameters.push({ name: '', field: '' });
      renderSqlParameters();
      sqlParameterList.querySelector('.sql-parameter-row:last-child [data-sql-param="name"]')?.focus();
    });
    sqlParameterList.addEventListener('click', event => {
      const remove = event.target.closest('[data-remove-sql-parameter]');
      if (!remove) return;
      captureSqlParameters();
      sqlParameters.splice(Number(remove.dataset.removeSqlParameter), 1);
      renderSqlParameters();
    });
    renderSqlParameters();
    setValidationMethod(validationMethod);

    const sqlSources = {
      value: sqlCondition.valueSource || 'literal',
      'upper-value': sqlCondition.upperValueSource || 'literal',
    };
    function updateSqlOperands() {
      const operator = m.dialog.querySelector('#f-sql-operator').value;
      Object.entries(sqlSources).forEach(([key, source]) => {
        const operand = m.dialog.querySelector(`#f-sql-${key}-operand`);
        operand.hidden = ['is_null', 'is_not_null'].includes(operator) || (key === 'upper-value' && operator !== 'between');
        operand.querySelector(`#f-sql-${key}`).hidden = source === 'field';
        operand.querySelector(`#f-sql-${key}-field`).hidden = source !== 'field';
        operand.querySelectorAll('[data-source]').forEach(button => {
          button.classList.toggle('active', button.dataset.source === source);
          button.setAttribute('aria-pressed', String(button.dataset.source === source));
        });
      });
    }
    m.dialog.querySelectorAll('.sql-true-condition [data-source]').forEach(button => {
      button.addEventListener('click', () => {
        sqlSources[button.closest('[data-operand]').dataset.operand] = button.dataset.source;
        updateSqlOperands();
      });
    });
    m.dialog.querySelector('#f-sql-operator').addEventListener('change', updateSqlOperands);
    updateSqlOperands();

    // ---------- Logic segmented ----------
    m.dialog.querySelectorAll('#f-logic button').forEach(b => {
      b.addEventListener('click', () => {
        m.dialog.querySelectorAll('#f-logic button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        logic = b.dataset.logic;
        renderConditions();
      });
    });

    // ---------- Dataset change → update fields ----------
    const datasetSel = m.dialog.querySelector('#f-dataset');
    const fieldSourceSel = m.dialog.querySelector('#f-field-source');
    const validationFieldsSel = m.dialog.querySelector('#f-validation-fields');
    const fieldsPreview = m.dialog.querySelector('#dataset-fields-preview');
    function wireFieldPicker(triggerId, listboxId, initialValues = []) {
      const trigger = m.dialog.querySelector(`#${triggerId}`);
      const listbox = m.dialog.querySelector(`#${listboxId}`);
      const picker = trigger.closest('.key-field-picker');
      const summary = trigger.querySelector('.key-field-picker-summary');
      let options = [];
      let selectedValues = [...new Set(initialValues.map(String))];
      let activeIndex = -1;

      function render() {
        const selected = new Set(selectedValues);
        const visibleTags = selectedValues.slice(0, 2);
        summary.innerHTML = visibleTags.length
          ? `${visibleTags.map(value => `<span class="key-field-picker-tag">${escapeHtml(value)}</span>`).join('')}${selectedValues.length > 2 ? `<span class="key-field-picker-count">+${selectedValues.length - 2}</span>` : ''}`
          : `<span class="key-field-picker-placeholder">${options.length ? '请选择字段…' : '请先选择数据集…'}</span>`;
        trigger.disabled = options.length === 0;
        listbox.innerHTML = options.map((field, index) => `
          <button type="button" class="key-field-picker-option${index === activeIndex ? ' active' : ''}"
            id="${triggerId}-option-${index}" role="option" aria-selected="${selected.has(field.name)}"
            data-key-field="${escapeHtml(field.name)}">
            <span><strong>${escapeHtml(field.name)}</strong><small>${escapeHtml(field.type)}</small></span>
            <span class="key-field-picker-check" aria-hidden="true">${Icon.check({ size: 14 })}</span>
          </button>
        `).join('');
        if (activeIndex >= 0) trigger.setAttribute('aria-activedescendant', `${triggerId}-option-${activeIndex}`);
        else trigger.removeAttribute('aria-activedescendant');
      }

      function close() {
        document.removeEventListener('click', closeOnOutsideClick);
        listbox.hidden = true;
        picker.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
        activeIndex = -1;
        trigger.removeAttribute('aria-activedescendant');
      }

      function closeOnOutsideClick(event) {
        if (!event.composedPath().includes(picker)) close();
      }

      function open() {
        if (trigger.disabled) return;
        document.removeEventListener('click', closeOnOutsideClick);
        document.addEventListener('click', closeOnOutsideClick);
        listbox.hidden = false;
        picker.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
        activeIndex = Math.max(0, options.findIndex(field => selectedValues.includes(field.name)));
        render();
      }

      function toggle(value) {
        selectedValues = selectedValues.includes(value)
          ? selectedValues.filter(field => field !== value)
          : [...selectedValues, value];
        render();
      }

      trigger.addEventListener('click', () => { if (listbox.hidden) open(); else close(); });
      trigger.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          if (!listbox.hidden) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
          return;
        }
        if (event.key === 'Tab') { close(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        if (listbox.hidden) { open(); return; }
        if (event.key === 'ArrowDown') activeIndex = (activeIndex + 1) % options.length;
        if (event.key === 'ArrowUp') activeIndex = (activeIndex - 1 + options.length) % options.length;
        if ((event.key === 'Enter' || event.key === ' ') && activeIndex >= 0) toggle(options[activeIndex].name);
        else render();
      });
      listbox.addEventListener('click', event => {
        const option = event.target.closest('[data-key-field]');
        if (!option) return;
        activeIndex = options.findIndex(field => field.name === option.dataset.keyField);
        toggle(option.dataset.keyField);
        trigger.focus();
      });

      return {
        close,
        values: () => [...selectedValues],
        setOptions(fields, values = []) {
          options = (fields || []).map(field => ({
            name: String(field.name ?? ''), type: String(field.type ?? ''),
          }));
          const allowed = new Set(options.map(field => field.name));
          selectedValues = [...new Set(values.map(String).filter(value => allowed.has(value)))];
          close();
          render();
        },
      };
    }

    const keyFieldControl = wireFieldPicker(
      'f-key-fields', 'f-key-fields-listbox', data.anomalyKeyFields || [],
    );
    const groupFieldControl = wireFieldPicker(
      'f-group-fields', 'f-group-fields-listbox', groupFields,
    );
    const timeoutFieldControl = wireFieldPicker(
      'f-timeout-fields', 'f-timeout-fields-listbox', timeoutFields,
    );
    cleanupKeyFieldPicker = () => {
      keyFieldControl.close();
      groupFieldControl.close();
      timeoutFieldControl.close();
    };
    function replaceFieldOptions(select, fields, selectedValues = [], placeholder = null) {
      const selected = new Set(selectedValues.filter(value => value !== null && value !== undefined).map(String));
      select.replaceChildren();
      if (placeholder !== null) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = placeholder;
        select.append(option);
      }
      (fields || []).forEach(field => {
        const name = String(field.name ?? '');
        const type = String(field.type ?? '');
        const option = document.createElement('option');
        option.value = name;
        option.textContent = `${name} · ${type}`;
        option.selected = selected.has(name);
        select.append(option);
      });
    }

    function updateFieldsForDataset(datasetId, initialKeyFields = []) {
      const dataset = datasetId ? Store.getDataset(datasetId) : null;
      const fieldNames = new Set((dataset?.fields || []).map(field => field.name));
      conditions.forEach(condition => {
        ['field', 'value_field', 'upper_value_field'].forEach(key => {
          if (condition[key] && !fieldNames.has(condition[key])) condition[key] = '';
        });
      });
      if (!datasetId) {
        replaceFieldOptions(fieldSourceSel, [], [], '请选择字段…');
        replaceFieldOptions(validationFieldsSel, [], [], '请先选择数据集…');
        groupFieldControl.setOptions([], []);
        timeoutFieldControl.setOptions([], []);
        keyFieldControl.setOptions([], []);
        sqlParameters = sqlParameters.map(parameter => ({ ...parameter, field: '' }));
        renderSqlParameters();
        fieldsPreview.innerHTML = '';
        renderConditions();
        return;
      }
      const ds = Store.getDataset(datasetId);
      if (!ds) return;
      const sqlFieldNames = new Set(ds.fields.map(field => String(field.name)));
      sqlParameters = sqlParameters.map(parameter => ({
        ...parameter,
        field: sqlFieldNames.has(parameter.field) ? parameter.field : '',
      }));
      renderSqlParameters();
      replaceFieldOptions(fieldSourceSel, ds.fields, [data.notify.fieldSource], '请选择字段…');
      replaceFieldOptions(validationFieldsSel, ds.fields, validationFields);
      groupFieldControl.setOptions(ds.fields, groupFields);
      timeoutFieldControl.setOptions(ds.fields, timeoutFields);
      keyFieldControl.setOptions(ds.fields, initialKeyFields);
      fieldsPreview.innerHTML = `
        <div class="schedule-preview" style="background:var(--color-info-soft);border-color:var(--color-info-line);color:#0369A1;margin-top:var(--space-3);">
          ${Icon.info({ size: 14 })}
          <span>数据集 <strong>${escapeHtml(ds.name)}</strong> 包含 <strong>${ds.fields.length}</strong> 个字段，预计扫描 <strong>${UI.formatNumber(ds.rowCount)}</strong> 行</span>
        </div>
      `;
      renderConditions();
    }
    datasetSel.addEventListener('change', () => {
      captureSqlParameters();
      updateFieldsForDataset(datasetSel.value, []);
    });

    // ---------- Conditions ----------
    const OP_LABELS = {
      'gt': '大于 >',
      'gte': '大于等于 ≥',
      'lt': '小于 <',
      'lte': '小于等于 ≤',
      'eq': '等于 =',
      'neq': '不等于 ≠',
      'between': '介于 (范围)',
      'is_null': '为空',
      'is_not_null': '不为空',
      'gt_threshold_ratio': '超过基线倍数',
      'lt_threshold_ratio': '低于基线倍数',
    };

    function renderConditions() {
      const container = m.dialog.querySelector('#conditions-container');
      const ds = Store.getDataset(datasetSel.value);
      const operand = (condition, key, placeholder) => {
        const source = condition[`${key}_source`] || 'literal';
        return `<div class="condition-operand" data-operand="${key}">
          ${source === 'field'
            ? `<select class="select" data-c="${key}_field" aria-label="${placeholder}字段"><option value="">选择比较字段…</option></select>`
            : `<input class="input mono" data-c="${key}" value="${escapeHtml(condition[key] ?? '')}" placeholder="${placeholder}" aria-label="${placeholder}" />`}
          ${operandSwitch(source)}
        </div>`;
      };
      container.innerHTML = conditions.map((c, idx) => {
        const showValue = !['is_null', 'is_not_null'].includes(c.op);
        const showBaseline = c.op === 'gt_threshold_ratio' || c.op === 'lt_threshold_ratio';
        return `
          ${idx > 0 ? `<div class="condition-logic">${logic}</div>` : ''}
          <div class="condition-row" data-idx="${idx}">
            <select class="select" data-c="field">
              <option value="">选择字段…</option>
            </select>
            <select class="select" data-c="op">
              ${Object.entries(OP_LABELS).map(([k, v]) => `<option value="${k}" ${c.op === k ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
            ${showValue ? operand(c, 'value', showBaseline ? '基线倍数' : c.op === 'between' ? '范围下界' : '比较值') : ''}
            <button type="button" class="row-action danger" data-remove="${idx}" aria-label="删除条件" ${conditions.length === 1 ? 'disabled style="opacity:0.3;"' : ''}>${Icon.trash({ size: 14 })}</button>
            ${c.op === 'between' ? operand(c, 'upper_value', '范围上界') : ''}
            ${showBaseline ? `<select class="select" data-c="baseline" style="grid-column:1/-1;">
              <option value="">选择基线…</option>
              <option value="7d_avg" ${c.baseline === '7d_avg' ? 'selected' : ''}>近 7 日均值</option>
              <option value="30d_avg" ${c.baseline === '30d_avg' ? 'selected' : ''}>近 30 日均值</option>
              <option value="prev_period" ${c.baseline === 'prev_period' ? 'selected' : ''}>上一周期</option>
            </select>` : ''}
          </div>
        `;
      }).join('');

      // Set field values
      container.querySelectorAll('.condition-row').forEach((row, idx) => {
        const c = conditions[idx];
        const fieldSel = row.querySelector('[data-c="field"]');
        if (fieldSel) replaceFieldOptions(fieldSel, ds?.fields || [], [c.field], '选择字段…');
        ['value_field', 'upper_value_field'].forEach(key => {
          const select = row.querySelector(`[data-c="${key}"]`);
          if (select) replaceFieldOptions(select, ds?.fields || [], [c[key]], '选择比较字段…');
        });
        row.querySelectorAll('[data-source]').forEach(button => {
          button.addEventListener('click', () => {
            c[`${button.closest('[data-operand]').dataset.operand}_source`] = button.dataset.source;
            renderConditions();
          });
        });
        row.querySelectorAll('[data-c]').forEach(el => {
          el.addEventListener('change', () => {
            conditions[idx][el.dataset.c] = el.value;
            if (el.dataset.c === 'op') {
              delete conditions[idx].operator;
              renderConditions();
            }
          });
          if (el.tagName === 'INPUT') {
            el.addEventListener('input', () => { conditions[idx][el.dataset.c] = el.value; });
          }
        });
        row.querySelector('[data-remove]')?.addEventListener('click', () => {
          if (conditions.length > 1) { conditions.splice(idx, 1); renderConditions(); }
        });
      });
    }
    m.dialog.querySelector('#add-condition').addEventListener('click', () => {
      conditions.push({ field: '', op: 'gt', value: '', baseline: null });
      renderConditions();
    });

    // ---------- Frequency change ----------
    const freqSel = m.dialog.querySelector('#f-freq');
    const timeInput = m.dialog.querySelector('#f-time');
    freqSel.addEventListener('change', () => {
      timeInput.disabled = freqSel.value !== 'day';
      if (freqSel.value !== 'day') timeInput.value = '';
      renderSchedulePreview();
    });
    [timeInput, m.dialog.querySelector('#f-interval'), m.dialog.querySelector('#f-start'), m.dialog.querySelector('#f-end')].forEach(el => {
      el.addEventListener('input', renderSchedulePreview);
      el.addEventListener('change', renderSchedulePreview);
    });

    function renderSchedulePreview() {
      const freq = freqSel.value;
      const interval = m.dialog.querySelector('#f-interval').value || 1;
      const time = timeInput.value;
      const start = m.dialog.querySelector('#f-start').value;
      const end = m.dialog.querySelector('#f-end').value;
      const cronDesc = {
        min: `每 ${interval} 分钟执行一次`,
        hour: `每 ${interval} 小时执行一次`,
        day: `每日 ${time || '00:00'} 执行`,
      }[freq];
      const preview = m.dialog.querySelector('#schedule-preview');
      preview.innerHTML = `
        <div class="schedule-preview">
          ${Icon.calendar({ size: 14 })}
          <span>${cronDesc}</span>
          ${start ? `<code>起 ${start}</code>` : ''}
          ${end ? `<code>止 ${end}</code>` : ''}
          ${!end ? '<code>长期</code>' : ''}
        </div>
      `;
    }
    renderSchedulePreview();

    // ---------- Notify mode ----------
    m.dialog.querySelectorAll('#f-notify-mode button').forEach(b => {
      b.addEventListener('click', () => {
        m.dialog.querySelectorAll('#f-notify-mode button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        notifyMode = b.dataset.mode;
        m.dialog.querySelector('#notify-manual').style.display = notifyMode === 'manual' ? 'block' : 'none';
        m.dialog.querySelector('#notify-field').style.display = notifyMode === 'field' ? 'block' : 'none';
      });
    });

    // ---------- Tag inputs ----------
    function wireTagInput(containerSel, inputSel, arr) {
      const container = m.dialog.querySelector(containerSel);
      const input = m.dialog.querySelector(inputSel);
      function render() {
        // Remove all pills
        container.querySelectorAll('.tag-pill').forEach(p => p.remove());
        arr.forEach((v, i) => {
          const pill = document.createElement('span');
          pill.className = 'tag-pill';
          pill.innerHTML = `<span>${escapeHtml(v)}</span><button type="button" aria-label="移除">${Icon.x({ size: 10 })}</button>`;
          pill.querySelector('button').addEventListener('click', () => { arr.splice(i, 1); render(); });
          container.insertBefore(pill, input);
        });
      }
      function commitPendingValue() {
        const value = input.value.trim();
        if (value && !arr.includes(value)) arr.push(value);
        input.value = '';
        render();
      }
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          commitPendingValue();
        }
        if (e.key === 'Backspace' && !input.value && arr.length > 0) { arr.pop(); render(); }
      });
      render();
      return commitPendingValue;
    }
    const commitPendingTargets = [
      wireTagInput('#f-openids', '#f-openids-input', openIds),
      wireTagInput('#f-userids', '#f-userids-input', userIds),
      wireTagInput('#f-unionids', '#f-unionids-input', unionIds),
      wireTagInput('#f-emails', '#f-emails-input', emails),
      wireTagInput('#f-chatids', '#f-chatids-input', chatIds),
    ];
    const commitPendingValidationTarget = wireTagInput(
      '#f-validation-userids', '#f-validation-userids-input', validationUserIds,
    );
    const commitPendingGroupTarget = wireTagInput(
      '#f-group-userids', '#f-group-userids-input', groupUserIds,
    );
    const commitPendingTimeoutTarget = wireTagInput(
      '#f-timeout-userids', '#f-timeout-userids-input', timeoutUserIds,
    );
    const groupWebhookInput = m.dialog.querySelector('#f-group-webhook');

    // ---------- Cancel / Test / Save ----------
    m.dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => m.close());

    m.dialog.querySelector('#f-test').addEventListener('click', async () => {
      const btn = m.dialog.querySelector('#f-test');
      if (btn.disabled || !m.dialog.isConnected || runningRules.has(id)) return;
      runningRules.add(id);
      const original = btn.innerHTML;
      btn.innerHTML = `<span class="btn-spinner"></span>执行中…`;
      btn.disabled = true;
      try {
        if (!editing) throw new Error('请先保存规则，再执行真实检测');
        const run = await Store.executeRule(id);
        if (!m.dialog.isConnected) return;
        UI.toast({ type: run.new_anomalies ? 'warning' : 'success', title: '真实检测完成', desc: `扫描 ${run.scanned_rows} 行 · 新增 ${run.new_anomalies} 条` });
        if (run.refreshWarning) UI.toast({ type: 'warning', title: '检测完成，页面刷新失败', desc: run.refreshWarning });
      } catch (error) { if (m.dialog.isConnected) UI.toast({ type: 'error', title: '执行失败', desc: error.message }); }
      finally {
        runningRules.delete(id);
        syncPendingControls();
        if (btn.isConnected) { btn.innerHTML = original; btn.disabled = false; }
      }
    });

    m.dialog.querySelector('#f-save').addEventListener('click', async () => {
      const btn = m.dialog.querySelector('#f-save');
      if (btn.disabled || !m.dialog.isConnected) return;
      const name = m.dialog.querySelector('#f-name').value.trim();
      const datasetId = m.dialog.querySelector('#f-dataset').value;
      if (!name) { revealField('#f-name'); UI.toast({ type: 'warning', title: '请填写规则名称' }); return; }
      if (!datasetId) { revealField('#f-dataset'); UI.toast({ type: 'warning', title: '请选择关联数据集' }); return; }

      const ds = Store.getDataset(datasetId);
      const validConditions = conditions.filter(c => c.field && c.op);
      if (validConditions.length === 0) { revealField('.condition-row [data-c="field"], #add-condition'); UI.toast({ type: 'warning', title: '请至少配置一个有效条件' }); return; }
      const fieldType = name => {
        const type = (ds?.fields || []).find(field => field.name === name)?.type?.toLowerCase() || '';
        if (/int|decimal|numeric|float|double|real|number/.test(type)) return 'number';
        if (/char|text|string/.test(type)) return 'string';
        if (/date|time/.test(type)) return 'date';
        if (/bool/.test(type)) return 'boolean';
        return '';
      };
      for (const [index, condition] of conditions.entries()) {
        let error = '';
        let key = 'field';
        if (!condition.field || !(ds?.fields || []).some(field => field.name === condition.field)) error = '请选择有效的条件字段';
        else if (!['is_null', 'is_not_null'].includes(condition.op)) {
          for (const operand of condition.op === 'between' ? ['value', 'upper_value'] : ['value']) {
            key = condition[`${operand}_source`] === 'field' ? `${operand}_field` : operand;
            const value = condition[key];
            if (value === undefined || value === null || String(value).trim() === '') { error = key.endsWith('_field') ? '请选择比较字段' : '请填写比较值'; break; }
            if (key.endsWith('_field')) {
              const actualType = fieldType(condition.field);
              const targetType = fieldType(value);
              if (!(ds?.fields || []).some(field => field.name === value)) { error = '比较字段不存在'; break; }
              if (condition.op.endsWith('_threshold_ratio') && targetType && targetType !== 'number') { error = '基线倍数需要数值类型的比较字段'; break; }
              if (actualType && targetType && actualType !== targetType) { error = '比较字段类型不兼容'; break; }
            } else if ((condition.op.endsWith('_threshold_ratio') || fieldType(condition.field) === 'number') && !Number.isFinite(Number(value))) {
              error = '当前运算符需要数值比较值'; break;
            }
          }
        }
        if (error) {
          revealField(`.condition-row[data-idx="${index}"] [data-c="${key}"]`);
          UI.toast({ type: 'warning', title: error }); return;
        }
      }
      const anomalyKeyFields = keyFieldControl.values();
      if (!anomalyKeyFields.length) { revealField('#f-key-fields'); UI.toast({ type: 'warning', title: '请至少选择一个异常主键字段' }); return; }

      const privateMessageTemplate = m.dialog.querySelector('#f-private-message-template').value.trim();
      const groupMessageTemplate = m.dialog.querySelector('#f-group-message-template').value.trim();
      const timeoutMessageTemplate = m.dialog.querySelector('#f-timeout-message-template').value.trim();
      const templateFields = ds?.fields || [];
      const templateChecks = [
        {
          message: validateTemplateInput(privateMessageTemplate, templateFields, 'private'),
          error: m.dialog.querySelector('#f-private-template-error'),
          control: '#f-private-message-template',
        },
        {
          message: validateTemplateInput(groupMessageTemplate, templateFields, 'group'),
          error: m.dialog.querySelector('#f-group-template-error'),
          control: '#f-group-message-template',
        },
        {
          message: validateTemplateInput(timeoutMessageTemplate, templateFields, 'group'),
          error: m.dialog.querySelector('#f-timeout-template-error'),
          control: '#f-timeout-message-template',
        },
      ];
      templateChecks.forEach(check => {
        check.error.querySelector('span').textContent = check.message;
        check.error.style.display = check.message ? 'flex' : 'none';
      });
      const invalidTemplate = templateChecks.find(check => check.message);
      if (invalidTemplate) {
        revealField(invalidTemplate.control);
        return;
      }

      commitPendingTargets.forEach(commit => commit());
      const notificationTargets = [
        ...openIds.map(value => ({ receive_id_type: 'open_id', source: 'literal', value })),
        ...userIds.map(value => ({ receive_id_type: 'user_id', source: 'literal', value })),
        ...unionIds.map(value => ({ receive_id_type: 'union_id', source: 'literal', value })),
        ...emails.map(value => ({ receive_id_type: 'email', source: 'literal', value })),
        ...chatIds.map(value => ({ receive_id_type: 'chat_id', source: 'literal', value })),
      ];
      if (notifyMode === 'field' && m.dialog.querySelector('#f-field-source').value) notificationTargets.push({ receive_id_type: m.dialog.querySelector('#f-field-id-type').value, source: 'field', field: m.dialog.querySelector('#f-field-source').value });
      if (!notificationTargets.length) {
        revealField(notifyMode === 'field' ? '#f-field-source' : '#f-openids-input');
        UI.toast({ type: 'warning', title: '请至少配置一个私聊通知接收目标' });
        return;
      }

      commitPendingValidationTarget();
      validationFields = [...validationFieldsSel.selectedOptions].map(option => option.value).filter(Boolean);
      const validationTargets = [
        ...validationUserIds.map(value => ({ source: 'literal', value })),
        ...validationFields.map(field => ({ source: 'field', field })),
      ];
      const validationEnabled = m.dialog.querySelector('#f-validation-enabled').checked;
      const units = ['days', 'hours', 'minutes', 'seconds'];
      const values = units.map(unit => m.dialog.querySelector(`#f-deadline-${unit}`).value);
      const numbers = values.map(Number);
      const deadlineSeconds = numbers[0] * 86400 + numbers[1] * 3600 + numbers[2] * 60 + numbers[3];
      const invalidUnit = numbers.findIndex((value, i) => !values[i].trim() || !Number.isInteger(value) || value < 0 || value > [30, 23, 59, 59][i]);
      if (invalidUnit >= 0 || deadlineSeconds < 1 || deadlineSeconds > 2592000) {
        revealField(`#f-deadline-${units[Math.max(0, invalidUnit)]}`);
        UI.toast({ type: 'warning', title: '截止时间需填写整数，总时长为 1 秒至 30 天' });
        return;
      }
      const parseSqlOperand = raw => {
        const value = raw.trim();
        if (!value) return null;
        return /^-?(?:\d+\.?\d*|\.\d+)$/.test(value) ? Number(value) : value;
      };
      const sqlTrueOperator = m.dialog.querySelector('#f-sql-operator').value;
      const sqlValidationConfig = validationMethod === 'sql' ? {
        datasourceId: m.dialog.querySelector('#f-sql-datasource').value.trim(),
        queryTemplate: m.dialog.querySelector('#f-validation-sql').value.trim(),
        parameters: captureSqlParameters(),
        trueCondition: {
          field: m.dialog.querySelector('#f-sql-result-field').value.trim(),
          operator: sqlTrueOperator,
          value: ['is_null', 'is_not_null'].includes(sqlTrueOperator) ? null : parseSqlOperand(m.dialog.querySelector('#f-sql-value').value),
          upperValue: sqlTrueOperator === 'between' ? parseSqlOperand(m.dialog.querySelector('#f-sql-upper-value').value) : null,
          valueSource: sqlSources.value,
          valueField: m.dialog.querySelector('#f-sql-value-field').value.trim() || null,
          upperValueSource: sqlSources['upper-value'],
          upperValueField: m.dialog.querySelector('#f-sql-upper-value-field').value.trim() || null,
        },
      } : null;
      const validationError = m.dialog.querySelector('#f-validation-target-error');
      let validationMessage = '';
      let validationControl = '#f-validation-sql';
      if (validationEnabled && !validationTargets.length) {
        validationMessage = '启用实时校验时，请至少配置一个验证目标';
        validationControl = '#f-validation-userids-input';
      } else if (validationMethod === 'sql') {
        const parameterNames = sqlValidationConfig.parameters.map(item => item.name);
        const placeholders = [...sqlValidationConfig.queryTemplate.matchAll(/\{([^{}]+)\}/g)].map(match => match[1].trim());
        const missingMappings = [...new Set(placeholders)].filter(name => !parameterNames.includes(name));
        const unusedMappings = [...new Set(parameterNames)].filter(name => !placeholders.includes(name));
        if (!Store.getDatasources().length) {
          validationMessage = '请先创建数据源后再配置 SQL 校验';
          validationControl = '#f-sql-datasource';
        } else if (!sqlValidationConfig.datasourceId) {
          validationMessage = 'SQL 校验必须选择校验数据源';
          validationControl = '#f-sql-datasource';
        } else if (!Store.getDatasource(sqlValidationConfig.datasourceId)) {
          validationMessage = '所选校验数据源不可用，请重新选择';
          validationControl = '#f-sql-datasource';
        } else if (!sqlValidationConfig.queryTemplate) validationMessage = 'SQL 校验必须填写查询 SQL';
        else if (sqlValidationConfig.parameters.some(item => !item.name || !item.field)) {
          validationMessage = '每个 SQL 参数都必须填写参数名并选择异常字段';
          const index = sqlValidationConfig.parameters.findIndex(item => !item.name || !item.field);
          validationControl = `[data-sql-parameter-index="${index}"] [data-sql-param="${sqlValidationConfig.parameters[index].name ? 'field' : 'name'}"]`;
        } else if (new Set(parameterNames).size !== parameterNames.length) {
          validationMessage = 'SQL 参数名不能重复';
          const index = parameterNames.findIndex((name, index) => parameterNames.indexOf(name) !== index);
          validationControl = `[data-sql-parameter-index="${index}"] [data-sql-param="name"]`;
        }
        else if (missingMappings.length) validationMessage = `SQL 占位符缺少参数映射：${missingMappings.join('、')}`;
        else if (unusedMappings.length) validationMessage = `SQL 参数未在查询中使用：${unusedMappings.join('、')}`;
        else if (!sqlValidationConfig.trueCondition.field) {
          validationMessage = 'True 条件必须填写结果字段';
          validationControl = '#f-sql-result-field';
        } else if (!['is_null', 'is_not_null'].includes(sqlTrueOperator)) {
          for (const key of sqlTrueOperator === 'between' ? ['value', 'upper-value'] : ['value']) {
            const input = m.dialog.querySelector(`#f-sql-${key}${sqlSources[key] === 'field' ? '-field' : ''}`);
            if (!input.value.trim()) {
              validationMessage = sqlSources[key] === 'field' ? '请填写 SQL 结果比较字段名' : '请填写 True 条件比较值';
              validationControl = `#${input.id}`; break;
            }
          }
        }
      }
      validationError.querySelector('span').textContent = validationMessage;
      validationError.style.display = validationMessage ? 'flex' : 'none';
      if (validationMessage) {
        revealField(validationControl);
        return;
      }

      commitPendingGroupTarget();
      commitPendingTimeoutTarget();
      groupFields = groupFieldControl.values();
      const groupBroadcastEnabled = m.dialog.querySelector('#f-group-broadcast-enabled').checked;
      const timeoutBroadcastEnabled = m.dialog.querySelector('#f-timeout-broadcast-enabled').checked;
      const groupWebhookUrl = groupWebhookInput.value.trim();
      const groupMentionTargets = [
        ...groupUserIds.map(value => ({ source: 'literal', value })),
        ...groupFields.map(field => ({ source: 'field', field })),
      ];
      const groupBroadcastError = m.dialog.querySelector('#f-group-broadcast-error');
      let groupBroadcastMessage = '';
      if ((groupBroadcastEnabled || timeoutBroadcastEnabled) && !groupWebhookUrl) {
        groupBroadcastMessage = '启用群聊播报时必须配置 webhook';

      }
      groupBroadcastError.querySelector('span').textContent = groupBroadcastMessage;
      groupBroadcastError.style.display = groupBroadcastMessage ? 'flex' : 'none';
      if (groupBroadcastMessage) {
        revealField(!groupWebhookUrl ? '#f-group-webhook' : '#f-timeout-broadcast-enabled');
        return;
      }

      const payload = {
        name,
        description: m.dialog.querySelector('#f-desc').value.trim(),
        datasetId,
        datasetName: ds ? ds.name : '',
        severity: m.dialog.querySelector('#f-severity').value,
        enabled: editing ? editing.enabled : true,
        conditions: validConditions,
        anomalyKeyFields,
        repeatPushEnabled: m.dialog.querySelector('#f-repeat-push-enabled').checked,
        notificationTargets,
        privateMessageTemplate: privateMessageTemplate || null,
        validationEnabled,
        validationTargets,
        deadlineSeconds,
        validationMethod,
        sqlValidationConfig,
        groupBroadcast: {
          webhookUrl: groupWebhookUrl || null,
          situation: {
            enabled: groupBroadcastEnabled,
            mentionTargets: groupMentionTargets,
            messageTemplate: groupMessageTemplate || null,
          },
          timeout: {
            enabled: timeoutBroadcastEnabled,
            mentionTargets: [
              ...timeoutUserIds.map(value => ({ source: 'literal', value })),
              ...timeoutFieldControl.values().map(field => ({ source: 'field', field })),
            ],
            messageTemplate: timeoutMessageTemplate || null,
          },
        },
        logic,
        schedule: {
          frequency: freqSel.value,
          interval: parseInt(m.dialog.querySelector('#f-interval').value) || 1,
          time: m.dialog.querySelector('#f-time').value || null,
          start: m.dialog.querySelector('#f-start').value,
          end: m.dialog.querySelector('#f-end').value || null,
        },
        notify: {
          type: 'feishu',
          mode: notifyMode,
          openIds,
          userIds,
          fieldSource: notifyMode === 'field' ? m.dialog.querySelector('#f-field-source').value : null,
        },
      };

      const original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="btn-spinner"></span>保存中…';
      try {
        if (editing) await Store.updateRule(id, payload); else await Store.addRule(payload);
        if (!m.dialog.isConnected) return;
        UI.toast({ type: 'success', title: editing ? '已保存' : '已创建', desc: name });
        m.close(); if (ownsPage(root)) { renderList(); renderStats(); }
      } catch (error) { if (m.dialog.isConnected) UI.toast({ type: 'error', title: '保存失败', desc: error.message }); }
      finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = original; } }
    });

    if (data.datasetId) updateFieldsForDataset(data.datasetId, data.anomalyKeyFields || []);
    else renderConditions();
  }

  return { render, openItem: openForm };
})();
