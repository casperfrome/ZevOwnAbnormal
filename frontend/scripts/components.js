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
    const value = String(s).trim();
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return value;
    const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
    const normalized = value.replace(' ', 'T') + (hasOffset ? '' : 'Z');
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return value;
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date).reduce((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  };

  const TABLE_WIDTH_STORAGE_KEY = 'sentinel.table-widths.v1';
  const DEFAULT_MIN_COLUMN_WIDTH = 72;

  const readTableWidths = () => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(TABLE_WIDTH_STORAGE_KEY) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  };

  const saveColumnWidth = (tableId, columnKey, width) => {
    try {
      const widths = readTableWidths();
      widths[tableId] = { ...(widths[tableId] || {}), [columnKey]: width };
      window.localStorage.setItem(TABLE_WIDTH_STORAGE_KEY, JSON.stringify(widths));
    } catch (_) {
      // Storage can be unavailable for local files or privacy-restricted contexts.
    }
  };

  const clearColumnWidth = (tableId, columnKey) => {
    try {
      const widths = readTableWidths();
      if (!widths[tableId] || !(columnKey in widths[tableId])) return;
      delete widths[tableId][columnKey];
      if (!Object.keys(widths[tableId]).length) delete widths[tableId];
      window.localStorage.setItem(TABLE_WIDTH_STORAGE_KEY, JSON.stringify(widths));
    } catch (_) {
      // Ignore storage failures; the in-memory width reset already took effect.
    }
  };

  const initResizableTable = (table) => {
    if (!table?.dataset?.tableId || table.dataset.resizableInitialized === 'true') return;
    const headers = [...(table.tHead?.rows?.[0]?.cells || [])];
    if (!headers.length) return;
    table.dataset.resizableInitialized = 'true';
    table.classList.add('resizable-table');
    table.style.tableLayout = 'fixed';
    table.addEventListener('mouseover', event => {
      const cell = event.target.closest?.('tbody td');
      if (!cell || !table.contains(cell) || cell.hasAttribute('title') && cell.dataset.autoTitle !== '1') return;
      if (cell.scrollWidth > cell.clientWidth) {
        if (!cell.hasAttribute('title')) {
          cell.title = cell.innerText.trim();
          cell.dataset.autoTitle = '1';
        }
      } else if (cell.dataset.autoTitle === '1') {
        cell.removeAttribute('title');
        delete cell.dataset.autoTitle;
      }
    });
    const stored = readTableWidths()[table.dataset.tableId] || {};

    // The table fills its container (CSS `width: 100%`) and only falls back to
    // horizontal scrolling when the columns' combined minimum no longer fits.
    const syncTableMinWidth = () => {
      const total = headers.reduce((sum, header) => sum + parseFloat(header.style.width || '0'), 0);
      table.style.width = '';
      table.style.minWidth = total > 0 ? `${Math.round(total)}px` : '';
    };

    // When the container is wider than the column total the browser stretches
    // columns proportionally, so rendered widths differ from the specified
    // ones. Freezing the rendered widths before a drag keeps pointer deltas
    // mapped 1:1 to visual changes.
    const bakeRenderedWidths = () => {
      // Measure every column first: writing widths one at a time would re-layout
      // the table mid-loop and corrupt the remaining measurements.
      const rendered = headers.map(header => Math.round(header.getBoundingClientRect().width));
      headers.forEach((header, index) => { header.style.width = `${rendered[index]}px`; });
      syncTableMinWidth();
    };

    headers.forEach((header, index) => {
      const columnKey = header.dataset.columnKey || `column-${index}`;
      const minWidth = Math.max(40, Number(header.dataset.minWidth) || DEFAULT_MIN_COLUMN_WIDTH);
      const measuredWidth = header.getBoundingClientRect().width || Number.parseFloat(header.style.width) || 120;
      const initialWidth = Math.max(
        minWidth,
        Number(stored[columnKey]) || Number(header.dataset.defaultWidth) || measuredWidth,
      );
      header.dataset.columnKey = columnKey;
      header.style.width = `${Math.round(initialWidth)}px`;
      header.style.minWidth = `${minWidth}px`;

      const handle = document.createElement('span');
      handle.className = 'column-resize-handle';
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-label', `调整${header.textContent.trim() || `第 ${index + 1} 列`}宽度`);
      handle.setAttribute('aria-orientation', 'vertical');
      handle.title = '拖拽调整列宽 · 双击恢复默认';
      handle.tabIndex = 0;
      header.appendChild(handle);

      const applyWidth = width => {
        const nextWidth = Math.max(minWidth, Math.round(width));
        header.style.width = `${nextWidth}px`;
        syncTableMinWidth();
        return nextWidth;
      };

      const resetWidth = () => {
        const nextWidth = applyWidth(Number(header.dataset.defaultWidth) || minWidth);
        clearColumnWidth(table.dataset.tableId, columnKey);
        return nextWidth;
      };

      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        try { handle.setPointerCapture(event.pointerId); } catch (_) { /* capture is best-effort */ }
        const startX = event.clientX;
        const startWidth = header.getBoundingClientRect().width;
        document.body.classList.add('is-resizing-column');
        let currentWidth = startWidth;
        let baked = false;
        let finished = false;
        const cleanup = () => {
          if (finished) return;
          finished = true;
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', cleanup);
          document.removeEventListener('pointercancel', cleanup);
          window.removeEventListener('blur', cleanup);
          document.body.classList.remove('is-resizing-column');
          if (baked) saveColumnWidth(table.dataset.tableId, columnKey, currentWidth);
        };
        const onMove = moveEvent => {
          if (moveEvent.pointerId !== event.pointerId) return;
          if (!table.isConnected) { cleanup(); return; }
          if (!baked) { bakeRenderedWidths(); baked = true; }
          currentWidth = applyWidth(startWidth + moveEvent.clientX - startX);
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', cleanup);
        document.addEventListener('pointercancel', cleanup);
        window.addEventListener('blur', cleanup);
      });
      handle.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
      });
      handle.addEventListener('dblclick', event => {
        event.preventDefault();
        event.stopPropagation();
        resetWidth();
      });
      handle.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        bakeRenderedWidths();
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        const width = applyWidth(header.getBoundingClientRect().width + direction * (event.shiftKey ? 24 : 8));
        saveColumnWidth(table.dataset.tableId, columnKey, width);
      });
    });
    syncTableMinWidth();
  };

  const initResizableTables = (root = document) => {
    const tables = [];
    if (root?.matches?.('table[data-table-id]')) tables.push(root);
    root?.querySelectorAll?.('table[data-table-id]').forEach(table => tables.push(table));
    tables.forEach(initResizableTable);
  };

  // A body-level tooltip escapes clipped cells and local stacking contexts.
  const initTooltips = () => {
    const tooltip = document.createElement('div');
    tooltip.id = 'ui-tooltip';
    tooltip.className = 'ui-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.hidden = true;
    document.body.appendChild(tooltip);
    let anchor = null;

    const hide = () => {
      if (anchor) {
        const descriptions = (anchor.getAttribute('aria-describedby') || '').split(/\s+/)
          .filter(id => id && id !== tooltip.id);
        if (descriptions.length) anchor.setAttribute('aria-describedby', descriptions.join(' '));
        else anchor.removeAttribute('aria-describedby');
      }
      anchor = null;
      tooltip.hidden = true;
    };
    const targetOf = node => node?.closest?.('[data-tooltip]');
    const show = target => {
      if (!target || target === anchor) return;
      hide();
      const text = target.getAttribute('data-tooltip');
      if (!text?.trim()) return;
      anchor = target;
      tooltip.textContent = text;
      tooltip.hidden = false;

      const rect = anchor.getBoundingClientRect();
      const tip = tooltip.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      const margin = 8;
      const gap = 6;
      const left = rect.left + (rect.width - tip.width) / 2;
      const above = rect.top - tip.height - gap;
      const top = above >= margin ? above : rect.bottom + gap;
      tooltip.style.left = `${Math.max(margin, Math.min(left, width - tip.width - margin))}px`;
      tooltip.style.top = `${Math.max(margin, Math.min(top, height - tip.height - margin))}px`;
      const descriptions = (anchor.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      anchor.setAttribute('aria-describedby', [...new Set([...descriptions, tooltip.id])].join(' '));
    };
    const leave = event => {
      if (anchor?.contains(event.target) && !anchor.contains(event.relatedTarget)) hide();
    };
    document.addEventListener('pointerover', event => show(targetOf(event.target)));
    document.addEventListener('pointerout', leave);
    document.addEventListener('focusin', event => show(targetOf(event.target)));
    document.addEventListener('focusout', leave);
    document.addEventListener('click', hide, true);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); }, true);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    new MutationObserver(() => {
      if (anchor && !anchor.isConnected) hide();
    }).observe(document.body, { childList: true, subtree: true });
  };

  if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
    const startTableObserver = () => {
      initTooltips();
      initResizableTables(document);
      const observer = new MutationObserver(mutations => mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === 1) initResizableTables(node);
        });
      }));
      observer.observe(document.body, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startTableObserver, { once: true });
    else startTableObserver();
  }

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
      high:     { cls: 'danger',  label: '高' },
      medium:   { cls: 'warning', label: '中' },
      low:      { cls: 'info',    label: '低' },
    };
    const m = map[sev] || map.medium;
    return `<span class="badge ${m.cls}">${m.label}</span>`;
  };

  const severityMeter = (sev) => {
    const levels = { high: 3, medium: 2, low: 1 };
    const lvl = levels[sev] || 2;
    const cls = ['low', 'low', 'med', 'high'];
    let html = '<span class="severity-meter">';
    for (let i = 1; i <= 3; i++) {
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

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadCsv(rows, fields, filename) {
    const columns = fields?.length ? fields.map(field => field.name) : Object.keys(rows[0] || {});
    const cell = value => {
      let text = value == null ? '' : String(value);
      if (typeof value === 'string' && /^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = "'" + text;
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const csv = [columns.map(cell).join(','), ...rows.map(row => columns.map(key => cell(row[key])).join(','))].join('\r\n');
    downloadBlob(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }), filename);
  }

  return {
    escapeHtml, formatNumber, formatTime, operatorLabel, initResizableTables,
    toast, modal, confirm, drawer, downloadBlob, downloadCsv,
    statusBadge, recordStatusBadge, severityBadge, severityMeter, dsTypeBadge,
    emptyState, loadingState, renderPagination,
    field, animateRise,
  };
})();
