/* ============================================================
   overview.js — Platform overview dashboard
   ============================================================ */
window.OverviewModule = (function () {
  const { escapeHtml, formatTime } = UI;

  let selectedDays = 14;

  function render(contentEl, opts) {
    const overview = Store.getOverview?.() || {};
    selectedDays = overview.days || selectedDays;
    opts.actionsEl.innerHTML = `<button class="btn btn-secondary btn-sm" id="ov-refresh">${Icon.refresh({ size: 14 })}<span>刷新</span></button>`;
    const trend = overview.trend || [];
    const maxSpark = Math.max(1, ...trend.map(point => point.count));
    const recent = (overview.recent_anomalies || []).map(r => ({
      id: r.id, ruleName: r.rule_name, datasetName: r.dataset_name,
      occurredAt: r.first_seen_at, severity: r.severity, status: r.status,
    }));
    const topRules = (overview.top_rules || []).map(r => ({
      id: r.id, name: r.name, datasetName: r.dataset_name, anomalyCount: r.anomaly_count,
    }));

    contentEl.innerHTML = `
      <div class="stat-strip" id="ov-stats"></div>

      <div style="display:grid;grid-template-columns:2fr 1fr;gap:var(--space-6);margin-bottom:var(--space-6);" id="ov-main">
        <div class="section animate-rise" style="animation-delay:300ms;min-width:0;">
          <div class="section-header">
            <div>
              <div class="section-title">${Icon.activity({ size: 16 })} 异常趋势 · 近 ${selectedDays} 天</div>
              <div class="section-subtitle">每日首次检出异常数量 · 北京时间（UTC+8）</div>
            </div>
            <div class="segmented">
              ${[14, 30, 90].map(days => `<button data-days="${days}" class="${days === selectedDays ? 'active' : ''}">${days} 天</button>`).join('')}
            </div>
          </div>
          <div class="section-body" data-trend-scroll style="overflow-x:auto;" tabindex="0" aria-label="每日异常趋势，可横向滚动查看全部日期">
            <div style="display:flex;align-items:flex-end;gap:4px;height:180px;padding:0 8px;min-width:${trend.length * 16}px;">
              ${trend.map((point, i) => {
                const v = point.count;
                const h = (v / maxSpark) * 140;
                const isToday = i === trend.length - 1;
                return `<div style="flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:6px;">
                  <div style="font-size:10px;color:var(--color-ink-faint);font-family:var(--font-mono);">${v}</div>
                  <div style="width:100%;height:${h}px;background:${isToday ? 'var(--color-accent)' : 'var(--color-primary)'};border-radius:4px 4px 0 0;opacity:${isToday ? 1 : 0.7};min-height:0;transition:opacity 0.2s;" data-trend-date="${escapeHtml(point.date)}" data-count="${v}" title="${escapeHtml(point.date)} · ${v} 次（北京时间）"></div>
                  <div style="font-size:10px;height:12px;white-space:nowrap;color:var(--color-ink-faint);">${trend.length <= 14 || i % 7 === 0 || isToday ? escapeHtml(point.date.slice(5)) : ''}</div>
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
              <div style="font-family:var(--font-display);font-size:28px;font-weight:600;color:var(--color-ink-muted);line-height:1;">暂无数据</div>
              <div class="text-muted text-xs mt-2">尚未接入健康度指标</div>
            </div>
            <div class="divider"></div>
            <div class="flex flex-col gap-3">
              <div class="flex items-center justify-between">
                <span class="text-sm text-muted">数据源可用性</span>
                <span class="badge neutral">暂无数据</span>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-sm text-muted">规则覆盖率</span>
                <span class="badge neutral">暂无数据</span>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-sm text-muted">告警响应率</span>
                <span class="badge neutral">暂无数据</span>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-sm text-muted">平均处理时长</span>
                <span class="text-sm text-mono">暂无数据</span>
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
                      <div class="cell-muted">${escapeHtml(formatTime(r.occurredAt))} · ${escapeHtml(r.datasetName)}</div>
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
    const root = contentEl.querySelector('#ov-main');
    let pending = false;
    const refresh = async days => {
      if (pending || !root.isConnected) return;
      pending = true;
      const buttons = [opts.actionsEl.querySelector('#ov-refresh'), ...root.querySelectorAll('[data-days]')];
      buttons.forEach(button => { button.disabled = true; });
      try {
        await Store.refreshOverview(days);
        if (!root.isConnected || contentEl.querySelector('#ov-main') !== root) return;
        selectedDays = days;
        render(contentEl, opts);
      } catch (error) {
        if (root.isConnected) UI.toast({ type: 'error', title: '概览刷新失败', desc: error.message });
      } finally {
        pending = false;
        buttons.forEach(button => { if (button.isConnected) button.disabled = false; });
      }
    };
    opts.actionsEl.querySelector('#ov-refresh').addEventListener('click', () => refresh(selectedDays));
    root.querySelectorAll('[data-days]').forEach(button => button.addEventListener('click', () => refresh(Number(button.dataset.days))));

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
        <div class="stat-card-delta neutral">活跃 / 总数</div>
      </div>
      <div class="stat-card animate-rise" style="animation-delay:120ms;">
        <div class="stat-card-header"><span class="stat-card-label">待处理异常</span><div class="stat-card-icon" style="background:var(--color-accent-soft);color:var(--color-accent);">${Icon.alert({ size: 16 })}</div></div>
        <div class="stat-card-value">${stats.unresolvedRecords ?? (stats.pendingRecords + stats.processingRecords + (stats.timedOutRecords || 0))}</div>
        <div class="stat-card-delta ${(stats.pendingRecords + (stats.timedOutRecords || 0)) > 0 ? 'down' : 'neutral'}">${stats.pendingRecords} 未处理 · ${stats.processingRecords} 处理中 · ${stats.timedOutRecords || 0} 超时</div>
      </div>
      <div class="stat-card animate-rise" style="animation-delay:180ms;">
        <div class="stat-card-header"><span class="stat-card-label">数据源在线</span><div class="stat-card-icon" style="background:var(--color-success-soft);color:var(--color-success);">${Icon.database({ size: 16 })}</div></div>
        <div class="stat-card-value">${stats.onlineDatasources}<span style="font-size:14px;color:var(--color-ink-muted);font-weight:400;"> / ${stats.totalDatasources}</span></div>
        <div class="stat-card-delta neutral">在线 / 总数</div>
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
