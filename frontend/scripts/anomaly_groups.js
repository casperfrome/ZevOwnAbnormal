/* Anomaly record groups list and deep-linked detail drawer. */
window.AnomalyGroupsModule = (function () {
  const { escapeHtml, formatTime } = UI;
  let root = null;
  let options = null;
  let state = { search: '', page: 1, pageSize: 10 };

  const broadcastLabels = {
    disabled: ['neutral', '未启用'],
    pending: ['warning', '待发送'],
    in_transit: ['info', '发送中'],
    sent: ['success', '已发送'],
    partial_failed: ['danger', '部分失败'],
    failed: ['danger', '发送失败'],
    uncertain: ['warning', '结果未知'],
    aborted: ['neutral', '已中止'],
  };

  function broadcastBadge(status) {
    const [cls, label] = broadcastLabels[status] || broadcastLabels.disabled;
    return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
  }

  function statusSummary(counts = {}) {
    return [
      ['待处理', counts.pending || 0],
      ['处理中', counts.processing || 0],
      ['已超时', counts.timed_out || 0],
      ['已解决', counts.resolved || 0],
    ].map(([label, count]) => `<span class="group-status-count">${label} ${count}</span>`).join('');
  }

  async function loadList() {
    const host = root?.querySelector('#anomaly-group-table');
    if (!host) return;
    host.innerHTML = UI.loadingState(6, 5);
    try {
      const result = await Store.loadAnomalyGroupsPage(state);
      if (!root?.contains(host)) return;
      const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
      host.innerHTML = result.items.length ? `
        <div class="table-wrap">
          <table class="data-table" data-table-id="anomaly-group-list">
            <thead><tr>
              <th data-column-key="rule" data-default-width="220">规则</th>
              <th data-column-key="detected-at" data-default-width="180">检测时间</th>
              <th data-column-key="counts" data-default-width="180">扫描 / 命中 / 新增</th>
              <th data-column-key="statuses" data-default-width="330">处理状态</th>
              <th data-column-key="broadcast" data-default-width="120">群播状态</th>
            </tr></thead>
            <tbody>${result.items.map(group => `
              <tr class="clickable-row" data-group-id="${escapeHtml(group.groupId)}" tabindex="0" role="button" aria-label="查看异常记录组 ${escapeHtml(group.ruleName)}">
                <td><div class="cell-strong">${escapeHtml(group.ruleName)}</div><div class="cell-muted text-mono">${escapeHtml(group.groupId)}</div></td>
                <td class="cell-muted text-mono">${escapeHtml(formatTime(group.detectedAt))}</td>
                <td><span class="text-mono">${group.scannedRows} / ${group.matchedRows} / ${group.newAnomalies}</span></td>
                <td><div class="group-status-summary">${statusSummary(group.statusCounts)}</div></td>
                <td>${broadcastBadge(group.broadcastStatus)}</td>
              </tr>
            `).join('')}</tbody>
          </table>
        </div>
        ${UI.renderPagination(result.page, totalPages, result.total, result.pageSize)}
      ` : UI.emptyState({
        icon: Icon.layers({ size: 24 }), title: state.search ? '没有匹配的异常记录组' : '还没有异常记录组',
        desc: state.search ? '尝试调整搜索关键词' : '规则成功执行后会在这里生成检测分组',
      });
      host.querySelectorAll('[data-group-id]').forEach(row => {
        const open = () => openDetail(row.dataset.groupId);
        row.addEventListener('click', open);
        row.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
        });
      });
      host.querySelectorAll('.page-btn[data-page]').forEach(button => button.addEventListener('click', () => {
        state.page = Number(button.dataset.page);
        loadList();
      }));
    } catch (error) {
      host.innerHTML = UI.emptyState({
        icon: Icon.alert({ size: 24 }), iconCls: 'danger', title: '异常记录组加载失败', desc: error.message,
      });
    }
  }

  async function openDetail(groupId, page = 1) {
    let result;
    try {
      result = await Store.loadAnomalyGroup(groupId, { page, pageSize: 20 });
    } catch (error) {
      UI.toast({ type: 'error', title: '异常记录组详情加载失败', desc: error.message });
      return;
    }
    const group = result.group;
    const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
    const drawer = UI.drawer({
      title: `异常记录组 · ${group.ruleName}`,
      subtitle: `${formatTime(group.detectedAt)} · ${group.groupId}`,
      size: 'lg',
      body: `
        <div class="detail-grid anomaly-group-overview">
          <div class="detail-label">扫描 / 命中 / 新增</div><div class="detail-value text-mono">${group.scannedRows} / ${group.matchedRows} / ${group.newAnomalies}</div>
          <div class="detail-label">处理状态</div><div class="detail-value"><div class="group-status-summary">${statusSummary(group.statusCounts)}</div></div>
          <div class="detail-label">群播状态</div><div class="detail-value">${broadcastBadge(group.broadcastStatus)}</div>
        </div>
        <div class="section" style="box-shadow:none;border:1px solid var(--color-line);margin-top:var(--space-4);">
          <div class="section-header"><div class="section-title">${Icon.list({ size: 14 })} 组内异常记录</div></div>
          <div class="section-body">
            ${result.items.length ? `
              <div class="results-wrap"><table class="results-table" data-table-id="anomaly-group-members">
                <thead><tr>
                  <th data-column-key="business-key" data-default-width="260">业务主键</th>
                  <th data-column-key="status" data-default-width="120">处理状态</th>
                  <th data-column-key="severity" data-default-width="120">严重程度</th>
                  <th data-column-key="action" data-default-width="120">明细</th>
                </tr></thead>
                <tbody>${result.items.map(record => `
                  <tr>
                    <td class="text-mono">${escapeHtml(JSON.stringify(record.businessKey || {}))}</td>
                    <td>${UI.recordStatusBadge(record.status)}</td>
                    <td>${UI.severityBadge(record.severity)}</td>
                    <td><a class="btn btn-ghost btn-sm group-record-link" href="#records/${encodeURIComponent(record.id)}" data-record-id="${escapeHtml(record.id)}">查看明细</a></td>
                  </tr>
                `).join('')}</tbody>
              </table></div>
              ${UI.renderPagination(result.page, totalPages, result.total, result.pageSize)}
            ` : UI.emptyState({ icon: Icon.check({ size: 22 }), title: '本次未检测到异常', desc: '该检测批次没有命中记录' })}
          </div>
        </div>
      `,
      footer: '<button class="btn btn-ghost" data-action="close">关闭</button>',
    });
    drawer.drawer.querySelector('[data-action="close"]').addEventListener('click', drawer.close);
    drawer.drawer.querySelectorAll('.group-record-link').forEach(link => link.addEventListener('click', event => {
      event.preventDefault();
      const recordId = link.dataset.recordId;
      drawer.close();
      options?.navigate(`records/${recordId}`);
    }));
    drawer.drawer.querySelectorAll('.page-btn[data-page]').forEach(button => button.addEventListener('click', () => {
      drawer.close();
      openDetail(groupId, Number(button.dataset.page));
    }));
  }

  function render(content, opts) {
    root = content;
    options = opts;
    state = { search: '', page: 1, pageSize: 10 };
    content.innerHTML = `
      <div class="toolbar animate-rise">
        <div class="toolbar-search"><span class="search-icon">${Icon.search({ size: 16 })}</span><input id="ag-search" type="search" aria-label="搜索异常记录组" placeholder="搜索规则名称…" /></div>
      </div>
      <div id="anomaly-group-table"></div>
    `;
    let timer = null;
    content.querySelector('#ag-search').addEventListener('input', event => {
      clearTimeout(timer);
      timer = setTimeout(() => { state.search = event.target.value.trim(); state.page = 1; loadList(); }, 180);
    });
    loadList();
  }

  return { render, openDetail };
})();
