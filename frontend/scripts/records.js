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
    highTotal: null, highCountSequence: 0, highCountFailed: false,
  };
  let pageRoot = null;
  const ownsPage = root => root?.isConnected && root === pageRoot;
  let exporting = false;

  function renderActions(actionsEl) {
    const canAbort = typeof Store.isSuperuser === 'function' && Store.isSuperuser();
    actionsEl.classList.add('record-actions');
    actionsEl.innerHTML = `
      ${canAbort ? `<button class="btn btn-secondary btn-sm" id="rec-recover-push">${Icon.refresh({ size: 14 })}<span>恢复失败推送</span></button>` : ''}
      ${canAbort ? `<button class="btn btn-danger-ghost btn-sm" id="rec-abort-push">${Icon.pause({ size: 14 })}<span>中止推送</span></button>` : ''}
      ${canAbort ? `<button class="btn btn-danger-ghost btn-sm" id="rec-clear-in-transit">${Icon.check({ size: 14 })}<span>清除在途推送</span></button>` : ''}
      <button class="btn btn-secondary btn-sm" id="rec-export">${Icon.download({ size: 14 })}<span>导出</span></button>
      <button class="btn btn-secondary btn-sm" id="rec-refresh">${Icon.refresh({ size: 14 })}<span>刷新</span></button>
    `;
    actionsEl.querySelector('#rec-recover-push')?.addEventListener('click', recoverPushes);
    actionsEl.querySelector('#rec-abort-push')?.addEventListener('click', abortPushes);
    actionsEl.querySelector('#rec-clear-in-transit')?.addEventListener('click', clearInTransitPushes);
    actionsEl.querySelector('#rec-export').addEventListener('click', () => exportRecords());
    actionsEl.querySelector('#rec-refresh').addEventListener('click', async event => {
      const btn = event.currentTarget, root = pageRoot;
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        await Store.refresh();
        if (!ownsPage(root)) return;
        UI.toast({ type: 'info', title: '已刷新' }); renderList(); renderStats(); renderTabs();
      } catch (error) { if (ownsPage(root)) UI.toast({ type: 'error', title: '刷新失败', desc: error.message }); }
      finally { if (btn.isConnected) btn.disabled = false; }
    });
  }

  async function recoverPushes() {
    const button = document.getElementById('rec-recover-push');
    if (!button || button.disabled) return;
    const root = pageRoot;
    button.disabled = true;
    const confirmed = await UI.confirm({
      title: '恢复所有失败推送？',
      desc: '将先检查 Kafka 与 DolphinScheduler，只恢复可安全重试的失败任务；发送中、结果未知、已发送和已中止任务不会重发。',
      confirmText: '检查并恢复',
    });
    if (!confirmed || !ownsPage(root)) { if (button.isConnected) button.disabled = false; return; }
    const original = button.innerHTML;
    button.innerHTML = '<span class="btn-spinner"></span><span>正在恢复…</span>';
    try {
      const result = await Store.recoverAnomalyPushes();
      if (!ownsPage(root)) return;
      const kinds = result.requeued_by_kind || {};
      UI.toast({
        type: 'success',
        title: '失败推送已恢复',
        desc: `${result.requeued_jobs} 条已重排 · 通知 ${kinds.notification || 0} · 校验 ${kinds.validation || 0} · 群播 ${kinds.group_broadcast || 0} · 跳过 ${result.skipped_jobs || 0}`,
      });
      try {
        await Store.refresh();
        if (!ownsPage(root)) return;
        renderList();
        renderStats();
        renderTabs();
      } catch (refreshError) {
        if (!ownsPage(root)) return;
        UI.toast({
          type: 'warning',
          title: '推送已恢复，页面刷新失败',
          desc: refreshError.message,
        });
      }
    } catch (error) {
      if (!ownsPage(root)) return;
      const stages = (error.payload?.errors || []).map(item => item.stage).join('、');
      UI.toast({
        type: 'error',
        title: '失败推送恢复失败',
        desc: stages ? `依赖检查失败：${stages}` : error.message,
      });
    } finally {
      if (button.isConnected) { button.disabled = false; button.innerHTML = original; }
    }
  }

  async function clearInTransitPushes() {
    const button = document.getElementById('rec-clear-in-transit');
    if (!button || button.disabled) return;
    const root = pageRoot;
    button.disabled = true;
    const original = button.innerHTML;
    try {
      const confirmed = await UI.confirm({
        title: '清除所有在途推送？',
        desc: '将所有在途异常标为已解决，取消其通知、校验推送及所在记录组待发送的群聊播报，不受当前筛选、分页或勾选影响。同组其他记录状态不变；已发送消息无法撤回，正在发送的请求不再重试。',
        confirmText: '清除在途推送',
        danger: true,
      });
      if (!confirmed || !ownsPage(root)) { if (button.isConnected) button.disabled = false; return; }
      button.innerHTML = '<span class="btn-spinner"></span><span>正在清除…</span>';
      const result = await Store.clearInTransitPushes();
      if (!ownsPage(root)) return;
      state.selected.clear();
      state.page = 1;
      UI.toast({
        type: 'success', title: '在途推送已清除',
        desc: `已解决 ${result.resolved_records} 条异常 · 已取消 ${result.cancelled_jobs} 条推送任务`,
      });
      try {
        await Store.refresh();
        if (!ownsPage(root)) return;
        await renderList({ throwOnError: true });
        if (!ownsPage(root)) return;
        renderStats();
        renderTabs();
      } catch (refreshError) {
        if (!ownsPage(root)) return;
        UI.toast({ type: 'warning', title: '在途推送已清除，页面刷新失败', desc: refreshError.message });
      }
    } catch (error) {
      if (!ownsPage(root)) return;
      UI.toast({ type: 'error', title: '清除在途推送失败', desc: error.message });
    } finally {
      if (button.isConnected) { button.disabled = false; button.innerHTML = original; }
    }
  }

  async function abortPushes() {
    const button = document.getElementById('rec-abort-push');
    if (!button || button.disabled) return;
    const root = pageRoot;
    button.disabled = true;
    const confirmed = await UI.confirm({
      title: '中止所有待推送异常？',
      desc: '将清除 Kafka 与 DolphinScheduler 中尚未发送的积压；不会删除异常记录，已发送消息无法撤回。',
      confirmText: '中止推送',
      danger: true,
    });
    if (!confirmed || !ownsPage(root)) { if (button.isConnected) button.disabled = false; return; }
    const original = button.innerHTML;
    button.innerHTML = '<span class="btn-spinner"></span><span>正在中止…</span>';
    try {
      const result = await Store.abortAnomalyPushes();
      if (!ownsPage(root)) return;
      UI.toast({
        type: 'success',
        title: '推送积压已中止',
        desc: `${result.aborted_jobs} 条任务 · ${result.deleted_ds_instances} 个调度实例 · ${result.cleared_kafka_partitions} 个 Kafka 分区`,
      });
      try {
        await Store.refresh();
        if (!ownsPage(root)) return;
        renderList(); renderStats(); renderTabs();
      } catch (error) {
        if (ownsPage(root)) UI.toast({ type: 'warning', title: '推送已中止，页面刷新失败', desc: error.message });
      }
    } catch (error) {
      if (!ownsPage(root)) return;
      const stages = (error.payload?.errors || []).map(item => item.stage).join('、');
      UI.toast({
        type: 'error',
        title: '中止推送未完全完成',
        desc: stages ? `未完成阶段：${stages}，可重试` : error.message,
      });
    } finally {
      if (button.isConnected) { button.disabled = false; button.innerHTML = original; }
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
    pageRoot = contentEl.querySelector('#rec-stats');
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
      highAnomalies: records.filter(r => r.severity === 'high' && r.status !== 'resolved').length,
    };
    const overview = typeof Store.getStats === 'function' ? Store.getStats() : {};
    return {
      ...derived,
      ...overview,
      // The overview metric is unresolved-only. Without a server count, keep the
      // severity card aligned with its all-status list by deriving from local data.
      highAnomalies: typeof Store.peekRecordsPage === 'function'
        ? overview.highAnomalies
        : derived.highAnomalies,
    };
  }

  function renderStats({ refreshHigh = true } = {}) {
    const statsEl = document.getElementById('rec-stats');
    if (!statsEl) return;
    const counts = recordCounts();
    const pending = counts.pendingRecords;
    const processing = counts.processingRecords;
    const timedOut = counts.timedOutRecords;
    const resolved = counts.resolvedToday;
    const inTransit = counts.pushInTransitAnomalies ?? 0;
    const hasHighCountApi = typeof Store.peekRecordsPage === 'function';
    const high = hasHighCountApi ? state.highTotal : counts.highAnomalies;
    const highKnown = Number.isFinite(high);
    const highLabel = highKnown ? high : '—';
    const highAria = highKnown
      ? `筛选高严重程度异常，共 ${high} 条`
      : (state.highCountFailed ? '筛选高严重程度异常，数量暂不可用' : '筛选高严重程度异常，正在统计数量');

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
      <button type="button" class="stat-card stat-filter animate-rise" data-filter-severity="high" aria-label="${highAria}" aria-pressed="false" style="animation-delay:270ms;${highKnown && high > 0 ? 'border-left:3px solid var(--color-danger);' : ''}">
        <div class="stat-card-header"><span class="stat-card-label">高严重程度异常</span><div class="stat-card-icon" style="background:var(--color-danger-soft);color:var(--color-danger);">${Icon.bug({ size: 16 })}</div></div>
        <div class="stat-card-value">${highLabel}</div>
        <div class="stat-card-delta ${highKnown && high > 0 ? 'down' : 'neutral'}">${highKnown ? (high > 0 ? '需重点关注' : '无高严重程度异常') : (state.highCountFailed ? '统计暂不可用' : '正在统计')}</div>
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

    if (refreshHigh && hasHighCountApi) {
      const countSequence = ++state.highCountSequence;
      state.highCountFailed = false;
      Store.peekRecordsPage({ severity: 'high', page: 1, pageSize: 1 })
        .then(result => {
          if (countSequence !== state.highCountSequence) return;
          state.highTotal = result.total;
          updateHighStatCard();
        })
        .catch(() => {
          if (countSequence !== state.highCountSequence) return;
          state.highTotal = null;
          state.highCountFailed = true;
          updateHighStatCard();
        });
    }
  }

  function updateHighStatCard() {
    const card = document.querySelector('#rec-stats [data-filter-severity="high"]');
    if (!card) return;
    const high = state.highTotal;
    const highKnown = Number.isFinite(high);
    card.setAttribute('aria-label', highKnown
      ? `筛选高严重程度异常，共 ${high} 条`
      : (state.highCountFailed ? '筛选高严重程度异常，数量暂不可用' : '筛选高严重程度异常，正在统计数量'));
    card.style.borderLeft = highKnown && high > 0 ? '3px solid var(--color-danger)' : '';
    card.querySelector('.stat-card-value').textContent = highKnown ? high : '—';
    const delta = card.querySelector('.stat-card-delta');
    delta.classList.toggle('down', highKnown && high > 0);
    delta.classList.toggle('neutral', !highKnown || high <= 0);
    delta.textContent = highKnown
      ? (high > 0 ? '需重点关注' : '无高严重程度异常')
      : (state.highCountFailed ? '统计暂不可用' : '正在统计');
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
        const order = { high: 3, medium: 2, low: 1 };
        return ((order[a.severity] || 0) - (order[b.severity] || 0)) * dir;
      }
      return 0;
    });
    return list;
  }

  async function renderList({ throwOnError = false } = {}) {
    const tableEl = document.getElementById('rec-table');
    if (!tableEl) return;
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
        if (requestSequence !== state.requestSequence || !tableEl.isConnected) return;
        all = result.items;
        total = result.total;
        pageItems = all;
      } catch (error) {
        if (requestSequence !== state.requestSequence || !tableEl.isConnected) return;
        state.total = 0;
        tableEl.innerHTML = UI.emptyState({
          icon: Icon.alert({ size: 24 }), iconCls: 'danger', title: '异常记录加载失败', desc: error.message,
        });
        if (throwOnError) throw error;
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
      return renderList({ throwOnError });
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
              <th data-column-key="status" data-default-width="112">状态</th>
              <th class="sortable" data-sort="occurredAt" data-column-key="occurred-at" data-default-width="170"><span class="th-sort">发生时间 ${sortIcon('occurredAt')}</span></th>
              <th data-column-key="assignee" data-default-width="90">处理人</th>
              <th data-column-key="actions" data-min-width="110" data-default-width="110" style="text-align:right;">操作</th>
            </tr>
          </thead>
          <tbody>
            ${pageItems.map((r, i) => `
              <tr class="animate-fade" style="animation-delay:${i * 25}ms;${r.severity === 'high' && r.status !== 'resolved' ? 'background: rgba(220, 38, 38, 0.025);' : ''}">
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
        if (action === 'export') { await exportRecords(selectedIds); return; }
        if (btn.disabled) return;
        const root = pageRoot;
        btn.disabled = true;
        try {
          const result = await Store.bulkUpdateRecords(selectedIds, action);
          if (!ownsPage(root)) return;
          UI.toast({ type: 'success', title: '已批量更新', desc: `${selectedIds.length} 条记录 → ${action === 'resolved' ? '已解决' : '处理中'}` });
          if (result?.refreshWarning) UI.toast({ type: 'warning', title: '已更新，页面刷新失败', desc: result.refreshWarning });
          state.selected.clear(); renderList(); renderStats(); renderTabs();
        } catch (error) { if (ownsPage(root)) UI.toast({ type: 'error', title: '批量更新失败', desc: error.message }); }
        finally { if (btn.isConnected) btn.disabled = false; }
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
    const root = pageRoot;
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
    let updating = false;
    m.dialog.querySelectorAll('[data-status]').forEach(b => {
      b.addEventListener('click', async () => {
        if (updating || !m.dialog.isConnected) return;
        const newStatus = b.dataset.status;
        if (newStatus !== r.status) {
          updating = true;
          m.dialog.querySelectorAll('[data-status]').forEach(button => { button.disabled = true; });
          try {
            const result = await Store.updateRecord(id, { status: newStatus });
            if (!m.dialog.isConnected || !ownsPage(root)) return;
            UI.toast({ type: 'success', title: '状态已更新', desc: `${r.id} → ${({ pending: '未处理', processing: '处理中', resolved: '已解决' })[newStatus]}` });
            if (result?.refreshWarning) UI.toast({ type: 'warning', title: '状态已更新，概览刷新失败', desc: result.refreshWarning });
            renderList(); renderStats(); renderTabs();
          } catch (error) { if (m.dialog.isConnected) UI.toast({ type: 'error', title: '更新失败', desc: error.message }); }
          finally { updating = false; m.dialog.querySelectorAll('[data-status]').forEach(button => { button.disabled = false; }); }
        }
        m.close();
      });
    });
  }

  // ---------- Detail drawer ----------
  function comparisonText(condition) {
    const valueText = value => value === null || value === undefined ? 'NULL' : formatValue(value);
    const operand = upper => {
      const source = upper ? condition.upperValueSource || condition.upper_value_source : condition.valueSource || condition.value_source;
      const field = upper ? condition.upperValueField || condition.upper_value_field : condition.valueField || condition.value_field;
      const resolved = upper ? condition.resolvedUpperValue ?? condition.resolved_upper_value : condition.resolvedValue ?? condition.resolved_value;
      const literal = upper ? condition.upperValue ?? condition.upper_value : condition.value;
      return source === 'field' ? `字段 ${field || '—'}（${valueText(resolved)}）` : valueText(literal);
    };
    const operator = condition.operator || condition.op;
    return `${operatorLabel(operator)}${['is_null', 'is_not_null'].includes(operator) ? '' : ` ${operand(false)}${operator === 'between' ? ` ～ ${operand(true)}` : ''}`}`;
  }

  async function openDetail(id) {
    const root = pageRoot;
    let r;
    try { r = await Store.loadRecord(id); }
    catch (error) { UI.toast({ type: 'error', title: '详情加载失败', desc: error.message }); return; }
    if (root && !ownsPage(root)) return;
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
              <div class="detail-label">截止时间</div>
              <div class="detail-value text-mono">${escapeHtml(r.validationDeadline ? formatTime(r.validationDeadline) : (r.deadlineSecondsSnapshot != null && r.status !== 'resolved' ? '等待推送成功' : '—'))}</div>
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
                    <div class="detail-label">True 条件</div><div class="detail-value text-mono">${escapeHtml(comparisonText(r.validationSubmission.resultDetail))}</div>
                  </div>
                ` : `
                  <div class="detail-label" style="margin-top:var(--space-3);">提交内容</div>
                  <pre class="validation-submission-text">${escapeHtml(r.validationSubmission.submittedText)}</pre>
                `}
              </div>` : ''}
            ${r.lastSqlValidationResult ? `
              <div class="validation-winner last-sql-validation-result">
                <div class="eyebrow">最近 SQL 校验</div>
                <div class="detail-grid">
                  <div class="detail-label">结果</div><div class="detail-value">${escapeHtml(({ passed: '通过', failed: '未通过', error: '执行错误' })[r.lastSqlValidationResult.outcome] || r.lastSqlValidationResult.outcome)}</div>
                  <div class="detail-label">原因</div><div class="detail-value">${escapeHtml(r.lastSqlValidationResult.reason || '—')}</div>
                  <div class="detail-label">操作人 / 时间</div><div class="detail-value">${escapeHtml(r.lastSqlValidationResult.operatorUserId || '—')} · ${escapeHtml(formatTime(r.lastSqlValidationResult.checkedAt))}</div>
                  ${r.lastSqlValidationResult.resultDetail ? `
                    <div class="detail-label">结果字段 / 实际值</div><div class="detail-value text-mono">${escapeHtml(r.lastSqlValidationResult.resultDetail.field || '—')} / ${escapeHtml(formatValue(r.lastSqlValidationResult.resultDetail.actual ?? 'NULL'))}</div>
                    <div class="detail-label">True 条件</div><div class="detail-value text-mono">${escapeHtml(comparisonText(r.lastSqlValidationResult.resultDetail))}</div>
                  ` : ''}
                </div>
              </div>` : ''}
          </div>
        </div>

        <div class="section push-diagnostics" style="box-shadow:none;border:1px solid var(--color-line);margin-top:var(--space-4);">
          <div class="section-header" style="padding: var(--space-4) var(--space-5);">
            <div><div class="section-title">${Icon.activity({ size: 14 })} 推送任务诊断</div></div>
          </div>
          <div class="section-body">
            ${(r.pushJobs || []).length ? `
              <div class="results-wrap">
                <table class="results-table" data-table-id="record-push-jobs">
                  <thead><tr><th data-column-key="kind" data-default-width="110">类型</th><th data-column-key="status" data-default-width="110">状态</th><th data-column-key="attempts" data-default-width="130">发布 / 调度</th><th data-column-key="next-attempt" data-default-width="180">下次重试</th><th data-column-key="updated" data-default-width="180">更新时间</th><th data-column-key="error" data-default-width="320">最后错误</th></tr></thead>
                  <tbody>${r.pushJobs.map(job => `<tr>
                    <td>${escapeHtml(({ notification: '通知', validation: '实时校验', group_broadcast: '群播' })[job.kind] || job.kind)}</td>
                    <td>${escapeHtml(job.status)}</td>
                    <td>${job.publishAttempts} / ${job.dispatchAttempts}</td>
                    <td class="text-mono">${escapeHtml(formatTime(job.nextAttemptAt))}</td>
                    <td class="text-mono">${escapeHtml(formatTime(job.updatedAt))}</td>
                    <td>${escapeHtml(job.lastError || '—')}</td>
                  </tr>`).join('')}</tbody>
                </table>
              </div>` : '<div class="text-muted">当前异常没有持久推送任务</div>'}
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
              ${(r.matchedConditions || []).length ? `<div class="matched-condition-details">
                <div class="eyebrow mb-2">命中条件</div>
                ${r.matchedConditions.map(condition => `<div class="text-mono">${escapeHtml(condition.field)}（${escapeHtml(formatValue(condition.actual ?? 'NULL'))}） ${escapeHtml(comparisonText(condition))}</div>`).join('')}
              </div>` : ''}
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
    let updating = false;
    async function updateStatus(status) {
      if (updating || !d.drawer.isConnected) return;
      updating = true;
      const buttons = [...d.drawer.querySelectorAll('#d-mark-processing, #d-resolve')];
      buttons.forEach(button => { button.disabled = true; });
      try {
        const result = await Store.updateRecord(id, { status });
        if (!d.drawer.isConnected || (root && !ownsPage(root))) return;
        UI.toast({ type: 'success', title: status === 'resolved' ? '已标记为已解决' : '已标记为处理中', desc: r.id });
        if (result?.refreshWarning) UI.toast({ type: 'warning', title: '状态已更新，概览刷新失败', desc: result.refreshWarning });
        d.close();
        if (ownsPage(root)) { renderList(); renderStats(); renderTabs(); }
        if (status === 'resolved') await openDetail(id);
      } catch (error) { if (d.drawer.isConnected) UI.toast({ type: 'error', title: '更新失败', desc: error.message }); }
      finally { updating = false; buttons.forEach(button => { if (button.isConnected) button.disabled = false; }); }
    }
    d.drawer.querySelector('#d-mark-processing')?.addEventListener('click', () => updateStatus('processing'));
    d.drawer.querySelector('#d-resolve')?.addEventListener('click', () => updateStatus('resolved'));
  }

  async function exportRecords(ids) {
    if (exporting) return;
    const root = pageRoot;
    const buttons = [...document.querySelectorAll('#rec-export, [data-bulk="export"]')];
    exporting = true;
    buttons.forEach(button => { button.disabled = true; });
    try {
      const serverBacked = typeof Store.peekRecordsPage === 'function';
      const filters = Object.freeze({
        status: state.statusFilter === 'all' ? null : state.statusFilter,
        pushStatus: state.pushStatusFilter === 'all' ? null : state.pushStatusFilter,
        severity: state.severityFilter === 'all' ? null : state.severityFilter,
        ruleId: state.ruleFilter === 'all' ? null : state.ruleFilter,
        search: state.search,
        sortKey: state.sortKey,
        sortOrder: state.sortDir,
        ...(ids ? { ids: [...ids] } : {}),
      });
      let count;
      if (ids) count = ids.length;
      else if (serverBacked) {
        if (state.searchTimer) window.clearTimeout(state.searchTimer);
        state.searchTimer = null;
        try {
          const result = await Store.peekRecordsPage({
            ...filters, page: 1, pageSize: state.pageSize,
          });
          count = result.total;
        } catch (error) {
          if (ownsPage(root)) UI.toast({ type: 'error', title: '导出准备失败', desc: error.message });
          return;
        }
      } else {
        count = getFiltered().length;
      }
      if (!ownsPage(root)) return;
      if (count === 0) { UI.toast({ type: 'warning', title: '暂无数据可导出' }); return; }
      const url = typeof Store.exportUrl === 'function' ? Store.exportUrl(filters) : Store.exportUrl;
      if (typeof Store.downloadExport === 'function') {
        const blob = await Store.downloadExport(url);
        if (!ownsPage(root)) return;
        if (!blob?.size) { UI.toast({ type: 'warning', title: '暂无数据可导出' }); return; }
        const csv = await blob.text();
        if (!ownsPage(root)) return;
        if (!csv.includes('\n') || !csv.slice(csv.indexOf('\n') + 1).trim()) {
          UI.toast({ type: 'warning', title: '暂无数据可导出' }); return;
        }
        UI.downloadBlob(blob, 'anomalies.csv');
      } else {
        // Compatibility with embedded consumers that provide only an export URL.
        window.location.href = url;
      }
      UI.toast({ type: 'success', title: '导出已开始', desc: `${count} 条记录 · CSV 格式` });
    } catch (error) { if (ownsPage(root)) UI.toast({ type: 'error', title: '导出失败', desc: error.message }); }
    finally { exporting = false; buttons.forEach(button => { if (button.isConnected) button.disabled = false; }); }
  }

  return { render, openDetail };
})();
