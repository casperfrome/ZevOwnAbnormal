/* ============================================================
   components.js — Reusable UI primitives & helpers
   ============================================================ */
window.UI = (function () {
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const formatNumber = (n) => {
    if (typeof n !== 'number') return n;
    return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  };

  const formatTime = (s) => {
    if (!s) return '—';
    return s;
  };

  const OPERATOR_LABELS = {
    eq: '等于（=）',
    neq: '不等于（≠）',
    gt: '大于（>）',
    gte: '大于等于（≥）',
    lt: '小于（<）',
    lte: '小于等于（≤）',
    between: '介于',
    is_null: '为空',
    is_not_null: '不为空',
    gt_threshold_ratio: '高于基线倍数',
    lt_threshold_ratio: '低于基线倍数',
  };

  const operatorLabel = operator => OPERATOR_LABELS[operator] || '未知条件';

  // ---------- Toast ----------
  const toastContainer = () => document.getElementById('toast-container');

  function toast(opts) {
    if (typeof opts === 'string') opts = { title: opts };
    const { type = 'info', title, desc, duration = 3200 } = opts;
    const icons = {
      success: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
      error: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
      warning: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
      info: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `${icons[type] || icons.info}<div class="toast-content"><div class="toast-title">${escapeHtml(title)}</div>${desc ? `<div class="toast-desc">${escapeHtml(desc)}</div>` : ''}</div>`;
    toastContainer().appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 240);
    }, duration);
  }

  // ---------- Modal ----------
  function modal(opts) {
    const { title, subtitle, size = '', body, footer, onClose, closeOnBackdrop = true } = opts;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const dialog = document.createElement('div');
    dialog.className = `modal ${size ? 'modal-' + size : ''}`;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', title);

    dialog.innerHTML = `
      <div class="modal-header">
        <div>
          <div class="modal-title">${title}</div>
          ${subtitle ? `<div class="modal-subtitle">${subtitle}</div>` : ''}
        </div>
        <button class="modal-close" aria-label="关闭">${Icon.x()}</button>
      </div>
      <div class="modal-body"></div>
      ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
    `;

    const bodyEl = dialog.querySelector('.modal-body');
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body instanceof Node) bodyEl.appendChild(body);

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    document.body.style.overflow = 'hidden';

    const close = () => {
      backdrop.remove();
      document.body.style.overflow = '';
      if (onClose) onClose();
    };

    dialog.querySelector('.modal-close').addEventListener('click', close);
    if (closeOnBackdrop) {
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    }
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });

    return { backdrop, dialog, body: bodyEl, close };
  }

  // ---------- Confirm dialog ----------
  function confirm(opts) {
    return new Promise((resolve) => {
      let decided = false;
      const { title = '确认操作', desc, confirmText = '确认', cancelText = '取消', danger = false } = opts;
      const m = modal({
        title,
        subtitle: desc,
        size: '',
        body: '',
        footer: `
          <button class="btn btn-ghost" data-action="cancel">${cancelText}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-accent'}" data-action="confirm">${confirmText}</button>
        `,
        closeOnBackdrop: true,
        onClose: () => { if (!decided) resolve(false); },
      });
      m.dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        decided = true; resolve(false); m.close();
      });
      m.dialog.querySelector('[data-action="confirm"]').addEventListener('click', () => {
        decided = true; resolve(true); m.close();
      });
    });
  }

  // ---------- Drawer ----------
  function drawer(opts) {
    const { title, subtitle, size = '', body, footer, onClose } = opts;
    const backdrop = document.createElement('div');
    backdrop.className = 'drawer-backdrop';
    const drawerEl = document.createElement('div');
    drawerEl.className = `drawer ${size === 'lg' ? 'drawer-lg' : ''}`;
    drawerEl.setAttribute('role', 'dialog');
    drawerEl.setAttribute('aria-modal', 'true');
    drawerEl.innerHTML = `
      <div class="drawer-header">
        <div>
          <div class="modal-title">${title}</div>
          ${subtitle ? `<div class="modal-subtitle">${subtitle}</div>` : ''}
        </div>
        <button class="modal-close" aria-label="关闭">${Icon.x()}</button>
      </div>
      <div class="drawer-body"></div>
      ${footer ? `<div class="drawer-footer">${footer}</div>` : ''}
    `;
    const bodyEl = drawerEl.querySelector('.drawer-body');
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body instanceof Node) bodyEl.appendChild(body);

    backdrop.appendChild(drawerEl);
    document.body.appendChild(backdrop);
    document.body.style.overflow = 'hidden';

    const close = () => {
      backdrop.remove();
      drawerEl.remove();
      document.body.style.overflow = '';
      if (onClose) onClose();
    };
    drawerEl.querySelector('.modal-close').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });

    return { backdrop, drawer: drawerEl, body: bodyEl, close };
  }

  // ---------- Badge helpers ----------
  const statusBadge = (status) => {
    const map = {
      online:    { cls: 'success', label: '在线', dot: true },
      offline:   { cls: 'neutral', label: '离线', dot: false },
      error:     { cls: 'danger',  label: '异常', dot: true },
      checking:  { cls: 'warning', label: '检测中', dot: true },
    };
    const m = map[status] || map.offline;
    return `<span class="badge ${m.cls}">${m.dot ? '<span class="badge-dot"></span>' : ''}${m.label}</span>`;
  };

  const recordStatusBadge = (status) => {
    const map = {
      pending:    { cls: 'accent',  label: '未处理' },
      processing: { cls: 'warning', label: '处理中' },
      timed_out:  { cls: 'neutral', label: '已超时' },
      resolved:   { cls: 'success', label: '已解决' },
    };
    const m = map[status] || map.pending;
    return `<span class="badge ${m.cls}">${m.label}</span>`;
  };

  const severityBadge = (sev) => {
    const map = {
      critical: { cls: 'danger',  label: '严重' },
      high:     { cls: 'accent',  label: '高' },
      medium:   { cls: 'warning', label: '中' },
      low:      { cls: 'info',    label: '低' },
    };
    const m = map[sev] || map.medium;
    return `<span class="badge ${m.cls}">${m.label}</span>`;
  };

  const severityMeter = (sev) => {
    const levels = { critical: 4, high: 3, medium: 2, low: 1 };
    const lvl = levels[sev] || 2;
    const cls = ['low', 'low', 'med', 'high', 'high'];
    let html = '<span class="severity-meter">';
    for (let i = 1; i <= 4; i++) {
      html += `<span class="seg ${i <= lvl ? 'on ' + cls[i] : ''}"></span>`;
    }
    html += '</span>';
    return html;
  };

  const dsTypeBadge = (type) => {
    const map = {
      mysql: { label: 'MySQL', color: '#00758F' },
      starrocks: { label: 'StarRocks', color: '#5C6BC0' },
    };
    const m = map[type] || map.mysql;
    return `<span class="badge outline" style="border-color:${m.color}40;color:${m.color};"><span class="badge-dot" style="background:${m.color}"></span>${m.label}</span>`;
  };

  // ---------- Empty state ----------
  const emptyState = (opts) => {
    const { icon = Icon.inbox({ size: 24 }), iconCls = 'muted', title = '暂无数据', desc, action } = opts;
    return `
      <div class="state">
        <div class="state-icon ${iconCls}">${icon}</div>
        <div class="state-title">${title}</div>
        ${desc ? `<div class="state-desc">${desc}</div>` : ''}
        ${action || ''}
      </div>
    `;
  };

  // ---------- Loading state ----------
  const loadingState = (rows = 5, cols = 5) => {
    let rowsHtml = '';
    for (let r = 0; r < rows; r++) {
      let cells = '';
      for (let c = 0; c < cols; c++) {
        cells += `<td><div class="skeleton" style="height:14px;width:${60 + Math.random() * 40}%;"></div></td>`;
      }
      rowsHtml += `<tr>${cells}</tr>`;
    }
    return `
      <div class="table-wrap"><table class="data-table"><tbody>${rowsHtml}</tbody></table></div>
    `;
  };

  // ---------- Pagination ----------
  const renderPagination = (page, totalPages, total, pageSize) => {
    if (totalPages <= 1) return '';
    let buttons = '';
    buttons += `<button class="page-btn" ${page === 1 ? 'disabled' : ''} data-page="${page - 1}" aria-label="上一页">${Icon.chevronLeft({ size: 14 })}</button>`;
    const range = [];
    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, start + 4);
    for (let i = start; i <= end; i++) range.push(i);
    if (start > 1) { range.unshift(1); if (start > 2) range.splice(1, 0, '...'); }
    if (end < totalPages) { range.push(totalPages); if (end < totalPages - 1) range.splice(range.length - 1, 0, '...'); }
    range.forEach(p => {
      if (p === '...') buttons += `<span class="page-btn" style="cursor:default;">…</span>`;
      else buttons += `<button class="page-btn ${p === page ? 'active' : ''}" data-page="${p}">${p}</button>`;
    });
    buttons += `<button class="page-btn" ${page === totalPages ? 'disabled' : ''} data-page="${page + 1}" aria-label="下一页">${Icon.chevronRight({ size: 14 })}</button>`;
    const from = (page - 1) * pageSize + 1;
    const to = Math.min(page * pageSize, total);
    return `
      <div class="table-footer">
        <div class="table-info">显示 <strong>${from}</strong>-<strong>${to}</strong> 条，共 <strong>${total}</strong> 条</div>
        <div class="pagination">${buttons}</div>
      </div>
    `;
  };

  // ---------- Field component ----------
  const field = (label, inputHtml, opts = {}) => {
    const { required, optional, help, error } = opts;
    return `
      <div class="field">
        <label class="field-label">
          <span>${label}${required ? '<span class="field-required">*</span>' : ''}</span>
          ${optional ? '<span class="field-optional">可选</span>' : ''}
        </label>
        ${inputHtml}
        ${help ? `<div class="field-help">${help}</div>` : ''}
        ${error ? `<div class="field-error">${Icon.alert({ size: 12 })}<span>${error}</span></div>` : ''}
      </div>
    `;
  };

  // ---------- Animate-in helper ----------
  const animateRise = (el, delay = 0) => {
    el.style.opacity = '0';
    el.style.animation = `fade-rise var(--duration-slow) var(--ease-out) ${delay}ms both`;
  };

  return {
    escapeHtml, formatNumber, formatTime, operatorLabel,
    toast, modal, confirm, drawer,
    statusBadge, recordStatusBadge, severityBadge, severityMeter, dsTypeBadge,
    emptyState, loadingState, renderPagination,
    field, animateRise,
  };
})();
