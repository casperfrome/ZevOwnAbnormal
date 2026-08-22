/* ============================================================
   rules.js — Anomaly Rule Configuration module
   Features: CRUD, condition builder, scheduling, Feishu notification
   ============================================================ */
window.RulesModule = (function () {
  const { escapeHtml } = UI;
  let state = { search: '', statusFilter: 'all', page: 1, pageSize: 8 };

  function renderActions(actionsEl) {
    actionsEl.innerHTML = `
      <button class="btn btn-secondary btn-sm" id="r-refresh">${Icon.refresh({ size: 14 })}<span>刷新</span></button>
      <button class="btn btn-accent" id="r-add">${Icon.plus({ size: 16 })}<span>新建规则</span></button>
    `;
    actionsEl.querySelector('#r-add').addEventListener('click', () => openForm());
    actionsEl.querySelector('#r-refresh').addEventListener('click', () => { UI.toast({ type: 'info', title: '已刷新' }); renderList(); });
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
    document.getElementById('r-stats').innerHTML = `
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
    `;
  }

  function renderToolbar() {
    document.getElementById('r-toolbar').innerHTML = `
      <div class="toolbar-search">
        <span class="search-icon">${Icon.search({ size: 16 })}</span>
        <input type="text" placeholder="搜索规则名称…" id="r-search" value="${escapeHtml(state.search)}" />
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
    document.getElementById('r-search').addEventListener('input', (e) => { state.search = e.target.value; state.page = 1; renderList(); });
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
        <table class="data-table">
          <thead>
            <tr>
              <th style="width:36px;"></th>
              <th>规则</th>
              <th>关联数据集</th>
              <th>严重程度</th>
              <th>调度</th>
              <th>最近执行</th>
              <th>异常次数</th>
              <th style="text-align:right;">操作</th>
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
                <td class="cell-muted">${escapeHtml(r.lastRun || '—')}</td>
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
      name: '', description: '', datasetId: '', field: '', severity: 'medium',
      conditions: [{ field: '', op: 'gt', value: '', baseline: null }],
      logic: 'AND',
      schedule: { frequency: 'day', interval: 1, time: '09:00', start: '2026-08-09', end: '' },
      enabled: true,
      notify: { type: 'feishu', openIds: [], userIds: [], fieldSource: null, mode: 'manual' },
      validationEnabled: false,
      validationTargets: [],
      validationTimeoutMinutes: 1440,
    };

    const datasets = Store.getDatasets();

    const m = UI.modal({
      title: editing ? '编辑异常规则' : '新建异常规则',
      subtitle: editing ? `修改 ${data.name}` : '配置检测条件、调度策略与通知方式',
      size: 'xl',
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
          <div class="form-grid validation-fields-grid">
            ${UI.field('超时时间（分钟）', `<input class="input mono" id="f-validation-timeout" type="number" min="1" max="43200" value="${data.validationTimeoutMinutes ?? 1440}" />`, { required: true, help: '1–43200 分钟；到期未提交将标记为已超时' })}
            ${UI.field('固定验证人 user_id', `<div class="tag-input" id="f-validation-userids"><input type="text" placeholder="输入 user_id 后回车" id="f-validation-userids-input" /></div>`, { optional: true, help: '可配置多个；保存时会自动收录尚未回车的内容' })}
            ${UI.field('数据集字段目标', `<select class="select" id="f-validation-fields" multiple size="4"><option value="">请先选择数据集…</option></select>`, { optional: true, span2: true, help: '可多选；每行从所选字段读取 user_id' })}
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
            ${UI.field('监控字段', `
              <select class="select" id="f-field">
                <option value="">请先选择数据集…</option>
              </select>
            `, { required: true })}
            ${UI.field('异常主键字段', `<select class="select" id="f-key-fields" multiple size="4"><option value="">请先选择数据集…</option></select>`, { required: true, help: '按 Ctrl 可多选；建议包含门店 ID 与日期字段' })}
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
      `,
      footer: `
        <button type="button" class="btn btn-ghost" data-action="cancel">取消</button>
        <button type="button" class="btn btn-secondary" id="f-test">${Icon.zap({ size: 16 })}模拟执行</button>
        <button type="button" class="btn btn-accent" id="f-save">${Icon.check({ size: 16 })}${editing ? '保存规则' : '创建规则'}</button>
      `,
    });

    // ---------- State within form ----------
    let conditions = data.conditions.map(c => ({ ...c }));
    let logic = data.logic;
    let notifyMode = data.notify.mode || 'manual';
    let openIds = [...(data.notify.openIds || [])];
    let userIds = [...(data.notify.userIds || [])];
    let unionIds = (data.notificationTargets || []).filter(t => t.source === 'literal' && t.receive_id_type === 'union_id').map(t => t.value);
    let emails = (data.notificationTargets || []).filter(t => t.source === 'literal' && t.receive_id_type === 'email').map(t => t.value);
    let chatIds = (data.notificationTargets || []).filter(t => t.source === 'literal' && t.receive_id_type === 'chat_id').map(t => t.value);
    let validationUserIds = (data.validationTargets || []).filter(t => t.source === 'literal').map(t => t.value);
    let validationFields = (data.validationTargets || []).filter(t => t.source === 'field').map(t => t.field);

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
    const fieldSel = m.dialog.querySelector('#f-field');
    const fieldSourceSel = m.dialog.querySelector('#f-field-source');
    const validationFieldsSel = m.dialog.querySelector('#f-validation-fields');
    const keyFieldsSel = m.dialog.querySelector('#f-key-fields');
    const fieldsPreview = m.dialog.querySelector('#dataset-fields-preview');

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

    function updateFieldsForDataset(datasetId) {
      if (!datasetId) {
        replaceFieldOptions(fieldSel, [], [], '请先选择数据集…');
        replaceFieldOptions(fieldSourceSel, [], [], '请选择字段…');
        replaceFieldOptions(validationFieldsSel, [], [], '请先选择数据集…');
        replaceFieldOptions(keyFieldsSel, [], [], '请选择字段…');
        fieldsPreview.innerHTML = '';
        return;
      }
      const ds = Store.getDataset(datasetId);
      if (!ds) return;
      replaceFieldOptions(fieldSel, ds.fields, [data.field], '请选择字段…');
      replaceFieldOptions(fieldSourceSel, ds.fields, [data.notify.fieldSource], '请选择字段…');
      replaceFieldOptions(validationFieldsSel, ds.fields, validationFields);
      replaceFieldOptions(keyFieldsSel, ds.fields, data.anomalyKeyFields || []);
      fieldsPreview.innerHTML = `
        <div class="schedule-preview" style="background:var(--color-info-soft);border-color:var(--color-info-line);color:#0369A1;margin-top:var(--space-3);">
          ${Icon.info({ size: 14 })}
          <span>数据集 <strong>${escapeHtml(ds.name)}</strong> 包含 <strong>${ds.fields.length}</strong> 个字段，预计扫描 <strong>${UI.formatNumber(ds.rowCount)}</strong> 行</span>
        </div>
      `;
      renderConditions();
    }
    datasetSel.addEventListener('change', () => updateFieldsForDataset(datasetSel.value));

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
            if (el.dataset.c === 'op') renderConditions();
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
      const field = m.dialog.querySelector('#f-field').value;
      if (!name) { UI.toast({ type: 'warning', title: '请填写规则名称' }); return; }
      if (!datasetId) { UI.toast({ type: 'warning', title: '请选择关联数据集' }); return; }
      if (!field) { UI.toast({ type: 'warning', title: '请选择监控字段' }); return; }

      const ds = Store.getDataset(datasetId);
      const validConditions = conditions.filter(c => c.field && c.op);
      if (validConditions.length === 0) { UI.toast({ type: 'warning', title: '请至少配置一个有效条件' }); return; }
      const anomalyKeyFields = [...keyFieldsSel.selectedOptions].map(option => option.value).filter(Boolean);
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
      const validationError = m.dialog.querySelector('#f-validation-target-error');
      let validationMessage = '';
      if (!Number.isInteger(validationTimeoutMinutes) || validationTimeoutMinutes < 1 || validationTimeoutMinutes > 43200) {
        validationMessage = '超时时间必须是 1–43200 之间的整数分钟';
      } else if (validationEnabled && !validationTargets.length) {
        validationMessage = '启用实时校验时，请至少配置一个验证目标';
      }
      validationError.querySelector('span').textContent = validationMessage;
      validationError.style.display = validationMessage ? 'flex' : 'none';
      if (validationMessage) {
        m.dialog.querySelector('.validation-config').scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }

      const payload = {
        name,
        description: m.dialog.querySelector('#f-desc').value.trim(),
        datasetId,
        datasetName: ds ? ds.name : '',
        field,
        severity: m.dialog.querySelector('#f-severity').value,
        enabled: editing ? editing.enabled : true,
        conditions: validConditions,
        anomalyKeyFields,
        notificationTargets,
        validationEnabled,
        validationTargets,
        validationTimeoutMinutes,
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

    if (data.datasetId) updateFieldsForDataset(data.datasetId);
    else renderConditions();
  }

  return { render };
})();
