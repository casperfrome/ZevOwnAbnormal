/* ============================================================
   records.js — Anomaly Records module (default landing page)
   Features: list, detail drawer, filtering, sorting, status update, export
   ============================================================ */
window.RecordsModule = (function () {
  const { escapeHtml, formatTime, operatorLabel } = UI;
  let state = {
    search: '', statusFilter: 'all', pushStatusFilter: 'all', severityFilter: 'all', ruleFilter: 'all',
    sortKey: 'occurredAt', sortDir: 'desc', page: 1, pageSize: 10,
    selected: new Set(), requestSequence: 0, searchTimer: null, total: 0,
    criticalTotal: null, criticalCountSequence: 0, criticalCountFailed: false,
  };

  function renderActions(actionsEl) {
    const canAbort = typeof Store.isSuperuser === 'function' && Store.isSuperuser();
    actionsEl.innerHTML = `
      ${canAbort ? `<button class="btn btn-danger-ghost btn-sm" id="rec-abort-push">${Icon.pause({ size: 14 })}<span>中止推送</span></button>` : ''}
      <button class="btn btn-secondary btn-sm" id="rec-export">${Icon.download({ size: 14 })}<span>导出</span></button>
      <button class="btn btn-secondary btn-sm" id="rec-refresh">${Icon.refresh({ size: 14 })}<span>刷新</span></button>
    `;
    actionsEl.querySelector('#rec-abort-push')?.addEventListener('click', abortPushes);
    actionsEl.querySelector('#rec-export').addEventListener('click', exportRecords);
    actionsEl.querySelector('#rec-refresh').addEventListener('click', async () => { try { await Store.refresh(); UI.toast({ type: 'info', title: '已刷新' }); renderList(); renderStats(); renderTabs(); } catch (error) { UI.toast({ type: 'error', title: '刷新失败', desc: error.message }); } });
  }

  async function abortPushes() {
    const button = document.getElementById('rec-abort-push');
    if (!button || button.disabled) return;
    const confirmed = await UI.confirm({
      title: '中止所有待推送异常？',
      desc: '将清除 Kafka 与 DolphinScheduler 中尚未发送的积压；不会删除异常记录，已发送消息无法撤回。',
      confirmText: '中止推送',
      danger: true,
    });
    if (!confirmed) return;
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="btn-spinner"></span><span>正在中止…</span>';
    try {
      const result = await Store.abortAnomalyPushes();
      UI.toast({
        type: 'success',
        title: '推送积压已中止',
        desc: `${result.aborted_jobs} 条任务 · ${result.deleted_ds_instances} 个调度实例 · ${result.cleared_kafka_partitions} 个 Kafka 分区`,
      });
      await Store.refresh();
      renderList();
      renderStats();
      renderTabs();
    } catch (error) {
      const stages = (error.payload?.errors || []).map(item => item.stage).join('、');
      UI.toast({
        type: 'error',
        title: '中止推送未完全完成',
        desc: stages ? `未完成阶段：${stages}，可重试` : error.message,
      });
    } finally {
      button.disabled = false;
      button.innerHTML = original;
    }
  }

  function deliveryStatusLabel(status) {
    return status === 'aborted' ? '已中止' : (status || '—');
  }

  function render(contentEl, opts) {
    renderActions(opts.actionsEl);
    contentEl.innerHTML = `
      <div class="stat-strip" id="rec-stats"></div>
      <div class="section">
        <div class="tabs" id="rec-tabs" role="tablist" aria-label="异常状态">
          <button type="button" id="rec-tab-all" role="tab" class="tab" data-status="all" aria-controls="rec-table" aria-selected="false">全部 <span class="tab-count" id="cnt-all">0</span></button>
          <button type="button" id="rec-tab-pending" role="tab" class="tab" data-status="pending" aria-controls="rec-table" aria-selected="false">未处理 <span class="tab-count" id="cnt-pending">0</span></button>
          <button type="button" id="rec-tab-processing" role="tab" class="tab" data-status="processing" aria-controls="rec-table" aria-selected="false">处理中 <span class="tab-count" id="cnt-processing">0</span></button>
          <button type="button" id="rec-tab-timed-out" role="tab" class="tab" data-status="timed_out" aria-controls="rec-table" aria-selected="false">已超时 <span class="tab-count" id="cnt-timed-out">0</span></button>
          <button type="button" id="rec-tab-resolved" role="tab" class="tab" data-status="resolved" aria-controls="rec-table" aria-selected="false">已解决 <span class="tab-count" id="cnt-resolved">0</span></button>
        </div>
        <div class="toolbar" id="rec-toolbar"></div>
        <div id="rec-table" role="tabpanel" tabindex="0" aria-labelledby="rec-tab-all"></div>
      </div>
    `;
    renderStats();
    renderTabs();
    renderToolbar();
    renderList();
  }

  function recordCounts() {
    const records = Store.getRecords();
    const derived = {
      pendingRecords: records.filter(r => r.status === 'pending').length,
      processingRecords: records.filter(r => r.status === 'processing').length,
      timedOutRecords: records.filter(r => r.status === 'timed_out').length,
      resolvedToday: records.filter(r => r.status === 'resolved').length,
      criticalAnomalies: records.filter(r => r.severity === 'critical' && r.status !== 'resolved').length,
    };
    const overview = typeof Store.getStats === 'function' ? Store.getStats() : {};
    return {
      ...derived,
      ...overview,
      // The overview metric is unresolved-only. Without a server count, keep the
      // severity card aligned with its all-status list by deriving from local data.
      criticalAnomalies: typeof Store.peekRecordsPage === 'function'
        ? overview.criticalAnomalies
        : derived.criticalAnomalies,
    };
  }

  function renderStats({ refreshCritical = true } = {}) {
    const statsEl = document.getElementById('rec-stats');
    if (!statsEl) return;
    const counts = recordCounts();
    const pending = counts.pendingRecords;
    const processing = counts.processingRecords;
    const timedOut = counts.timedOutRecords;
    const resolved = counts.resolvedToday;
    const inTransit = counts.pushInTransitAnomalies ?? 0;
    const hasCriticalCountApi = typeof Store.peekRecordsPage === 'function';
    const critical = hasCriticalCountApi ? state.criticalTotal : counts.criticalAnomalies;
    const criticalKnown = Number.isFinite(critical);
    const criticalLabel = criticalKnown ? critical : '—';
    const criticalAria = criticalKnown
      ? `筛选严重异常，共 ${critical} 条`
      : (state.criticalCountFailed ? '筛选严重异常，数量暂不可用' : '筛选严重异常，正在统计数量');

    statsEl.classList.remove('five-up');
    statsEl.classList.add('six-up');
    statsEl.innerHTML = `
      <button type="button" class="stat-card stat-filter animate-rise" data-filter-status="pending" aria-label="筛选未处理异常，共 ${pending} 条" aria-pressed="false" style="animation-delay:60ms;${pending > 0 ? 'border-left:3px solid var(--color-accent);' : ''}">
        <div class="stat-card-header"><span class="stat-card-label">未处理</span><div class="stat-card-icon" style="background:var(--color-accent-soft);color:var(--color-accent);">${Icon.alert({ size: 16 })}</div></div>
        <div class="stat-card-value">${pending}</div>
        <div class="stat-card-delta ${pending > 0 ? 'down' : 'neutral'}">${pending > 0 ? '待立即处理' : '无待办'}</div>
      </button>
      <button type="button" class="stat-card stat-filter animate-rise" data-filter-status="processing" aria-label="筛选处理中异常，共 ${processing} 条" aria-pressed="false" style="animation-delay:120ms;">
        <div class="stat-card-header"><span class="stat-card-label">处理中</span><div class="stat-card-icon" style="background:var(--color-warning-soft);color:var(--color-warning);">${Icon.clock({ size: 16 })}</div></div>
        <div class="stat-card-value">${processing}</div>
        <div class="stat-card-delta neutral">跟进中</div>
      </button>
      <button type="button" class="stat-card stat-filter animate-rise" data-filter-status="timed_out" aria-label="筛选已超时异常，共 ${timedOut} 条" aria-pressed="false" style="animation-delay:180ms;">
        <div class="stat-card-header"><span class="stat-card-label">已超时</span><div class="stat-card-icon timeout-icon">${Icon.clock({ size: 16 })}</div></div>
        <div class="stat-card-value">${timedOut}</div>
        <div class="stat-card-delta ${timedOut > 0 ? 'down' : 'neutral'}">等待人工闭环</div>
      </button>
      <button type="button" class="stat-card stat-filter animate-rise" data-filter-status="resolved" aria-label="筛选已解决异常，共 ${resolved} 条" aria-pressed="false" style="animation-delay:210ms;">
        <div class="stat-card-header"><span class="stat-card-label">已解决</span><div class="stat-card-icon" style="background:var(--color-success-soft);color:var(--color-success);">${Icon.check({ size: 16 })}</div></div>
        <div class="stat-card-value">${resolved}</div>
        <div class="stat-card-delta up">已闭环</div>
      </button>
      <button type="button" class="stat-card stat-filter animate-rise" data-filter-severity="critical" aria-label="${criticalAria}" aria-pressed="false" style="animation-delay:270ms;${criticalKnown && critical > 0 ? 'border-left:3px solid var(--color-danger);' : ''}">
        <div class="stat-card-header"><span class="stat-card-label">严重异常</span><div class="stat-card-icon" style="background:var(--color-danger-soft);color:var(--color-danger);">${Icon.bug({ size: 16 })}</div></div>
        <div class="stat-card-value">${criticalLabel}</div>
        <div class="stat-card-delta ${criticalKnown && critical > 0 ? 'down' : 'neutral'}">${criticalKnown ? (critical > 0 ? '需紧急响应' : '无严重') : (state.criticalCountFailed ? '统计暂不可用' : '正在统计')}</div>
      </button>
      <button type="button" class="stat-card stat-filter animate-rise" data-filter-push-status="in_transit" aria-label="筛选推送途中异常，共 ${inTransit} 条" aria-pressed="false" style="animation-delay:330ms;${inTransit > 0 ? 'border-left:3px solid var(--color-warning);' : ''}">
        <div class="stat-card-header"><span class="stat-card-label">推送途中</span><div class="stat-card-icon" style="background:var(--color-warning-soft);color:var(--color-warning);">${Icon.send({ size: 16 })}</div></div>
        <div class="stat-card-value">${inTransit}</div>
        <div class="stat-card-delta ${inTransit > 0 ? 'down' : 'neutral'}">${inTransit > 0 ? '等待飞书送达' : '全部送达'}</div>
      </button>
    `;

    document.querySelectorAll('#rec-stats .stat-filter').forEach(card => {
      card.addEventListener('click', () => {
        const isPushFilter = !!card.dataset.filterPushStatus;
        state.pushStatusFilter = isPushFilter ? card.dataset.filterPushStatus : 'all';
        state.statusFilter = isPushFilter ? 'all' : (card.dataset.filterStatus || 'all');
        state.severityFilter = isPushFilter ? 'all' : (card.dataset.filterSeverity || 'all');
        state.page = 1;
        state.selected.clear();
        syncFilterUi();
        renderList();
      });
    });
    syncFilterUi();

    if (refreshCritical && hasCriticalCountApi) {
      const countSequence = ++state.criticalCountSequence;
      state.criticalCountFailed = false;
      Store.peekRecordsPage({ severity: 'critical', page: 1, pageSize: 1 })
        .then(result => {
          if (countSequence !== state.criticalCountSequence) return;
          state.criticalTotal = result.total;
          updateCriticalStatCard();
        })
        .catch(() => {
          if (countSequence !== state.criticalCountSequence) return;
          state.criticalTotal = null;
          state.criticalCountFailed = true;
          updateCriticalStatCard();
        });
    }
  }

  function updateCriticalStatCard() {
    const card = document.querySelector('#rec-stats [data-filter-severity="critical"]');
    if (!card) return;
    const critical = state.criticalTotal;
    const criticalKnown = Number.isFinite(critical);
    card.setAttribute('aria-label', criticalKnown
      ? `筛选严重异常，共 ${critical} 条`
      : (state.criticalCountFailed ? '筛选严重异常，数量暂不可用' : '筛选严重异常，正在统计数量'));
    card.style.borderLeft = criticalKnown && critical > 0 ? '3px solid var(--color-danger)' : '';
    card.querySelector('.stat-card-value').textContent = criticalKnown ? critical : '—';
    const delta = card.querySelector('.stat-card-delta');
    delta.classList.toggle('down', criticalKnown && critical > 0);
    delta.classList.toggle('neutral', !criticalKnown || critical <= 0);
    delta.textContent = criticalKnown
      ? (critical > 0 ? '需紧急响应' : '无严重')
      : (state.criticalCountFailed ? '统计暂不可用' : '正在统计');
  }

  function syncFilterUi() {
    document.querySelectorAll('#rec-tabs .tab').forEach(tab => {
      const active = tab.dataset.status === state.statusFilter;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active) document.getElementById('rec-table')?.setAttribute('aria-labelledby', tab.id);
    });
    document.querySelectorAll('#rec-stats .stat-filter').forEach(card => {
      const isSeverity = !!card.dataset.filterSeverity;
      const isPush = !!card.dataset.filterPushStatus;
      const active = isPush
        ? state.pushStatusFilter === card.dataset.filterPushStatus
        : state.pushStatusFilter === 'all' && (isSeverity
          ? state.statusFilter === 'all' && state.severityFilter === card.dataset.filterSeverity
          : state.severityFilter === 'all' && state.statusFilter === card.dataset.filterStatus);
      card.classList.toggle('active', active);
      card.setAttribute('aria-pressed', String(active));
    });
    const severity = document.getElementById('rec-severity-filter');
    if (severity) severity.value = state.severityFilter;
  }

  function renderTabs() {
    const counts = recordCounts();
    document.getElementById('cnt-all').textContent = counts.pendingRecords + counts.processingRecords + counts.timedOutRecords + counts.resolvedToday;
    document.getElementById('cnt-pending').textContent = counts.pendingRecords;
    document.getElementById('cnt-processing').textContent = counts.processingRecords;
    document.getElementById('cnt-timed-out').textContent = counts.timedOutRecords;
    document.getElementById('cnt-resolved').textContent = counts.resolvedToday;
    const navCount = document.getElementById('nav-anomaly-count');
    if (navCount) {
      const unresolved = counts.unresolvedRecords ?? (counts.pendingRecords + counts.processingRecords + counts.timedOutRecords);
      navCount.textContent = unresolved;
      navCount.classList.toggle('muted', unresolved === 0);
    }

    const tabs = [...document.querySelectorAll('#rec-tabs .tab')];
    tabs.forEach((tab, index) => {
      tab.onclick = () => {
        state.statusFilter = tab.dataset.status;
        state.pushStatusFilter = 'all';
        state.page = 1;
        state.selected.clear();
        syncFilterUi();
        renderList();
      };
      tab.onkeydown = event => {
        let targetIndex = null;
        if (event.key === 'ArrowRight') targetIndex = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft') targetIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') targetIndex = 0;
        if (event.key === 'End') targetIndex = tabs.length - 1;
        if (targetIndex === null) return;
        event.preventDefault();
        tabs[targetIndex].focus();
        tabs[targetIndex].click();
      };
    });
    syncFilterUi();
  }

  function renderToolbar() {
    const rules = Store.getRules();
    document.getElementById('rec-toolbar').innerHTML = `
      <div class="toolbar-search">
        <span class="search-icon">${Icon.search({ size: 16 })}</span>
        <input type="search" placeholder="搜索规则、数据集、字段…" aria-label="搜索异常记录" id="rec-search" value="${escapeHtml(state.search)}" />
        <button type="button" class="toolbar-search-clear" aria-label="清空搜索" ${state.search ? '' : 'hidden'}>${Icon.x({ size: 14 })}</button>
      </div>
      <select class="filter-select" id="rec-severity-filter">
        <option value="all">全部严重程度</option>
        <option value="critical" ${state.severityFilter === 'critical' ? 'selected' : ''}>严重</option>
        <option value="high" ${state.severityFilter === 'high' ? 'selected' : ''}>高</option>
        <option value="medium" ${state.severityFilter === 'medium' ? 'selected' : ''}>中</option>
        <option value="low" ${state.severityFilter === 'low' ? 'selected' : ''}>低</option>
      </select>
      <select class="filter-select" id="rec-rule-filter">
        <option value="all">全部规则</option>
        ${rules.map(r => `<option value="${r.id}" ${state.ruleFilter === r.id ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}
      </select>
      <div class="toolbar-divider"></div>
      <span class="text-xs text-muted" id="rec-count-text"></span>
    `;
    document.getElementById('rec-search').addEventListener('input', (e) => {
      state.search = e.target.value;
      document.querySelector('#rec-toolbar .toolbar-search-clear').hidden = !state.search;
      state.page = 1;
      state.selected.clear();
      if (state.searchTimer) window.clearTimeout(state.searchTimer);
      state.searchTimer = window.setTimeout(() => {
        state.searchTimer = null;
        renderList();
      }, 250);
    });
    document.querySelector('#rec-toolbar .toolbar-search-clear').addEventListener('click', () => {
      const input = document.getElementById('rec-search');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    });
    document.getElementById('rec-severity-filter').addEventListener('change', (e) => { state.severityFilter = e.target.value; state.page = 1; state.selected.clear(); syncFilterUi(); renderList(); });
    document.getElementById('rec-rule-filter').addEventListener('change', (e) => { state.ruleFilter = e.target.value; state.page = 1; state.selected.clear(); renderList(); });
  }

  function getFiltered() {
    let list = Store.getRecords();
    if (state.search) {
      const q = state.search.toLowerCase();
      list = list.filter(r => r.ruleName.toLowerCase().includes(q) || (r.datasetName || '').toLowerCase().includes(q) || (r.field || '').toLowerCase().includes(q));
    }
    if (state.statusFilter !== 'all') list = list.filter(r => r.status === state.statusFilter);
    if (state.severityFilter !== 'all') list = list.filter(r => r.severity === state.severityFilter);
    if (state.ruleFilter !== 'all') list = list.filter(r => r.ruleId === state.ruleFilter);
    list.sort((a, b) => {
      const dir = state.sortDir === 'asc' ? 1 : -1;
      if (state.sortKey === 'occurredAt') return (a.occurredAt || '').localeCompare(b.occurredAt || '') * dir;
      if (state.sortKey === 'severity') {
        const order = { critical: 4, high: 3, medium: 2, low: 1 };
        return ((order[a.severity] || 0) - (order[b.severity] || 0)) * dir;
      }
      return 0;
    });
    return list;
  }

  async function renderList() {
    const tableEl = document.getElementById('rec-table');
    let all;
    let total;
    let pageItems;
    if (typeof Store.loadRecordsPage === 'function') {
      const requestSequence = ++state.requestSequence;
      try {
        const result = await Store.loadRecordsPage({
          page: state.page,
          pageSize: state.pageSize,
          status: state.statusFilter === 'all' ? null : state.statusFilter,
          pushStatus: state.pushStatusFilter === 'all' ? null : state.pushStatusFilter,
          severity: state.severityFilter === 'all' ? null : state.severityFilter,
          ruleId: state.ruleFilter === 'all' ? null : state.ruleFilter,
          search: state.search,
          sortKey: state.sortKey,
          sortOrder: state.sortDir,
        });
        if (requestSequence !== state.requestSequence) return;
        all = result.items;
        total = result.total;
        pageItems = all;
      } catch (error) {
        if (requestSequence !== state.requestSequence) return;
        state.total = 0;
        tableEl.innerHTML = UI.emptyState({
          icon: Icon.alert({ size: 24 }), iconCls: 'danger', title: '异常记录加载失败', desc: error.message,
        });
        UI.toast({ type: 'error', title: '记录加载失败', desc: error.message });
        return;
      }
    } else {
      all = getFiltered();
      total = all.length;
      pageItems = all.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
    }
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    state.total = total;
    if (state.page > totalPages) {
      state.page = totalPages;
      state.selected.clear();
      return renderList();
    }
    const selectedRecords = pageItems.filter(record => state.selected.has(record.id));
    const selectedIds = selectedRecords.map(record => record.id);

    const countText = document.getElementById('rec-count-text');
    if (countText) countText.textContent = `共 ${total} 条记录`;

    if (total === 0) {
      tableEl.innerHTML = UI.emptyState({
        icon: Icon.inbox({ size: 24 }),
        iconCls: state.statusFilter === 'resolved' ? 'primary' : 'muted',
        title: state.pushStatusFilter === 'in_transit'
          ? '当前没有推送途中的异常'
          : (state.search || state.severityFilter !== 'all' || state.ruleFilter !== 'all' ? '没有匹配的记录' : (state.statusFilter === 'resolved' ? '尚无已解决记录' : '暂无异常记录')),
        desc: state.pushStatusFilter === 'in_transit'
          ? '当前筛选条件下的异常均已完成或中止飞书投递'
          : (state.search ? '尝试调整搜索条件' : (state.statusFilter === 'all' ? '系统运行平稳，未检测到数据异常' : '当前筛选条件下没有记录')),
      });
      return;
    }

    const sortIcon = (key) => {
      if (state.sortKey !== key) return Icon.sort({ size: 12 });
      return state.sortDir === 'asc' ? Icon.arrowUp({ size: 12 }) : Icon.arrowDown({ size: 12 });
    };

    tableEl.innerHTML = `
      <div class="table-wrap record-desktop-table">
        <table class="data-table" data-table-id="records-list">
          <thead>
            <tr>
              <th data-column-key="selection" data-min-width="64" data-default-width="64" style="width:64px;"><label class="checkbox"><input type="checkbox" id="rec-select-all" ${pageItems.length > 0 && pageItems.every(r => state.selected.has(r.id)) ? 'checked' : ''} /><span class="checkbox-box">${Icon.check({ size: 12 })}</span></label></th>
              <th data-column-key="anomaly" data-default-width="180">异常</th>
              <th class="sortable" data-sort="severity" data-column-key="severity" data-default-width="100"><span class="th-sort">严重程度 ${sortIcon('severity')}</span></th>
              <th data-column-key="rule" data-default-width="180">触发规则</th>
              <th data-column-key="field-value" data-default-width="200">异常字段 / 值</th>
              <th data-column-key="status" data-default-width="90">状态</th>
              <th class="sortable" data-sort="occurredAt" data-column-key="occurred-at" data-default-width="170"><span class="th-sort">发生时间 ${sortIcon('occurredAt')}</span></th>
              <th data-column-key="assignee" data-default-width="90">处理人</th>
              <th data-column-key="actions" data-min-width="110" data-default-width="110" style="text-align:right;">操作</th>
            </tr>
          </thead>
          <tbody>
            ${pageItems.map((r, i) => `
              <tr class="animate-fade" style="animation-delay:${i * 25}ms;${r.severity === 'critical' && r.status !== 'resolved' ? 'background: rgba(220, 38, 38, 0.025);' : ''}">
                <td><label class="checkbox"><input type="checkbox" class="rec-row-check" data-id="${r.id}" ${state.selected.has(r.id) ? 'checked' : ''} /><span class="checkbox-box">${Icon.check({ size: 12 })}</span></label></td>
                <td>
                  <div class="flex items-center gap-2">
                    ${UI.severityMeter(r.severity)}
                    <div>
                      <div class="cell-strong">${escapeHtml(r.id)}</div>
                      <div class="cell-muted">${escapeHtml(r.datasetName)}</div>
                    </div>
                  </div>
                </td>
                <td>${UI.severityBadge(r.severity)}</td>
                <td>
                  <div class="cell-strong">${escapeHtml(r.ruleName)}</div>
                </td>
                <td class="record-single-line" title="${escapeHtml(`${r.field} = ${formatValue(r.value)}`)}">
                  <div class="cell-mono" style="color:var(--color-danger);font-weight:600;">${escapeHtml(r.field)} = ${escapeHtml(formatValue(r.value))}</div>
                </td>
                <td>${UI.recordStatusBadge(r.status)}</td>
                <td class="cell-muted record-single-line" title="${escapeHtml(formatTime(r.occurredAt))}">${escapeHtml(formatTime(r.occurredAt))}</td>
                <td>${r.assignee ? `<span class="cell-strong">${escapeHtml(r.assignee)}</span>` : '<span class="cell-muted">未分配</span>'}</td>
                <td>
                  <div class="cell-actions">
                    <button class="row-action" data-action="view" data-id="${r.id}" data-tooltip="查看详情" aria-label="查看">${Icon.eye({ size: 15 })}</button>
                    ${r.status !== 'resolved' ? `<button class="row-action" data-action="status" data-id="${r.id}" data-tooltip="更新状态" aria-label="状态">${Icon.check({ size: 15 })}</button>` : ''}
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div class="record-mobile-list" aria-label="异常记录摘要">
        ${pageItems.map((r, i) => `
          <button type="button" class="record-mobile-card animate-fade" data-action="view" data-id="${escapeHtml(r.id)}" style="animation-delay:${i * 25}ms;">
            <span class="record-mobile-head">
              <span class="record-mobile-severity">${UI.severityMeter(r.severity)}${UI.severityBadge(r.severity)}</span>
              ${UI.recordStatusBadge(r.status)}
            </span>
            <span class="record-mobile-title">${escapeHtml(r.ruleName)}</span>
            <span class="record-mobile-dataset">${escapeHtml(r.datasetName)} · ${escapeHtml(r.id)}</span>
            <span class="record-mobile-value">
              <span>${escapeHtml(r.field)}</span>
              <strong>${escapeHtml(formatValue(r.value))}</strong>
            </span>
            <span class="record-mobile-foot">
              <span>${Icon.clock({ size: 13 })}${escapeHtml(formatTime(r.occurredAt))}</span>
              <span>${Icon.user({ size: 13 })}${escapeHtml(r.assignee || '未分配')}</span>
              ${Icon.chevronRight({ size: 15 })}
            </span>
          </button>
        `).join('')}
      </div>
      ${selectedIds.length > 0 ? `
        <div class="table-footer desktop-only" style="background: var(--color-primary-soft); border-color: var(--color-primary-line);">
          <div class="flex items-center gap-3">
            <span class="text-sm" style="color: var(--color-primary-hover);">已选择 <strong>${selectedIds.length}</strong> 项</span>
            <button class="btn btn-ghost btn-sm" id="rec-clear-sel">取消</button>
          </div>
          <div class="flex items-center gap-2">
            ${selectedRecords.every(r => ['pending', 'processing'].includes(r.status)) && selectedRecords.some(r => r.status === 'pending') ? '<button class="btn btn-secondary btn-sm" data-bulk="processing">标记处理中</button>' : ''}
            ${selectedRecords.every(r => r.status !== 'resolved') ? '<button class="btn btn-secondary btn-sm" data-bulk="resolved">标记已解决</button>' : ''}
            <button class="btn btn-secondary btn-sm" data-bulk="export">${Icon.download({ size: 14 })}导出选中</button>
          </div>
        </div>
      ` : ''}
      <div class="record-mobile-pagination ${selectedIds.length > 0 ? 'mobile-only' : ''}">
        ${UI.renderPagination(state.page, totalPages, total, state.pageSize)}
      </div>
    `;

    // Sort
    tableEl.querySelectorAll('th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.sortKey = key; state.sortDir = 'desc'; }
        state.page = 1;
        state.selected.clear();
        renderList();
      });
    });

    // Row actions
    tableEl.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const action = btn.dataset.action;
        if (action === 'view') openDetail(id);
        else if (action === 'status') openStatusMenu(id, btn);
      });
    });

    // Selection
    tableEl.querySelector('#rec-select-all')?.addEventListener('change', (e) => {
      if (e.target.checked) pageItems.forEach(r => state.selected.add(r.id));
      else pageItems.forEach(r => state.selected.delete(r.id));
      renderList();
    });
    tableEl.querySelectorAll('.rec-row-check').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) state.selected.add(cb.dataset.id);
        else state.selected.delete(cb.dataset.id);
        renderList();
      });
    });
    tableEl.querySelector('#rec-clear-sel')?.addEventListener('click', () => { state.selected.clear(); renderList(); });
    tableEl.querySelectorAll('[data-bulk]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.bulk;
        if (action === 'export') { UI.toast({ type: 'success', title: '导出已开始', desc: `${selectedIds.length} 条记录 · CSV` }); return; }
        try {
          await Store.bulkUpdateRecords(selectedIds, action);
          UI.toast({ type: 'success', title: '已批量更新', desc: `${selectedIds.length} 条记录 → ${action === 'resolved' ? '已解决' : '处理中'}` });
          state.selected.clear(); renderList(); renderStats(); renderTabs();
        } catch (error) { UI.toast({ type: 'error', title: '批量更新失败', desc: error.message }); }
      });
    });

    // Pagination
    tableEl.querySelectorAll('.page-btn[data-page]').forEach(btn => {
      btn.addEventListener('click', () => { state.page = parseInt(btn.dataset.page); state.selected.clear(); renderList(); });
    });
  }

  function formatValue(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') {
      if (Number.isInteger(v)) return UI.formatNumber(v);
      return v.toFixed(4);
    }
    return String(v);
  }

  // ---------- Status quick menu ----------
  function openStatusMenu(id, btn) {
    const r = Store.getRecord(id);
    if (!r) return;
    const m = UI.modal({
      title: '更新处理状态',
      subtitle: `${r.id} · ${r.ruleName}`,
      body: `
        <div class="flex flex-col gap-2">
          ${(r.status === 'timed_out' ? ['resolved'] : ['pending', 'processing', 'resolved']).map(s => {
            const labels = { pending: '未处理', processing: '处理中', resolved: '已解决' };
            const icons = { pending: Icon.alert({ size: 16 }), processing: Icon.clock({ size: 16 }), resolved: Icon.check({ size: 16 }) };
            const colors = { pending: 'accent', processing: 'warning', resolved: 'success' };
            return `<button class="radio-card ${r.status === s ? 'selected' : ''}" data-status="${s}" style="text-align:left;">
              <div class="radio-card-icon" style="background: var(--color-${colors[s]}-soft); color: var(--color-${colors[s]});">${icons[s]}</div>
              <div class="radio-card-text"><div class="radio-card-title">${labels[s]}</div></div>
              ${r.status === s ? '<span class="badge success" style="margin-left:auto;">当前</span>' : ''}
            </button>`;
          }).join('')}
        </div>
      `,
      footer: `<button class="btn btn-ghost" data-action="cancel">取消</button>`,
    });
    m.dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => m.close());
    m.dialog.querySelectorAll('[data-status]').forEach(b => {
      b.addEventListener('click', async () => {
        const newStatus = b.dataset.status;
        if (newStatus !== r.status) {
          try {
            await Store.updateRecord(id, { status: newStatus });
            UI.toast({ type: 'success', title: '状态已更新', desc: `${r.id} → ${({ pending: '未处理', processing: '处理中', resolved: '已解决' })[newStatus]}` });
            renderList(); renderStats(); renderTabs();
          } catch (error) { UI.toast({ type: 'error', title: '更新失败', desc: error.message }); }
        }
        m.close();
      });
    });
  }

  // ---------- Detail drawer ----------
  async function openDetail(id) {
    let r;
    try { r = await Store.loadRecord(id); }
    catch (error) { UI.toast({ type: 'error', title: '详情加载失败', desc: error.message }); return; }
    const rule = Store.getRule(r.ruleId);

    const d = UI.drawer({
      title: `异常详情 · ${r.id}`,
      subtitle: `${r.ruleName} · ${formatTime(r.occurredAt)}`,
      size: 'lg',
      body: `
        <div class="flex items-center gap-2 mb-4">
          ${UI.severityBadge(r.severity)}
          ${UI.recordStatusBadge(r.status)}
          ${r.assignee ? `<span class="badge neutral"><span class="badge-dot"></span>${escapeHtml(r.assignee)}</span>` : ''}
        </div>

        <div class="section" style="box-shadow:none;border:1px solid var(--color-line);">
          <div class="section-header" style="padding: var(--space-4) var(--space-5);">
            <div>
              <div class="section-title">${Icon.info({ size: 14 })} 基本信息</div>
            </div>
          </div>
          <div class="section-body">
            <div class="detail-grid">
              <div class="detail-label">记录 ID</div>
              <div class="detail-value text-mono">${escapeHtml(r.id)}</div>
              <div class="detail-label">触发规则</div>
              <div class="detail-value">${escapeHtml(r.ruleName)}${rule ? ` <button class="btn btn-ghost btn-sm" id="goto-rule" data-id="${rule.id}" style="margin-left:8px;padding:0 8px;height:24px;">查看规则 ${Icon.arrowRight({ size: 12 })}</button>` : ''}</div>
              <div class="detail-label">数据集</div>
              <div class="detail-value">${escapeHtml(r.datasetName)}</div>
              <div class="detail-label">发生时间</div>
              <div class="detail-value text-mono">${escapeHtml(formatTime(r.occurredAt))}</div>
              <div class="detail-label">处理人</div>
              <div class="detail-value">${r.assignee ? escapeHtml(r.assignee) : '<span class="text-muted">未分配</span>'}</div>
              <div class="detail-label">异常描述</div>
              <div class="detail-value">${r.description ? escapeHtml(r.description) : '<span class="text-muted">—</span>'}</div>
              <div class="detail-label">校验截止时间</div>
              <div class="detail-value text-mono">${escapeHtml(formatTime(r.validationDeadline))}</div>
              <div class="detail-label">校验方式</div>
              <div class="detail-value">${r.validationMethod === 'sql' ? 'SQL 校验' : r.validationMethod === 'pseudo' ? '伪校验' : '—'}</div>
              <div class="detail-label">超时时间</div>
              <div class="detail-value text-mono">${escapeHtml(formatTime(r.timedOutAt))}</div>
              <div class="detail-label">解决来源</div>
              <div class="detail-value text-mono">${escapeHtml(r.resolutionSource || '—')}</div>
              <div class="detail-label">解决人 user_id</div>
              <div class="detail-value text-mono">${escapeHtml(r.resolvedByUserId || '—')}</div>
            </div>
          </div>
        </div>

        <div class="section validation-audit" style="box-shadow:none;border:1px solid var(--color-line);margin-top:var(--space-4);">
          <div class="section-header" style="padding: var(--space-4) var(--space-5);">
            <div><div class="section-title">${Icon.shield({ size: 14 })} 实时校验审计</div></div>
          </div>
          <div class="section-body">
            ${(r.validationRequests || []).length ? `
              <div class="eyebrow mb-2">请求投递与关闭状态</div>
              <div class="results-wrap validation-request-table">
                <table class="results-table" data-table-id="record-validation-requests">
                  <thead><tr><th data-column-key="recipient" data-default-width="180">验证人 user_id</th><th data-column-key="status" data-default-width="100">状态</th><th data-column-key="attempts" data-default-width="80">尝试</th><th data-column-key="delivered-at" data-default-width="180">送达时间</th><th data-column-key="message" data-default-width="240">message_id / 错误</th></tr></thead>
                  <tbody>${r.validationRequests.map(item => `<tr>
                    <td class="text-mono">${escapeHtml(item.recipientUserId)}</td>
                    <td>${escapeHtml(deliveryStatusLabel(item.deliveryStatus))}</td>
                    <td>${item.deliveryAttempts}</td>
                    <td class="text-mono">${escapeHtml(formatTime(item.deliveredAt))}</td>
                    <td>${escapeHtml(item.messageId || item.lastError || '—')}</td>
                  </tr>`).join('')}</tbody>
                </table>
              </div>` : '<div class="text-muted">当前异常没有实时校验请求</div>'}
            ${r.validationSubmission ? `
              <div class="validation-winner">
                <div class="eyebrow">生效提交</div>
                <div class="detail-grid">
                  <div class="detail-label">提交人 user_id</div><div class="detail-value text-mono">${escapeHtml(r.validationSubmission.submittedByUserId)}</div>
                  <div class="detail-label">提交时间</div><div class="detail-value text-mono">${escapeHtml(formatTime(r.validationSubmission.submittedAt))}</div>
                  <div class="detail-label">验证类型 / 结果</div><div class="detail-value text-mono">${escapeHtml(r.validationSubmission.validatorType)} / ${escapeHtml(r.validationSubmission.result)}</div>
                </div>
                ${r.validationSubmission.validatorType === 'sql' && r.validationSubmission.resultDetail ? `
                  <div class="detail-label" style="margin-top:var(--space-3);">SQL 校验结果</div>
                  <div class="detail-grid sql-validation-result">
                    <div class="detail-label">结果字段</div><div class="detail-value text-mono">${escapeHtml(r.validationSubmission.resultDetail.field || '—')}</div>
                    <div class="detail-label">实际值</div><div class="detail-value text-mono">${escapeHtml(r.validationSubmission.resultDetail.actual ?? 'NULL')}</div>
                    <div class="detail-label">True 条件</div><div class="detail-value text-mono">${escapeHtml(`${operatorLabel(r.validationSubmission.resultDetail.operator)} ${r.validationSubmission.resultDetail.value ?? ''}${r.validationSubmission.resultDetail.upperValue !== null && r.validationSubmission.resultDetail.upperValue !== undefined ? `, ${r.validationSubmission.resultDetail.upperValue}` : ''}`.trim())}</div>
                  </div>
                ` : `
                  <div class="detail-label" style="margin-top:var(--space-3);">提交内容</div>
                  <pre class="validation-submission-text">${escapeHtml(r.validationSubmission.submittedText)}</pre>
                `}
              </div>` : ''}
          </div>
        </div>

        <div class="section" style="box-shadow:none;border:1px solid var(--color-line);margin-top:var(--space-4);">
          <div class="section-header" style="padding: var(--space-4) var(--space-5);">
            <div><div class="section-title">${Icon.alert({ size: 14 })} 异常数据</div></div>
          </div>
          <div class="section-body">
            <div class="diff-row">
              <div>
                <div class="cell-muted" style="font-family:var(--font-body);font-size:11px;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;">异常字段</div>
                <div class="diff-field">${escapeHtml(r.field)}</div>
              </div>
              <div class="diff-arrow">${Icon.arrowRight({ size: 14 })}</div>
              <div>
                <div class="cell-muted" style="font-family:var(--font-body);font-size:11px;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;">实际值</div>
                <div><span class="diff-value-actual">${escapeHtml(formatValue(r.value))}</span></div>
              </div>
            </div>
            <div style="margin-top: var(--space-4);">
              <div class="eyebrow mb-2">完整数据明细</div>
              <div class="results-wrap">
                <table class="results-table" data-table-id="record-row-details">
                  <thead><tr><th data-column-key="field" data-default-width="200">字段</th><th data-column-key="value" data-default-width="320">值</th></tr></thead>
                  <tbody>
                    ${Object.entries(r.details || {}).map(([k, v]) => `
                      <tr><td style="font-weight:600;color:var(--color-ink);">${escapeHtml(k)}</td><td>${escapeHtml(formatValue(v))}</td></tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <div class="section" style="box-shadow:none;border:1px solid var(--color-line);margin-top:var(--space-4);">
          <div class="section-header" style="padding: var(--space-4) var(--space-5);">
            <div><div class="section-title">${Icon.bell({ size: 14 })} 业务主键与通知投递</div></div>
          </div>
          <div class="section-body">
            <div class="detail-grid" style="margin-bottom:var(--space-4);">
              <div class="detail-label">业务主键</div>
              <div class="detail-value text-mono">${escapeHtml(JSON.stringify(r.businessKey || {}))}</div>
              <div class="detail-label">累计命中</div>
              <div class="detail-value">${r.hitCount} 次</div>
              <div class="detail-label">最后检出</div>
              <div class="detail-value text-mono">${escapeHtml(formatTime(r.lastSeenAt || r.occurredAt))}</div>
            </div>
            ${(r.deliveries || []).length ? `
              <div class="results-wrap">
                <table class="results-table" data-table-id="record-deliveries">
                  <thead><tr><th data-column-key="recipient-type" data-default-width="140">接收者类型</th><th data-column-key="recipient" data-default-width="180">接收者</th><th data-column-key="status" data-default-width="100">状态</th><th data-column-key="attempts" data-default-width="100">尝试次数</th><th data-column-key="message" data-default-width="260">飞书 message_id / 错误</th></tr></thead>
                  <tbody>${r.deliveries.map(item => `<tr>
                    <td>${escapeHtml(item.receive_id_type)}</td>
                    <td class="text-mono">${escapeHtml(item.recipient)}</td>
                    <td>${escapeHtml(deliveryStatusLabel(item.status))}</td>
                    <td>${item.attempts || 0}</td>
                    <td>${escapeHtml(item.message_id || item.last_error || '—')}</td>
                  </tr>`).join('')}</tbody>
                </table>
              </div>` : '<div class="text-muted">当前异常没有通知投递项</div>'}
          </div>
        </div>

        <div class="section" style="box-shadow:none;border:1px solid var(--color-line);margin-top:var(--space-4);">
          <div class="section-header" style="padding: var(--space-4) var(--space-5);">
            <div><div class="section-title">${Icon.activity({ size: 14 })} 处理时间线</div></div>
          </div>
          <div class="section-body">
            <div class="timeline">
              ${(r.timeline || []).map(t => `
                <div class="timeline-item ${t.type === 'success' ? 'success' : t.type === 'danger' ? 'danger' : t.type === 'warning' ? 'warning' : ''}">
                  <div class="timeline-time">${escapeHtml(formatTime(t.time))}</div>
                  <div class="timeline-title">${escapeHtml(t.title)}</div>
                  ${t.desc ? `<div class="timeline-desc">${escapeHtml(t.desc)}</div>` : ''}
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      `,
      footer: `
        <button class="btn btn-ghost" id="d-close">关闭</button>
        <div style="flex:1;"></div>
        ${r.status === 'pending' ? '<button class="btn btn-secondary" id="d-mark-processing">标记处理中</button>' : ''}
        ${r.status !== 'resolved' ? `<button class="btn btn-accent" id="d-resolve">${Icon.check({ size: 16 })}标记已解决</button>` : '<span class="badge success lg">✓ 已解决</span>'}
      `,
    });

    d.drawer.querySelector('#d-close').addEventListener('click', () => d.close());
    d.drawer.querySelector('#goto-rule')?.addEventListener('click', () => {
      d.close();
      App.navigate('rules');
      setTimeout(() => UI.toast({ type: 'info', title: '已跳转至规则', desc: r.ruleName }), 300);
    });
    d.drawer.querySelector('#d-mark-processing')?.addEventListener('click', async () => {
      try {
        await Store.updateRecord(id, { status: 'processing' });
        UI.toast({ type: 'info', title: '已标记为处理中' });
        d.close();
        renderList();
        renderStats();
        renderTabs();
      } catch (error) { UI.toast({ type: 'error', title: '更新失败', desc: error.message }); }
    });
    d.drawer.querySelector('#d-resolve')?.addEventListener('click', async () => {
      try {
        await Store.updateRecord(id, { status: 'resolved' });
        UI.toast({ type: 'success', title: '已标记为已解决', desc: r.id });
        d.close();
        renderList();
        renderStats();
        renderTabs();
        await openDetail(id);
      } catch (error) { UI.toast({ type: 'error', title: '更新失败', desc: error.message }); }
    });
  }

  async function exportRecords() {
    const serverBacked = typeof Store.peekRecordsPage === 'function';
    const filters = Object.freeze({
      status: state.statusFilter === 'all' ? null : state.statusFilter,
      pushStatus: state.pushStatusFilter === 'all' ? null : state.pushStatusFilter,
      severity: state.severityFilter === 'all' ? null : state.severityFilter,
      ruleId: state.ruleFilter === 'all' ? null : state.ruleFilter,
      search: state.search,
      sortKey: state.sortKey,
      sortOrder: state.sortDir,
    });
    let count;
    if (serverBacked) {
      if (state.searchTimer) window.clearTimeout(state.searchTimer);
      state.searchTimer = null;
      try {
        const result = await Store.peekRecordsPage({
          ...filters, page: 1, pageSize: state.pageSize,
        });
        count = result.total;
      } catch (error) {
        UI.toast({ type: 'error', title: '导出准备失败', desc: error.message });
        return;
      }
    } else {
      count = getFiltered().length;
    }
    if (count === 0) { UI.toast({ type: 'warning', title: '暂无数据可导出' }); return; }
    const url = typeof Store.exportUrl === 'function' ? Store.exportUrl(filters) : Store.exportUrl;
    window.location.href = url;
    UI.toast({ type: 'success', title: '导出已开始', desc: `${count} 条记录 · CSV 格式` });
  }

  return { render, openDetail };
})();
