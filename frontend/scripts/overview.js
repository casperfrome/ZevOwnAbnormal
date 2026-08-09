/* ============================================================
   overview.js — Platform overview dashboard
   ============================================================ */
window.OverviewModule = (function () {
  const { escapeHtml } = UI;

  function renderActions(actionsEl) {
    actionsEl.innerHTML = `
      <button class="btn btn-secondary btn-sm" id="ov-refresh">${Icon.refresh({ size: 14 })}<span>刷新</span></button>
    `;
    actionsEl.querySelector('#ov-refresh').addEventListener('click', () => { UI.toast({ type: 'info', title: '已刷新' }); render(); });
  }

  function render(contentEl, opts) {
    renderActions(opts.actionsEl);
    const stats = Store.getStats();
    const records = Store.getRecords();
    const rules = Store.getRules();
    const datasources = Store.getDatasources();

    // Generate 14-day sparkline data
    const sparkline = Array.from({ length: 14 }, () => Math.floor(Math.random() * 8) + 1);
    const maxSpark = Math.max(...sparkline);

    // Recent records (top 5)
    const recent = [...records].sort((a, b) => (b.occurredAt || '').localeCompare(a.occurredAt || '')).slice(0, 5);

    // Top triggering rules
    const topRules = [...rules].sort((a, b) => (b.anomalyCount || 0) - (a.anomalyCount || 0)).slice(0, 4);

    contentEl.innerHTML = `
      <div class="stat-strip" id="ov-stats"></div>

      <div style="display:grid;grid-template-columns:2fr 1fr;gap:var(--space-6);margin-bottom:var(--space-6);" id="ov-main">
        <div class="section animate-rise" style="animation-delay:300ms;">
          <div class="section-header">
            <div>
              <div class="section-title">${Icon.activity({ size: 16 })} 异常趋势 · 近 14 天</div>
              <div class="section-subtitle">每日触发异常数量</div>
            </div>
            <div class="segmented">
              <button class="active">14 天</button>
              <button>30 天</button>
              <button>90 天</button>
            </div>
          </div>
          <div class="section-body">
            <div style="display:flex;align-items:flex-end;gap:6px;height:180px;padding:0 8px;">
              ${sparkline.map((v, i) => {
                const h = (v / maxSpark) * 100;
                const isToday = i === sparkline.length - 1;
                return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;">
                  <div style="font-size:10px;color:var(--color-ink-faint);font-family:var(--font-mono);">${v}</div>
                  <div style="width:100%;height:${h}%;background:${isToday ? 'var(--color-accent)' : 'var(--color-primary)'};border-radius:4px 4px 0 0;opacity:${isToday ? 1 : 0.7};min-height:4px;transition:opacity 0.2s;" title="${v} 次"></div>
                  <div style="font-size:10px;color:var(--color-ink-faint);">${i === sparkline.length - 1 ? '今' : (i + 1) + 'd'}</div>
                </div>`;
              }).join('')}
            </div>
          </div>
        </div>

        <div class="section animate-rise" style="animation-delay:360ms;">
          <div class="section-header">
            <div><div class="section-title">${Icon.gauge({ size: 16 })} 系统健康度</div></div>
          </div>
          <div class="section-body">
            <div style="text-align:center;padding:var(--space-4) 0;">
              <div style="font-family:var(--font-display);font-size:48px;font-weight:600;color:var(--color-success);line-height:1;">87</div>
              <div class="text-muted text-xs mt-2">/ 100 · 良好</div>
              <div class="progress mt-3" style="height:8px;">
                <div class="progress-bar success" style="width:87%;"></div>
              </div>
            </div>
            <div class="divider"></div>
            <div class="flex flex-col gap-3">
              <div class="flex items-center justify-between">
                <span class="text-sm text-muted">数据源可用性</span>
                <span class="badge success">100%</span>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-sm text-muted">规则覆盖率</span>
                <span class="badge success">92%</span>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-sm text-muted">告警响应率</span>
                <span class="badge warning">78%</span>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-sm text-muted">平均处理时长</span>
                <span class="text-sm text-mono">2h 14m</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-6);">
        <div class="section animate-rise" style="animation-delay:420ms;">
          <div class="section-header">
            <div><div class="section-title">${Icon.list({ size: 16 })} 最近异常</div></div>
            <button class="btn btn-ghost btn-sm" id="ov-goto-records">查看全部 ${Icon.arrowRight({ size: 12 })}</button>
          </div>
          <div class="section-body flush" style="padding:0;">
            ${recent.length === 0 ? UI.emptyState({ icon: Icon.check({ size: 24 }), iconCls: 'primary', title: '近期无异常', desc: '系统运行平稳' }) : `
              <div class="flex flex-col">
                ${recent.map(r => `
                  <div class="flex items-center gap-3" style="padding: var(--space-3) var(--space-5);border-bottom:1px solid var(--color-line-soft);cursor:pointer;" data-record="${r.id}">
                    ${UI.severityMeter(r.severity)}
                    <div style="flex:1;min-width:0;">
                      <div class="cell-strong truncate">${escapeHtml(r.ruleName)}</div>
                      <div class="cell-muted">${escapeHtml(r.occurredAt)} · ${escapeHtml(r.datasetName)}</div>
                    </div>
                    ${UI.recordStatusBadge(r.status)}
                    ${Icon.chevronRight({ size: 14 })}
                  </div>
                `).join('')}
              </div>
            `}
          </div>
        </div>

        <div class="section animate-rise" style="animation-delay:480ms;">
          <div class="section-header">
            <div><div class="section-title">${Icon.zap({ size: 16 })} 触发最多的规则</div></div>
            <button class="btn btn-ghost btn-sm" id="ov-goto-rules">管理规则 ${Icon.arrowRight({ size: 12 })}</button>
          </div>
          <div class="section-body flush" style="padding:0;">
            <div class="flex flex-col">
              ${topRules.map(r => `
                <div class="flex items-center gap-3" style="padding: var(--space-3) var(--space-5);border-bottom:1px solid var(--color-line-soft);">
                  <div style="width:32px;height:32px;border-radius:var(--radius-sm);background:var(--color-surface-alt);display:grid;place-items:center;color:var(--color-ink-muted);">${Icon.shield({ size: 14 })}</div>
                  <div style="flex:1;min-width:0;">
                    <div class="cell-strong truncate">${escapeHtml(r.name)}</div>
                    <div class="cell-muted">${escapeHtml(r.datasetName)}</div>
                  </div>
                  <div style="text-align:right;">
                    <div class="text-mono" style="font-weight:600;color:${r.anomalyCount > 5 ? 'var(--color-danger)' : 'var(--color-ink)'};">${r.anomalyCount}</div>
                    <div class="cell-muted">次</div>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>
    `;

    renderStats();

    contentEl.querySelector('#ov-goto-records')?.addEventListener('click', () => App.navigate('records'));
    contentEl.querySelector('#ov-goto-rules')?.addEventListener('click', () => App.navigate('rules'));
    contentEl.querySelectorAll('[data-record]').forEach(el => {
      el.addEventListener('click', () => {
        App.navigate('records');
        setTimeout(() => {
          if (window.RecordsModule && RecordsModule.openDetail) RecordsModule.openDetail(el.dataset.record);
        }, 200);
      });
    });
  }

  function renderStats() {
    const stats = Store.getStats();
    document.getElementById('ov-stats').innerHTML = `
      <div class="stat-card animate-rise" style="animation-delay:60ms;">
        <div class="stat-card-header"><span class="stat-card-label">活跃规则</span><div class="stat-card-icon" style="background:var(--color-primary-soft);color:var(--color-primary);">${Icon.shield({ size: 16 })}</div></div>
        <div class="stat-card-value">${stats.activeRules}<span style="font-size:14px;color:var(--color-ink-muted);font-weight:400;"> / ${stats.totalRules}</span></div>
        <div class="stat-card-delta up">监控中</div>
      </div>
      <div class="stat-card animate-rise" style="animation-delay:120ms;">
        <div class="stat-card-header"><span class="stat-card-label">待处理异常</span><div class="stat-card-icon" style="background:var(--color-accent-soft);color:var(--color-accent);">${Icon.alert({ size: 16 })}</div></div>
        <div class="stat-card-value">${stats.pendingRecords + stats.processingRecords}</div>
        <div class="stat-card-delta ${stats.pendingRecords > 0 ? 'down' : 'neutral'}">${stats.pendingRecords} 未处理 · ${stats.processingRecords} 处理中</div>
      </div>
      <div class="stat-card animate-rise" style="animation-delay:180ms;">
        <div class="stat-card-header"><span class="stat-card-label">数据源在线</span><div class="stat-card-icon" style="background:var(--color-success-soft);color:var(--color-success);">${Icon.database({ size: 16 })}</div></div>
        <div class="stat-card-value">${stats.onlineDatasources}<span style="font-size:14px;color:var(--color-ink-muted);font-weight:400;"> / ${stats.totalDatasources}</span></div>
        <div class="stat-card-delta up">连接正常</div>
      </div>
      <div class="stat-card animate-rise" style="animation-delay:240ms;">
        <div class="stat-card-header"><span class="stat-card-label">已解决异常</span><div class="stat-card-icon" style="background:var(--color-info-soft);color:var(--color-info);">${Icon.check({ size: 16 })}</div></div>
        <div class="stat-card-value">${stats.resolvedToday}</div>
        <div class="stat-card-delta up">累计闭环</div>
      </div>
    `;
  }

  return { render };
})();
