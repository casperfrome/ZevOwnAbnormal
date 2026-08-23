/* ============================================================
   rules.js — Anomaly Rule Configuration module
   Features: CRUD, condition builder, scheduling, Feishu notification
   ============================================================ */
window.RulesModule = (function () {
  const { escapeHtml, formatTime } = UI;
  let state = { search: '', statusFilter: 'all', page: 1, pageSize: 8 };

  function renderActions(actionsEl) {
    actionsEl.innerHTML = `
      <button class="btn btn-secondary btn-sm" id="r-refresh">${Icon.refresh({ size: 14 })}<span>刷新</span></button>
      <button class="btn btn-accent" id="r-add">${Icon.plus({ size: 16 })}<span>新建规则</span></button>
    `;
    actionsEl.querySelector('#r-add').addEventListener('click', () => openForm());
    actionsEl.querySelector('#r-refresh').addEventListener('click', async () => {
      try {
        await Store.refresh();
        renderStats();
        renderList();
        UI.toast({ type: 'info', title: '已刷新' });
      } catch (error) {
        UI.toast({ type: 'error', title: '刷新失败', desc: error.message });
      }
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
        const r = Store.getRule(inp.dataset.id);
        try {
          await Store.enableRule(inp.dataset.id, inp.checked);
          UI.toast({ type: inp.checked ? 'success' : 'info', title: inp.checked ? '已启用' : '已停用', desc: r.name });
          renderList(); renderStats();
        } catch (error) { inp.checked = !inp.checked; UI.toast({ type: 'error', title: '调度同步失败', desc: error.message }); }
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
    const r = Store.getRule(id);
    if (!r) return;
    UI.toast({ type: 'info', title: '开始执行', desc: r.name });
    try {
      const run = await Store.executeRule(id);
      const type = run.new_anomalies > 0 ? 'warning' : 'success';
      UI.toast({ type, title: run.new_anomalies > 0 ? '检测到异常' : '执行完成', desc: `扫描 ${run.scanned_rows} 行 · 新增 ${run.new_anomalies} 条` });
      renderList(); renderStats();
    } catch (error) { UI.toast({ type: 'error', title: '执行失败', desc: error.message }); }
  }

  async function confirmDelete(id) {
    const r = Store.getRule(id);
    if (!r) return;
    const ok = await UI.confirm({ title: '删除规则', desc: `确定要删除「${r.name}」吗？历史异常记录将保留。`, confirmText: '删除', danger: true });
    if (ok) {
      try { await Store.deleteRule(id); UI.toast({ type: 'success', title: '已删除', desc: r.name }); renderList(); renderStats(); }
      catch (error) { UI.toast({ type: 'error', title: '删除失败', desc: error.message }); }
    }
  }

  // ---------- Form (add/edit) ----------
  function openForm(id) {
    const editing = id ? Store.getRule(id) : null;
    const data = editing || {
      name: '', description: '', datasetId: '', severity: 'medium',
      conditions: [{ field: '', op: 'gt', value: '', baseline: null }],
      logic: 'AND',
      schedule: { frequency: 'day', interval: 1, time: '09:00', start: '2026-08-09', end: '' },
      enabled: true,
      notify: { type: 'feishu', openIds: [], userIds: [], fieldSource: null, mode: 'manual' },
      validationEnabled: false,
      validationTargets: [],
      validationTimeoutMinutes: 1440,
      validationMethod: 'pseudo',
      sqlValidationConfig: null,
      groupBroadcast: { enabled: false, hasWebhook: false, mentionTargets: [] },
    };
    const groupBroadcast = data.groupBroadcast || { enabled: false, hasWebhook: false, mentionTargets: [] };

    const datasets = Store.getDatasets();

    let cleanupKeyFieldPicker = () => {};
    const m = UI.modal({
      title: editing ? '编辑异常规则' : '新建异常规则',
      subtitle: editing ? `修改 ${data.name}` : '配置检测条件、调度策略与通知方式',
      size: 'xl',
      onClose: () => cleanupKeyFieldPicker(),
      body: `
        <div class="form-section">
          <div class="form-section-title">${Icon.info({ size: 14 })}基本信息</div>
          <div class="form-grid">
            ${UI.field('规则名称', `<input class="input" id="f-name" value="${escapeHtml(data.name)}" placeholder="例如：订单金额突增检测" />`, { required: true })}
            ${UI.field('严重程度', `
              <select class="select" id="f-severity">
                <option value="critical" ${data.severity === 'critical' ? 'selected' : ''}>严重 — 立即响应</option>
                <option value="high" ${data.severity === 'high' ? 'selected' : ''}>高 — 工作时间内响应</option>
                <option value="medium" ${data.severity === 'medium' ? 'selected' : ''}>中 — 当日响应</option>
                <option value="low" ${data.severity === 'low' ? 'selected' : ''}>低 — 周度复盘</option>
              </select>
            `, { required: true })}
            ${UI.field('异常描述', `<input class="input" id="f-desc" value="${escapeHtml(data.description || '')}" placeholder="说明异常现象与验证人需要确认的内容" />`, { optional: true, span2: true })}
          </div>
        </div>

        <div class="form-section validation-config">
          <div class="form-section-title">${Icon.shield({ size: 14 })}实时校验</div>
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
            ${UI.field('超时时间（分钟）', `<input class="input mono" id="f-validation-timeout" type="number" min="1" max="43200" value="${data.validationTimeoutMinutes ?? 1440}" />`, { required: true, help: '1–43200 分钟；到期未提交将标记为已超时' })}
            ${UI.field('固定处理人 user_id', `<div class="tag-input" id="f-validation-userids"><input type="text" placeholder="输入 user_id 后回车" id="f-validation-userids-input" /></div>`, { optional: true, help: '可配置多个；保存时会自动收录尚未回车的内容' })}
            ${UI.field('数据集字段处理人', `<select class="select" id="f-validation-fields" multiple size="4"><option value="">请先选择数据集…</option></select>`, { optional: true, span2: true, help: '可多选；每行从所选字段读取 user_id' })}
          </div>
          <div id="f-pseudo-validation-panel" class="validation-method-panel validation-pseudo-note" ${data.validationMethod === 'sql' ? 'hidden' : ''}>
            ${Icon.info({ size: 14 })}<span>处理人在飞书卡片填写说明并提交后，异常即视为校验通过。</span>
          </div>
          <div id="f-sql-validation-panel" class="validation-method-panel sql-validation-panel" ${data.validationMethod === 'sql' ? '' : 'hidden'}>
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
              <input class="input mono" id="f-sql-value" placeholder="期望值" value="${escapeHtml(data.sqlValidationConfig?.trueCondition?.value ?? '')}" aria-label="SQL True 条件期望值" />
              <input class="input mono" id="f-sql-upper-value" placeholder="范围上界（between）" value="${escapeHtml(data.sqlValidationConfig?.trueCondition?.upperValue ?? '')}" aria-label="SQL True 条件范围上界" />
            </div>
          </div>
          <div class="field-error" id="f-validation-target-error" style="display:none;">${Icon.alert({ size: 12 })}<span></span></div>
        </div>

        <div class="form-section">
          <div class="form-section-title">${Icon.table({ size: 14 })}关联数据集</div>
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
        </div>

        <div class="form-section">
          <div class="form-section-title">${Icon.sliders({ size: 14 })}异常条件</div>
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

        <div class="form-section">
          <div class="form-section-title">${Icon.clock({ size: 14 })}调度规则</div>
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

        <div class="form-section">
          <div class="form-section-title">${Icon.send({ size: 14 })}飞书通知</div>
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
        </div>

        <div class="form-section group-broadcast-config">
          <div class="form-section-title">${Icon.send({ size: 14 })}群聊播报</div>
          <div class="form-section-desc">每次规则成功执行后，将本批异常记录组汇总发送到飞书话题群</div>
          <div class="validation-toggle-row">
            <div>
              <div class="cell-strong">启用群聊播报</div>
              <div class="cell-muted">关闭时保留 webhook 与艾特目标配置</div>
            </div>
            <label class="switch">
              <input type="checkbox" id="f-group-broadcast-enabled" ${groupBroadcast.enabled ? 'checked' : ''} aria-label="启用群聊播报" />
              <span class="switch-slider"></span>
            </label>
          </div>
          <div class="form-grid">
            ${UI.field('话题群机器人 webhook', `
              <input class="input mono" id="f-group-webhook" type="password" autocomplete="new-password" placeholder="${groupBroadcast.hasWebhook ? '已配置，留空将保留现有 webhook' : 'https://open.feishu.cn/open-apis/bot/v2/hook/...'}" />
              ${groupBroadcast.hasWebhook ? `<label class="field-help" style="display:flex;align-items:center;gap:var(--space-2);"><input type="checkbox" id="f-group-webhook-clear" />清除已配置 webhook</label>` : ''}
            `, { optional: true, span2: true, help: '仅支持飞书机器人 HTTPS webhook；已保存的地址不会回显' })}
            ${UI.field('固定艾特用户 user_id', `<div class="tag-input" id="f-group-userids"><input type="text" placeholder="输入 user_id 后回车" id="f-group-userids-input" /></div>`, { optional: true, help: '可配置多个；保存时会自动收录尚未回车的内容' })}
            ${UI.field('数据集字段 user_id', `<select class="select" id="f-group-fields" multiple size="4"><option value="">请先选择数据集…</option></select>`, { optional: true, help: '可多选；每条异常从所选字段读取 user_id' })}
          </div>
          <div class="field-error" id="f-group-broadcast-error" style="display:none;">${Icon.alert({ size: 12 })}<span></span></div>
        </div>
      `,
      footer: `
        <button type="button" class="btn btn-ghost" data-action="cancel">取消</button>
        <button type="button" class="btn btn-secondary" id="f-test">${Icon.zap({ size: 16 })}模拟执行</button>
        <button type="button" class="btn btn-accent" id="f-save">${Icon.check({ size: 16 })}${editing ? '保存规则' : '创建规则'}</button>
      `,
    });

    // ---------- State within form ----------
    let conditions = data.conditions.map(({ operator, op, ...condition }) => ({
      ...condition,
      op: op || operator,
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
    let groupUserIds = (groupBroadcast.mentionTargets || []).filter(t => t.source === 'literal').map(t => t.value);
    let groupFields = (groupBroadcast.mentionTargets || []).filter(t => t.source === 'field').map(t => t.field);
    let validationMethod = data.validationMethod || 'pseudo';
    let sqlParameters = (data.sqlValidationConfig?.parameters || []).map(item => ({ ...item }));

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
    const groupFieldsSel = m.dialog.querySelector('#f-group-fields');
    const keyFieldsTrigger = m.dialog.querySelector('#f-key-fields');
    const keyFieldsListbox = m.dialog.querySelector('#f-key-fields-listbox');
    const keyFieldsPicker = keyFieldsTrigger.closest('.key-field-picker');
    const keyFieldsSummary = keyFieldsTrigger.querySelector('.key-field-picker-summary');
    const fieldsPreview = m.dialog.querySelector('#dataset-fields-preview');
    let keyFieldOptions = [];
    let selectedKeyFields = [...new Set((data.anomalyKeyFields || []).map(String))];
    let activeKeyFieldIndex = -1;

    function renderKeyFieldPicker() {
      const selected = new Set(selectedKeyFields);
      const visibleTags = selectedKeyFields.slice(0, 2);
      keyFieldsSummary.innerHTML = visibleTags.length
        ? `${visibleTags.map(value => `<span class="key-field-picker-tag">${escapeHtml(value)}</span>`).join('')}${selectedKeyFields.length > 2 ? `<span class="key-field-picker-count">+${selectedKeyFields.length - 2}</span>` : ''}`
        : `<span class="key-field-picker-placeholder">${keyFieldOptions.length ? '请选择字段…' : '请先选择数据集…'}</span>`;
      keyFieldsTrigger.disabled = keyFieldOptions.length === 0;
      keyFieldsListbox.innerHTML = keyFieldOptions.map((field, index) => `
        <button type="button" class="key-field-picker-option${index === activeKeyFieldIndex ? ' active' : ''}"
          id="f-key-field-option-${index}" role="option" aria-selected="${selected.has(field.name)}"
          data-key-field="${escapeHtml(field.name)}">
          <span><strong>${escapeHtml(field.name)}</strong><small>${escapeHtml(field.type)}</small></span>
          <span class="key-field-picker-check" aria-hidden="true">${Icon.check({ size: 14 })}</span>
        </button>
      `).join('');
      if (activeKeyFieldIndex >= 0) {
        keyFieldsTrigger.setAttribute('aria-activedescendant', `f-key-field-option-${activeKeyFieldIndex}`);
      } else {
        keyFieldsTrigger.removeAttribute('aria-activedescendant');
      }
    }

    function setKeyFieldOptions(fields, selectedValues = []) {
      keyFieldOptions = (fields || []).map(field => ({
        name: String(field.name ?? ''),
        type: String(field.type ?? ''),
      }));
      const allowed = new Set(keyFieldOptions.map(field => field.name));
      selectedKeyFields = [...new Set(selectedValues.map(String).filter(value => allowed.has(value)))];
      activeKeyFieldIndex = -1;
      closeKeyFieldPicker();
      renderKeyFieldPicker();
    }

    function openKeyFieldPicker() {
      if (keyFieldsTrigger.disabled) return;
      document.removeEventListener('click', closeKeyFieldsOnOutsideClick);
      document.addEventListener('click', closeKeyFieldsOnOutsideClick);
      keyFieldsListbox.hidden = false;
      keyFieldsPicker.classList.add('open');
      keyFieldsTrigger.setAttribute('aria-expanded', 'true');
      activeKeyFieldIndex = Math.max(0, keyFieldOptions.findIndex(field => selectedKeyFields.includes(field.name)));
      renderKeyFieldPicker();
    }

    function closeKeyFieldPicker() {
      document.removeEventListener('click', closeKeyFieldsOnOutsideClick);
      keyFieldsListbox.hidden = true;
      keyFieldsPicker.classList.remove('open');
      keyFieldsTrigger.setAttribute('aria-expanded', 'false');
      activeKeyFieldIndex = -1;
      keyFieldsTrigger.removeAttribute('aria-activedescendant');
    }

    function closeKeyFieldsOnOutsideClick(event) {
      if (!event.composedPath().includes(keyFieldsPicker)) closeKeyFieldPicker();
    }

    cleanupKeyFieldPicker = closeKeyFieldPicker;

    function toggleKeyField(value) {
      if (selectedKeyFields.includes(value)) {
        selectedKeyFields = selectedKeyFields.filter(field => field !== value);
      } else {
        selectedKeyFields.push(value);
      }
      renderKeyFieldPicker();
    }

    keyFieldsTrigger.addEventListener('click', () => {
      if (keyFieldsListbox.hidden) openKeyFieldPicker(); else closeKeyFieldPicker();
    });
    keyFieldsTrigger.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        if (!keyFieldsListbox.hidden) {
          event.preventDefault();
          event.stopPropagation();
          closeKeyFieldPicker();
        }
        return;
      }
      if (event.key === 'Tab') { closeKeyFieldPicker(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      if (keyFieldsListbox.hidden) { openKeyFieldPicker(); return; }
      if (event.key === 'ArrowDown') activeKeyFieldIndex = (activeKeyFieldIndex + 1) % keyFieldOptions.length;
      if (event.key === 'ArrowUp') activeKeyFieldIndex = (activeKeyFieldIndex - 1 + keyFieldOptions.length) % keyFieldOptions.length;
      if ((event.key === 'Enter' || event.key === ' ') && activeKeyFieldIndex >= 0) {
        toggleKeyField(keyFieldOptions[activeKeyFieldIndex].name);
      } else {
        renderKeyFieldPicker();
      }
    });
    keyFieldsListbox.addEventListener('click', event => {
      const option = event.target.closest('[data-key-field]');
      if (!option) return;
      activeKeyFieldIndex = keyFieldOptions.findIndex(field => field.name === option.dataset.keyField);
      toggleKeyField(option.dataset.keyField);
      keyFieldsTrigger.focus();
    });
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
      if (!datasetId) {
        replaceFieldOptions(fieldSourceSel, [], [], '请选择字段…');
        replaceFieldOptions(validationFieldsSel, [], [], '请先选择数据集…');
        replaceFieldOptions(groupFieldsSel, [], [], '请先选择数据集…');
        setKeyFieldOptions([], []);
        sqlParameters = sqlParameters.map(parameter => ({ ...parameter, field: '' }));
        renderSqlParameters();
        fieldsPreview.innerHTML = '';
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
      replaceFieldOptions(groupFieldsSel, ds.fields, groupFields);
      setKeyFieldOptions(ds.fields, initialKeyFields);
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
            <input class="input mono" data-c="value" value="${escapeHtml(c.value ?? '')}" placeholder="阈值" ${!showValue ? 'disabled style="opacity:0.4;"' : ''} />
            <button type="button" class="row-action danger" data-remove="${idx}" aria-label="删除条件" ${conditions.length === 1 ? 'disabled style="opacity:0.3;"' : ''}>${Icon.trash({ size: 14 })}</button>
            ${c.op === 'between' ? `<input class="input mono" data-c="upper_value" value="${escapeHtml(c.upper_value ?? '')}" placeholder="上界" style="grid-column:3;" />` : ''}
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
    const groupWebhookInput = m.dialog.querySelector('#f-group-webhook');
    const groupWebhookClear = m.dialog.querySelector('#f-group-webhook-clear');
    groupWebhookClear?.addEventListener('change', () => {
      groupWebhookInput.disabled = groupWebhookClear.checked;
      if (groupWebhookClear.checked) groupWebhookInput.value = '';
    });

    // ---------- Cancel / Test / Save ----------
    m.dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => m.close());

    m.dialog.querySelector('#f-test').addEventListener('click', async () => {
      const btn = m.dialog.querySelector('#f-test');
      const original = btn.innerHTML;
      btn.innerHTML = `<span class="btn-spinner"></span>执行中…`;
      btn.disabled = true;
      try {
        if (!editing) throw new Error('请先保存规则，再执行真实检测');
        const run = await Store.executeRule(id);
        UI.toast({ type: run.new_anomalies ? 'warning' : 'success', title: '真实检测完成', desc: `扫描 ${run.scanned_rows} 行 · 新增 ${run.new_anomalies} 条` });
      } catch (error) { UI.toast({ type: 'error', title: '执行失败', desc: error.message }); }
      finally {
        btn.innerHTML = original;
        btn.disabled = false;
      }
    });

    m.dialog.querySelector('#f-save').addEventListener('click', async () => {
      const name = m.dialog.querySelector('#f-name').value.trim();
      const datasetId = m.dialog.querySelector('#f-dataset').value;
      if (!name) { UI.toast({ type: 'warning', title: '请填写规则名称' }); return; }
      if (!datasetId) { UI.toast({ type: 'warning', title: '请选择关联数据集' }); return; }

      const ds = Store.getDataset(datasetId);
      const validConditions = conditions.filter(c => c.field && c.op);
      if (validConditions.length === 0) { UI.toast({ type: 'warning', title: '请至少配置一个有效条件' }); return; }
      const anomalyKeyFields = [...selectedKeyFields];
      if (!anomalyKeyFields.length) { UI.toast({ type: 'warning', title: '请至少选择一个异常主键字段' }); return; }

      commitPendingTargets.forEach(commit => commit());
      const notificationTargets = [
        ...openIds.map(value => ({ receive_id_type: 'open_id', source: 'literal', value })),
        ...userIds.map(value => ({ receive_id_type: 'user_id', source: 'literal', value })),
        ...unionIds.map(value => ({ receive_id_type: 'union_id', source: 'literal', value })),
        ...emails.map(value => ({ receive_id_type: 'email', source: 'literal', value })),
        ...chatIds.map(value => ({ receive_id_type: 'chat_id', source: 'literal', value })),
      ];
      if (notifyMode === 'field' && m.dialog.querySelector('#f-field-source').value) notificationTargets.push({ receive_id_type: m.dialog.querySelector('#f-field-id-type').value, source: 'field', field: m.dialog.querySelector('#f-field-source').value });
      if (!notificationTargets.length) { UI.toast({ type: 'warning', title: '请至少配置一个飞书接收目标' }); return; }

      commitPendingValidationTarget();
      validationFields = [...validationFieldsSel.selectedOptions].map(option => option.value).filter(Boolean);
      const validationTargets = [
        ...validationUserIds.map(value => ({ source: 'literal', value })),
        ...validationFields.map(field => ({ source: 'field', field })),
      ];
      const validationEnabled = m.dialog.querySelector('#f-validation-enabled').checked;
      const validationTimeoutMinutes = Number(m.dialog.querySelector('#f-validation-timeout').value);
      const parseSqlOperand = raw => {
        const value = raw.trim();
        if (!value) return null;
        return /^-?(?:\d+\.?\d*|\.\d+)$/.test(value) ? Number(value) : value;
      };
      const sqlTrueOperator = m.dialog.querySelector('#f-sql-operator').value;
      const sqlValidationConfig = validationMethod === 'sql' ? {
        queryTemplate: m.dialog.querySelector('#f-validation-sql').value.trim(),
        parameters: captureSqlParameters(),
        trueCondition: {
          field: m.dialog.querySelector('#f-sql-result-field').value.trim(),
          operator: sqlTrueOperator,
          value: ['is_null', 'is_not_null'].includes(sqlTrueOperator) ? null : parseSqlOperand(m.dialog.querySelector('#f-sql-value').value),
          upperValue: sqlTrueOperator === 'between' ? parseSqlOperand(m.dialog.querySelector('#f-sql-upper-value').value) : null,
        },
      } : null;
      const validationError = m.dialog.querySelector('#f-validation-target-error');
      let validationMessage = '';
      if (!Number.isInteger(validationTimeoutMinutes) || validationTimeoutMinutes < 1 || validationTimeoutMinutes > 43200) {
        validationMessage = '超时时间必须是 1–43200 之间的整数分钟';
      } else if (validationEnabled && !validationTargets.length) {
        validationMessage = '启用实时校验时，请至少配置一个验证目标';
      } else if (validationMethod === 'sql') {
        const parameterNames = sqlValidationConfig.parameters.map(item => item.name);
        const placeholders = [...sqlValidationConfig.queryTemplate.matchAll(/\{([^{}]+)\}/g)].map(match => match[1].trim());
        const missingMappings = [...new Set(placeholders)].filter(name => !parameterNames.includes(name));
        const unusedMappings = [...new Set(parameterNames)].filter(name => !placeholders.includes(name));
        if (!sqlValidationConfig.queryTemplate) validationMessage = 'SQL 校验必须填写查询 SQL';
        else if (sqlValidationConfig.parameters.some(item => !item.name || !item.field)) validationMessage = '每个 SQL 参数都必须填写参数名并选择异常字段';
        else if (new Set(parameterNames).size !== parameterNames.length) validationMessage = 'SQL 参数名不能重复';
        else if (missingMappings.length) validationMessage = `SQL 占位符缺少参数映射：${missingMappings.join('、')}`;
        else if (unusedMappings.length) validationMessage = `SQL 参数未在查询中使用：${unusedMappings.join('、')}`;
        else if (!sqlValidationConfig.trueCondition.field) validationMessage = 'True 条件必须填写结果字段';
        else if (!['is_null', 'is_not_null'].includes(sqlTrueOperator) && sqlValidationConfig.trueCondition.value === null) validationMessage = '当前 True 条件必须填写期望值';
        else if (sqlTrueOperator === 'between' && sqlValidationConfig.trueCondition.upperValue === null) validationMessage = 'between 条件必须填写范围上界';
      }
      validationError.querySelector('span').textContent = validationMessage;
      validationError.style.display = validationMessage ? 'flex' : 'none';
      if (validationMessage) {
        m.dialog.querySelector('.validation-config').scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }

      commitPendingGroupTarget();
      groupFields = [...groupFieldsSel.selectedOptions].map(option => option.value).filter(Boolean);
      const groupBroadcastEnabled = m.dialog.querySelector('#f-group-broadcast-enabled').checked;
      const groupWebhookUrl = groupWebhookInput.value.trim();
      const clearGroupWebhook = !!groupWebhookClear?.checked;
      const groupMentionTargets = [
        ...groupUserIds.map(value => ({ source: 'literal', value })),
        ...groupFields.map(field => ({ source: 'field', field })),
      ];
      const groupBroadcastError = m.dialog.querySelector('#f-group-broadcast-error');
      let groupBroadcastMessage = '';
      if (groupBroadcastEnabled && clearGroupWebhook) {
        groupBroadcastMessage = '启用群聊播报时不能清除 webhook';
      } else if (groupBroadcastEnabled && !groupWebhookUrl && !groupBroadcast.hasWebhook) {
        groupBroadcastMessage = '启用群聊播报时必须配置 webhook';
      } else if (groupBroadcastEnabled && !groupMentionTargets.length) {
        groupBroadcastMessage = '启用群聊播报时，请至少配置一个艾特用户来源';
      }
      groupBroadcastError.querySelector('span').textContent = groupBroadcastMessage;
      groupBroadcastError.style.display = groupBroadcastMessage ? 'flex' : 'none';
      if (groupBroadcastMessage) {
        m.dialog.querySelector('.group-broadcast-config').scrollIntoView({ block: 'center', behavior: 'smooth' });
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
        notificationTargets,
        validationEnabled,
        validationTargets,
        validationTimeoutMinutes,
        validationMethod,
        sqlValidationConfig,
        groupBroadcast: {
          enabled: groupBroadcastEnabled,
          hasWebhook: clearGroupWebhook ? false : !!groupBroadcast.hasWebhook,
          ...(clearGroupWebhook
            ? { webhookUrl: null }
            : (groupWebhookUrl ? { webhookUrl: groupWebhookUrl } : {})),
          mentionTargets: groupMentionTargets,
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

      try {
        if (editing) await Store.updateRule(id, payload); else await Store.addRule(payload);
        UI.toast({ type: 'success', title: editing ? '已保存' : '已创建', desc: name });
        m.close(); renderList(); renderStats();
      } catch (error) { UI.toast({ type: 'error', title: '保存失败', desc: error.message }); }
    });

    if (data.datasetId) updateFieldsForDataset(data.datasetId, data.anomalyKeyFields || []);
    else renderConditions();
  }

  return { render, openItem: openForm };
})();
