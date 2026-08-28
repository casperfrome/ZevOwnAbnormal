/* ============================================================
   dataset.js — Dataset Management module
   Features: CRUD, SQL editor with syntax highlight + format + validate, results preview
   ============================================================ */
window.DatasetModule = (function () {
  const { escapeHtml, formatTime } = UI;
  let state = { search: '', datasourceFilter: 'all', page: 1, pageSize: 8 };
  let pageRoot = null;
  const ownsPage = root => root?.isConnected && root === pageRoot;
  const deletingIds = new Set();

  function syncPendingControls() {
    if (!ownsPage(pageRoot)) return;
    document.querySelectorAll('#ds-table [data-action="delete"]').forEach(button => {
      button.disabled = deletingIds.has(button.dataset.id);
    });
  }

  // ---------- SQL syntax highlighter ----------
  const KEYWORDS = new Set([
    'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
    'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'ON', 'USING',
    'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
    'DISTINCT', 'UNION', 'ALL', 'AS', 'WITH', 'RECURSIVE', 'INSERT', 'UPDATE', 'DELETE', 'INTO', 'VALUES', 'SET',
    'CREATE', 'TABLE', 'VIEW', 'INDEX', 'DROP', 'ALTER', 'ADD', 'COLUMN', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES',
    'ASC', 'DESC', 'CAST', 'CONVERT', 'INTERVAL', 'DATE', 'DATETIME', 'TIMESTAMP', 'VARCHAR', 'INT', 'BIGINT', 'DECIMAL', 'DOUBLE',
  ]);
  const FUNCTIONS = new Set([
    'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'CONCAT', 'SUBSTRING', 'TRIM', 'LOWER', 'UPPER',
    'NOW', 'CURDATE', 'CURTIME', 'DATE_FORMAT', 'DATE_SUB', 'DATE_ADD', 'UNIX_TIMESTAMP', 'FROM_UNIXTIME',
    'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD', 'OVER', 'PARTITION',
  ]);

  function highlightSql(sql) {
    if (!sql) return '';
    // Tokenize while preserving positions
    const tokens = [];
    let i = 0;
    while (i < sql.length) {
      const ch = sql[i];
      // Whitespace
      if (/\s/.test(ch)) {
        let j = i;
        while (j < sql.length && /\s/.test(sql[j])) j++;
        tokens.push({ type: 'ws', value: sql.slice(i, j) });
        i = j; continue;
      }
      // Line comment
      if (ch === '-' && sql[i + 1] === '-') {
        let j = i;
        while (j < sql.length && sql[j] !== '\n') j++;
        tokens.push({ type: 'comment', value: sql.slice(i, j) });
        i = j; continue;
      }
      // Block comment
      if (ch === '/' && sql[i + 1] === '*') {
        let j = i + 2;
        while (j < sql.length && !(sql[j] === '*' && sql[j + 1] === '/')) j++;
        j = Math.min(j + 2, sql.length);
        tokens.push({ type: 'comment', value: sql.slice(i, j) });
        i = j; continue;
      }
      // String
      if (ch === "'" || ch === '"') {
        const quote = ch;
        let j = i + 1;
        while (j < sql.length && sql[j] !== quote) { if (sql[j] === '\\') j++; j++; }
        j = Math.min(j + 1, sql.length);
        tokens.push({ type: 'string', value: sql.slice(i, j) });
        i = j; continue;
      }
      // Number
      if (/[0-9]/.test(ch)) {
        let j = i;
        while (j < sql.length && /[0-9.]/.test(sql[j])) j++;
        tokens.push({ type: 'number', value: sql.slice(i, j) });
        i = j; continue;
      }
      // Identifier / keyword
      if (/[A-Za-z_]/.test(ch)) {
        let j = i;
        while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
        const word = sql.slice(i, j);
        const upper = word.toUpperCase();
        if (KEYWORDS.has(upper)) tokens.push({ type: 'keyword', value: word });
        else if (FUNCTIONS.has(upper)) tokens.push({ type: 'function', value: word });
        else tokens.push({ type: 'identifier', value: word });
        i = j; continue;
      }
      // Punctuation / operators
      if (/[(),.;]/.test(ch)) { tokens.push({ type: 'punct', value: ch }); i++; continue; }
      if (/[+\-*/%=<>!]/.test(ch)) {
        let j = i;
        while (j < sql.length && /[+\-*/%=<>!]/.test(sql[j])) j++;
        tokens.push({ type: 'operator', value: sql.slice(i, j) });
        i = j; continue;
      }
      // Fallback
      tokens.push({ type: 'identifier', value: ch });
      i++;
    }
    return tokens.map(t => {
      const v = escapeHtml(t.value);
      if (t.type === 'ws' || t.type === 'identifier' || t.type === 'punct') return v;
      return `<span class="tok-${t.type}">${v}</span>`;
    }).join('');
  }

  // ---------- SQL format (very lightweight) ----------
  function formatSql(sql) {
    if (!sql) return '';
    const keywords = ['SELECT', 'FROM', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'OUTER JOIN', 'JOIN', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'UNION ALL', 'UNION', 'AND', 'OR'];
    let out = sql.replace(/\s+/g, ' ').trim();
    keywords.forEach(kw => {
      const re = new RegExp('\\b' + kw.replace(' ', '\\s+') + '\\b', 'gi');
      out = out.replace(re, '\n' + kw);
    });
    // Cleanup
    out = out.replace(/^\n/, '').replace(/,\s+/g, ',\n  ').replace(/\s+,/g, ',');
    // Indent items after SELECT
    out = out.replace(/SELECT\s+/i, 'SELECT\n  ');
    return out.trim();
  }

  // ---------- SQL validation ----------
  function validateSql(sql) {
    const errors = [];
    const warnings = [];
    if (!sql || !sql.trim()) { errors.push('SQL 不能为空'); return { errors, warnings, ok: false }; }
    const upper = sql.toUpperCase().trim();
    // Unbalanced parens
    const opens = (sql.match(/\(/g) || []).length;
    const closes = (sql.match(/\)/g) || []).length;
    if (opens !== closes) warnings.push(`括号不匹配：${opens} 个 ( 与 ${closes} 个 )`);
    if (/;\s*\S/.test(sql)) warnings.push('建议仅保留单条语句，分号后还有内容');
    if (!/LIMIT/i.test(sql) && upper.startsWith('SELECT')) warnings.push('建议添加 LIMIT 限制返回行数');
    return { errors, warnings, ok: errors.length === 0 };
  }

  // ---------- Render ----------
  function renderActions(actionsEl) {
    actionsEl.innerHTML = `
      <button class="btn btn-secondary btn-sm" id="ds-refresh-list">${Icon.refresh({ size: 14 })}<span>刷新</span></button>
      <button class="btn btn-accent" id="ds-add">${Icon.plus({ size: 16 })}<span>新建数据集</span></button>
    `;
    actionsEl.querySelector('#ds-add').addEventListener('click', () => openForm());
    actionsEl.querySelector('#ds-refresh-list').addEventListener('click', async (event) => {
      const btn = event.currentTarget, root = pageRoot;
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        await Store.refresh();
        if (!ownsPage(root)) return;
        renderStats(); renderToolbar(); renderList();
        UI.toast({ type: 'success', title: '已刷新数据集列表' });
      } catch (error) { if (ownsPage(root)) UI.toast({ type: 'error', title: '刷新失败', desc: error.message }); }
      finally { if (btn.isConnected) btn.disabled = false; }
    });
  }

  function render(contentEl, opts) {
    renderActions(opts.actionsEl);
    contentEl.innerHTML = `
      <div class="stat-strip" id="ds-stats"></div>
      <div class="section">
        <div class="toolbar" id="ds-toolbar"></div>
        <div id="ds-table"></div>
      </div>
    `;
    pageRoot = contentEl.querySelector('#ds-stats');
    renderStats();
    renderToolbar();
    renderList();
  }

  function renderStats() {
    const all = Store.getDatasets();
    const totalRows = all.reduce((s, d) => s + (d.rowCount || 0), 0);
    const sources = new Set(all.map(d => d.datasourceId)).size;
    document.getElementById('ds-stats').innerHTML = `
      <div class="stat-card animate-rise" style="animation-delay:60ms;">
        <div class="stat-card-header"><span class="stat-card-label">数据集总数</span><div class="stat-card-icon" style="background:var(--color-primary-soft);color:var(--color-primary);">${Icon.layers({ size: 16 })}</div></div>
        <div class="stat-card-value">${all.length}</div>
        <div class="stat-card-delta neutral">监控视图</div>
      </div>
      <div class="stat-card animate-rise" style="animation-delay:120ms;">
        <div class="stat-card-header"><span class="stat-card-label">关联数据源</span><div class="stat-card-icon" style="background:var(--color-info-soft);color:var(--color-info);">${Icon.database({ size: 16 })}</div></div>
        <div class="stat-card-value">${sources}</div>
        <div class="stat-card-delta up">活跃</div>
      </div>
      <div class="stat-card animate-rise" style="animation-delay:180ms;">
        <div class="stat-card-header"><span class="stat-card-label">总数据行数</span><div class="stat-card-icon" style="background:var(--color-success-soft);color:var(--color-success);">${Icon.barChart({ size: 16 })}</div></div>
        <div class="stat-card-value">${UI.formatNumber(totalRows)}</div>
        <div class="stat-card-delta neutral">累计扫描</div>
      </div>
      <div class="stat-card animate-rise" style="animation-delay:240ms;">
        <div class="stat-card-header"><span class="stat-card-label">今日更新</span><div class="stat-card-icon" style="background:var(--color-accent-soft);color:var(--color-accent);">${Icon.clock({ size: 16 })}</div></div>
        <div class="stat-card-value">${all.filter(d => formatTime(d.updatedAt).slice(0, 10) === formatTime(new Date().toISOString()).slice(0, 10)).length}</div>
        <div class="stat-card-delta up">已同步</div>
      </div>
    `;
  }

  function renderToolbar() {
    const datasources = Store.getDatasources();
    document.getElementById('ds-toolbar').innerHTML = `
      <div class="toolbar-search">
        <span class="search-icon">${Icon.search({ size: 16 })}</span>
        <input type="search" placeholder="搜索数据集名称、描述…" aria-label="搜索数据集" id="ds-search" value="${escapeHtml(state.search)}" />
        <button type="button" class="toolbar-search-clear" aria-label="清空搜索" ${state.search ? '' : 'hidden'}>${Icon.x({ size: 14 })}</button>
      </div>
      <select class="filter-select" id="ds-source-filter">
        <option value="all">全部数据源</option>
        ${datasources.map(d => `<option value="${d.id}" ${state.datasourceFilter === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
      </select>
      <div class="toolbar-divider"></div>
      <span class="text-xs text-muted" id="ds-count-text"></span>
    `;
    document.getElementById('ds-search').addEventListener('input', (e) => { state.search = e.target.value; state.page = 1; document.querySelector('#ds-toolbar .toolbar-search-clear').hidden = !state.search; renderList(); });
    document.querySelector('#ds-toolbar .toolbar-search-clear').addEventListener('click', () => {
      const input = document.getElementById('ds-search'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
    });
    document.getElementById('ds-source-filter').addEventListener('change', (e) => { state.datasourceFilter = e.target.value; state.page = 1; renderList(); });
  }

  function getFiltered() {
    let list = Store.getDatasets();
    if (state.search) {
      const q = state.search.toLowerCase();
      list = list.filter(d => d.name.toLowerCase().includes(q) || (d.description || '').toLowerCase().includes(q));
    }
    if (state.datasourceFilter !== 'all') list = list.filter(d => d.datasourceId === state.datasourceFilter);
    return list;
  }

  function renderList() {
    const all = getFiltered();
    const total = all.length;
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page > totalPages) state.page = totalPages;
    const pageItems = all.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);

    const countText = document.getElementById('ds-count-text');
    if (countText) countText.textContent = `共 ${total} 个数据集`;

    const tableEl = document.getElementById('ds-table');
    if (total === 0) {
      tableEl.innerHTML = UI.emptyState({
        icon: Icon.layers({ size: 24 }),
        iconCls: 'muted',
        title: state.search || state.datasourceFilter !== 'all' ? '没有匹配的数据集' : '还没有数据集',
        desc: state.search ? '尝试调整搜索条件' : '创建第一个数据集以定义监控视图',
        action: !state.search && state.datasourceFilter === 'all' ? `<button class="btn btn-accent" onclick="document.getElementById('ds-add').click()">${Icon.plus({ size: 16 })}新建数据集</button>` : '',
      });
      return;
    }

    tableEl.innerHTML = `
      <div class="table-wrap">
        <table class="data-table" data-table-id="dataset-list">
          <thead>
            <tr>
              <th data-column-key="dataset" data-default-width="220">数据集</th>
              <th data-column-key="datasource" data-default-width="180">数据源</th>
              <th data-column-key="fields" data-default-width="260">字段</th>
              <th data-column-key="rows" data-default-width="100">行数</th>
              <th data-column-key="updated-at" data-default-width="180">更新时间</th>
              <th data-column-key="actions" data-min-width="170" data-default-width="170" style="text-align:right;">操作</th>
            </tr>
          </thead>
          <tbody>
            ${pageItems.map((d, i) => `
              <tr class="animate-fade" style="animation-delay:${i * 30}ms;">
                <td>
                  <div class="cell-strong">${escapeHtml(d.name)}</div>
                  ${d.description ? `<div class="cell-muted" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(d.description)}</div>` : ''}
                </td>
                <td>
                  <div class="flex items-center gap-2">
                    ${Icon.database({ size: 14 })}
                    <span class="cell-muted">${escapeHtml(d.datasourceName)}</span>
                  </div>
                </td>
                <td>
                  <div class="flex gap-1" style="flex-wrap:wrap;max-width:240px;">
                    ${(d.fields || []).slice(0, 3).map(f => `<span class="badge neutral" style="font-family:var(--font-mono);">${escapeHtml(f.name)}</span>`).join('')}
                    ${(d.fields || []).length > 3 ? `<span class="badge neutral">+${d.fields.length - 3}</span>` : ''}
                  </div>
                </td>
                <td class="cell-mono">${UI.formatNumber(d.rowCount || 0)}</td>
                <td class="cell-muted">${escapeHtml(formatTime(d.updatedAt))}</td>
                <td>
                  <div class="cell-actions">
                    <button class="row-action" data-action="query" data-id="${d.id}" data-tooltip="查询预览" aria-label="查询">${Icon.terminal({ size: 15 })}</button>
                    <button class="row-action" data-action="edit" data-id="${d.id}" data-tooltip="编辑" aria-label="编辑">${Icon.edit({ size: 15 })}</button>
                    <button class="row-action" data-action="copy" data-id="${d.id}" data-tooltip="复制" aria-label="复制">${Icon.copy({ size: 15 })}</button>
                    <button class="row-action danger" data-action="delete" data-id="${d.id}" data-tooltip="删除" aria-label="删除">${Icon.trash({ size: 15 })}</button>
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
        if (action === 'query') openQuery(id);
        else if (action === 'edit') openForm(id);
        else if (action === 'copy') copyDataset(id);
        else if (action === 'delete') confirmDelete(id);
      });
    });
    tableEl.querySelectorAll('.page-btn[data-page]').forEach(btn => {
      btn.addEventListener('click', () => { state.page = parseInt(btn.dataset.page); renderList(); });
    });
  }

  async function copyDataset(id) {
    const d = Store.getDataset(id);
    if (!d) return;
    try {
      await navigator.clipboard.writeText(d.sql || '');
      UI.toast({ type: 'success', title: '已复制 SQL', desc: d.name });
    } catch {
      UI.toast({ type: 'info', title: '已复制', desc: d.name });
    }
  }

  async function confirmDelete(id) {
    const root = pageRoot;
    const d = Store.getDataset(id);
    if (!d || deletingIds.has(id)) return;
    deletingIds.add(id);
    syncPendingControls();
    try {
      const ok = await UI.confirm({ title: '删除数据集', desc: `确定要删除「${d.name}」吗？关联的异常规则将失效。`, confirmText: '删除', danger: true });
      if (!ok || !ownsPage(root)) return;
      await Store.deleteDataset(id);
      if (!ownsPage(root)) return;
      UI.toast({ type: 'success', title: '已删除', desc: d.name }); renderList(); renderStats();
    } catch (error) { if (ownsPage(root)) UI.toast({ type: 'error', title: '删除失败', desc: error.message }); }
    finally { deletingIds.delete(id); syncPendingControls(); }
  }

  // ---------- Query preview drawer ----------
  function openQuery(id) {
    const d = Store.getDataset(id);
    if (!d) return;
    let results = [];
    let resultFields = [];
    let running = false;
    let attempted = false;

    const d_ = UI.drawer({
      title: escapeHtml(d.name),
      subtitle: `${escapeHtml(d.datasourceName)} · ${d.fields.length} 个字段 · ${UI.formatNumber(d.rowCount)} 行`,
      size: 'lg',
      body: `
        <div class="field">
          <label class="field-label"><span>SQL 查询</span><span class="field-optional">支持语法高亮 · Ctrl+Enter 运行</span></label>
          ${renderSqlEditor(d.sql)}
        </div>
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <span class="eyebrow">查询结果</span>
            <span class="badge neutral" id="result-count">未执行</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="shortcut-hint">耗时 <kbd id="result-time">—</kbd></span>
            <button class="btn btn-ghost btn-sm" id="result-export">${Icon.download({ size: 14 })}导出</button>
          </div>
        </div>
        <div id="result-area">${UI.emptyState({ icon: Icon.terminal({ size: 24 }), iconCls: 'muted', title: '点击运行查看结果', desc: '执行 SQL 查询以预览数据' })}</div>
      `,
      footer: `<button class="btn btn-ghost" id="q-close">关闭</button><button class="btn btn-secondary" id="q-format">${Icon.sparkle({ size: 16 })}格式化</button><button class="btn btn-accent" id="q-run">${Icon.play({ size: 16 })}运行查询</button>`,
    });

    const editorTextarea = d_.body.querySelector('.sql-textarea');
    const editorHighlight = d_.body.querySelector('.sql-highlight');
    const lineNumbers = d_.body.querySelector('.sql-line-numbers');
    const footerStatus = d_.body.querySelector('.sql-editor-footer .footer-status');

    function syncHighlight() {
      const sql = editorTextarea.value;
      editorHighlight.innerHTML = highlightSql(sql) + '\n';
      const lines = sql.split('\n').length;
      lineNumbers.innerHTML = Array.from({ length: lines }, (_, i) => `<div>${i + 1}</div>`).join('');
      const v = validateSql(sql);
      if (v.errors.length) { footerStatus.className = 'footer-status warn'; footerStatus.innerHTML = `${Icon.alert({ size: 12 })}${v.errors[0]}`; }
      else if (v.warnings.length) { footerStatus.className = 'footer-status warn'; footerStatus.innerHTML = `${Icon.alert({ size: 12 })}${v.warnings[0]}`; }
      else { footerStatus.className = 'footer-status ok'; footerStatus.innerHTML = `${Icon.check({ size: 12 })}编辑中 · ${lines} 行（以服务端校验为准）`; }
    }

    function syncScroll() {
      editorHighlight.scrollTop = editorTextarea.scrollTop;
      editorHighlight.scrollLeft = editorTextarea.scrollLeft;
      lineNumbers.scrollTop = editorTextarea.scrollTop;
    }

    editorTextarea.addEventListener('input', syncHighlight);
    editorTextarea.addEventListener('scroll', syncScroll);
    editorTextarea.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = editorTextarea.selectionStart, en = editorTextarea.selectionEnd;
        editorTextarea.value = editorTextarea.value.slice(0, s) + '  ' + editorTextarea.value.slice(en);
        editorTextarea.selectionStart = editorTextarea.selectionEnd = s + 2;
        syncHighlight();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runQuery(); }
    });

    // Initial sync
    syncHighlight();

    async function runQuery() {
      if (running || !d_.drawer.isConnected) return;
      const sql = editorTextarea.value;
      const v = validateSql(sql);
      if (!v.ok) {
        UI.toast({ type: 'error', title: 'SQL 校验失败', desc: v.errors[0] });
        return;
      }
      running = true;
      attempted = true;
      const runBtn = d_.drawer.querySelector('#q-run');
      const original = runBtn.innerHTML;
      runBtn.innerHTML = `<span class="btn-spinner"></span>运行中…`;
      runBtn.disabled = true;
      d_.body.querySelector('#result-area').innerHTML = `
        <div class="state" style="padding: var(--space-12);">
          <div class="state-icon primary"><span class="btn-spinner" style="width:24px;height:24px;border-width:3px;"></span></div>
          <div class="state-title">正在执行查询…</div>
          <div class="state-desc">连接 ${escapeHtml(d.datasourceName)}</div>
        </div>
      `;
      try {
        const response = await Store.executeDatasetSql(d.datasourceId, sql);
        if (!d_.drawer.isConnected) return;
        results = response.rows;
        resultFields = response.fields;
        const elapsed = response.elapsed_ms;
        d_.body.querySelector('#result-count').textContent = `${results.length} 行`;
        d_.body.querySelector('#result-count').className = 'badge success';
        d_.body.querySelector('#result-time').textContent = elapsed + 'ms';
        d_.body.querySelector('#result-area').innerHTML = renderResultsTable(results, response.fields);
        UI.toast({ type: 'success', title: '查询完成', desc: `${results.length} 行 · ${elapsed}ms` });
      } catch (error) {
        if (!d_.drawer.isConnected) return;
        results = [];
        d_.body.querySelector('#result-area').innerHTML = UI.emptyState({ icon: Icon.alert({ size: 24 }), iconCls: 'danger', title: '查询失败', desc: error.message });
        UI.toast({ type: 'error', title: '查询失败', desc: error.message });
      } finally {
        if (runBtn.isConnected) { runBtn.innerHTML = original; runBtn.disabled = false; }
        running = false;
      }
    }

    d_.drawer.querySelector('#q-run').addEventListener('click', runQuery);
    d_.body.querySelector('#editor-format-btn').addEventListener('click', () => { editorTextarea.value = formatSql(editorTextarea.value); syncHighlight(); });
    d_.body.querySelector('#editor-validate-btn').addEventListener('click', event => validateEditor(editorTextarea, event.currentTarget, () => d_.drawer.isConnected));
    d_.drawer.querySelector('#q-close').addEventListener('click', () => d_.close());
    d_.drawer.querySelector('#q-format').addEventListener('click', () => {
      editorTextarea.value = formatSql(editorTextarea.value);
      syncHighlight();
      UI.toast({ type: 'info', title: '已格式化', desc: 'SQL 已重新排版' });
    });
    d_.body.querySelector('#result-export').addEventListener('click', () => {
      if (results.length === 0) { UI.toast({ type: 'warning', title: '暂无数据可导出', desc: '请先执行查询' }); return; }
      UI.downloadCsv(results, resultFields, 'query-results.csv');
      UI.toast({ type: 'success', title: '导出已开始', desc: `${results.length} 行 · CSV 格式` });
    });

    // Auto-run once for preview
    setTimeout(() => { if (d_.drawer.isConnected && !attempted) runQuery(); }, 300);
  }

  async function validateEditor(textarea, btn, isCurrent) {
    if (btn.disabled || !isCurrent()) return;
    const sql = textarea.value;
    btn.disabled = true;
    try {
      await Store.validateDatasetSql(sql);
      if (isCurrent() && textarea.value === sql) UI.toast({ type: 'success', title: '校验通过' });
    } catch (error) { if (isCurrent() && textarea.value === sql) UI.toast({ type: 'error', title: '校验失败', desc: error.message }); }
    finally { if (btn.isConnected) btn.disabled = false; }
  }

  function renderSqlEditor(sql) {
    return `
      <div class="sql-editor">
        <div class="sql-editor-header">
          <div class="sql-editor-tabs">
            <span class="sql-tab active">${Icon.code({ size: 12 })}query.sql</span>
          </div>
          <div class="sql-editor-actions">
            <button class="sql-icon-btn" data-tooltip="格式化" id="editor-format-btn">${Icon.sparkle({ size: 14 })}</button>
            <button class="sql-icon-btn" data-tooltip="校验" id="editor-validate-btn">${Icon.check({ size: 14 })}</button>
          </div>
        </div>
        <div class="sql-editor-body">
          <div class="sql-line-numbers"></div>
          <div class="sql-code-area">
            <pre class="sql-highlight"></pre>
            <textarea class="sql-textarea" spellcheck="false" autocomplete="off" autocapitalize="off">${escapeHtml(sql)}</textarea>
          </div>
        </div>
        <div class="sql-editor-footer">
          <span class="footer-status ok">${Icon.check({ size: 12 })}就绪</span>
          <span>UTF-8 · SQL</span>
        </div>
      </div>
    `;
  }

  function renderResultsTable(rows, fields) {
    if (!rows || rows.length === 0) {
      return UI.emptyState({ icon: Icon.inbox({ size: 24 }), iconCls: 'muted', title: '查询无结果', desc: '当前 SQL 没有返回数据' });
    }
    const cols = fields || Object.keys(rows[0]).map(k => ({ name: k, type: 'VARCHAR' }));
    return `
      <div class="results-wrap">
        <div style="overflow:auto;max-height:360px;">
          <table class="results-table" data-table-id="dataset-query-results">
            <thead>
              <tr>
                <th data-column-key="row-number" data-min-width="48" data-default-width="48" style="width:48px;text-align:right;">#</th>
                ${cols.map(c => `<th data-column-key="${escapeHtml(c.name)}" data-default-width="160">${escapeHtml(c.name)}<span style="color:var(--color-ink-faint);font-weight:400;margin-left:6px;text-transform:none;letter-spacing:0;">${escapeHtml(c.type)}</span></th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${rows.map((row, i) => `
                <tr>
                  <td style="text-align:right;color:var(--color-ink-faint);">${i + 1}</td>
                  ${cols.map(c => {
                    const v = row[c.name];
                    if (v === null || v === undefined) return `<td class="null-val">NULL</td>`;
                    return `<td>${escapeHtml(String(v))}</td>`;
                  }).join('')}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ---------- Add/Edit form ----------
  function openForm(id) {
    const root = pageRoot;
    const editing = id ? Store.getDataset(id) : null;
    const data = editing || { name: '', description: '', datasourceId: '', sql: 'SELECT\n  COUNT(*) AS total\nFROM\n  your_table\nLIMIT 10;', fields: [] };
    const datasources = Store.getDatasources();

    const m = UI.modal({
      title: editing ? '编辑数据集' : '新建数据集',
      subtitle: editing ? `修改 ${escapeHtml(data.name)}` : '从数据源创建可复用的 SQL 视图',
      size: 'xl',
      body: `
        <div class="form-section">
          <div class="form-section-title">${Icon.info({ size: 14 })}基本信息</div>
          <div class="form-grid">
            ${UI.field('数据集名称', `<input class="input" id="f-name" value="${escapeHtml(data.name)}" placeholder="例如：每日订单金额汇总" />`, { required: true })}
            ${UI.field('关联数据源', `
              <select class="select" id="f-datasource">
                <option value="">请选择数据源…</option>
                ${datasources.map(d => `<option value="${d.id}" ${data.datasourceId === d.id ? 'selected' : ''}>${escapeHtml(d.name)} (${d.type === 'mysql' ? 'MySQL' : 'StarRocks'})</option>`).join('')}
              </select>
            `, { required: true })}
            ${UI.field('描述', `<input class="input" id="f-desc" value="${escapeHtml(data.description || '')}" placeholder="数据集用途说明" />`, { optional: true, span2: true })}
          </div>
        </div>
        <div class="form-section">
          <div class="form-section-title">${Icon.terminal({ size: 14 })}SQL 查询</div>
          <div class="form-section-desc">支持 SELECT 与 CTE 只读查询。运行后将自动解析字段。</div>
          <div id="form-sql-editor">${renderSqlEditor(data.sql)}</div>
        </div>
        <div class="form-section" id="form-preview-panel" hidden>
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <span class="eyebrow">预览数据</span>
              <span class="badge neutral" id="form-preview-count">0 行</span>
            </div>
            <span class="shortcut-hint">耗时 <kbd id="form-preview-time">—</kbd></span>
          </div>
          <div id="form-preview-area"></div>
        </div>
      `,
      footer: `
        <button class="btn btn-secondary" id="f-run">${Icon.play({ size: 16 })}运行并解析字段</button>
        <div style="flex:1;"></div>
        <button class="btn btn-ghost" data-action="cancel">取消</button>
        <button class="btn btn-accent" id="f-save">${Icon.check({ size: 16 })}${editing ? '保存修改' : '创建数据集'}</button>
      `,
    });

    const editorTextarea = m.dialog.querySelector('.sql-textarea');
    const editorHighlight = m.dialog.querySelector('.sql-highlight');
    const lineNumbers = m.dialog.querySelector('.sql-line-numbers');
    const footerStatus = m.dialog.querySelector('.sql-editor-footer .footer-status');

    function syncHighlight() {
      const sql = editorTextarea.value;
      editorHighlight.innerHTML = highlightSql(sql) + '\n';
      const lines = sql.split('\n').length;
      lineNumbers.innerHTML = Array.from({ length: lines }, (_, i) => `<div>${i + 1}</div>`).join('');
      const v = validateSql(sql);
      if (v.errors.length) { footerStatus.className = 'footer-status warn'; footerStatus.innerHTML = `${Icon.alert({ size: 12 })}${v.errors[0]}`; }
      else { footerStatus.className = 'footer-status ok'; footerStatus.innerHTML = `${Icon.check({ size: 12 })}编辑中（以服务端校验为准）`; }
    }
    function syncScroll() {
      editorHighlight.scrollTop = editorTextarea.scrollTop;
      editorHighlight.scrollLeft = editorTextarea.scrollLeft;
      lineNumbers.scrollTop = editorTextarea.scrollTop;
    }
    editorTextarea.addEventListener('input', syncHighlight);
    editorTextarea.addEventListener('scroll', syncScroll);
    editorTextarea.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = editorTextarea.selectionStart, en = editorTextarea.selectionEnd;
        editorTextarea.value = editorTextarea.value.slice(0, s) + '  ' + editorTextarea.value.slice(en);
        editorTextarea.selectionStart = editorTextarea.selectionEnd = s + 2;
        syncHighlight();
      }
    });
    m.dialog.querySelector('#editor-format-btn').addEventListener('click', () => { editorTextarea.value = formatSql(editorTextarea.value); syncHighlight(); UI.toast({ type: 'info', title: '已格式化' }); });
    m.dialog.querySelector('#editor-validate-btn').addEventListener('click', event => validateEditor(editorTextarea, event.currentTarget, () => m.dialog.isConnected));

    syncHighlight();

    let parsedFields = data.fields || [];
    let parsedRowCount = data.rowCount || 0;

    m.dialog.querySelector('#f-run').addEventListener('click', async () => {
      const btn = m.dialog.querySelector('#f-run');
      if (btn.disabled || !m.dialog.isConnected) return;
      const original = btn.innerHTML;
      btn.innerHTML = `<span class="btn-spinner"></span>运行中…`;
      btn.disabled = true;
      try {
        const datasourceId = m.dialog.querySelector('#f-datasource').value;
        if (!datasourceId) throw new Error('请先选择数据源');
        const response = await Store.executeDatasetSql(datasourceId, editorTextarea.value);
        if (!m.dialog.isConnected) return;
        parsedFields = response.fields;
        parsedRowCount = response.row_count;
        const previewRows = response.rows || [];
        const previewPanel = m.dialog.querySelector('#form-preview-panel');
        previewPanel.hidden = false;
        m.dialog.querySelector('#form-preview-count').textContent = `${previewRows.length} 行`;
        m.dialog.querySelector('#form-preview-count').className = 'badge success';
        m.dialog.querySelector('#form-preview-time').textContent = `${response.elapsed_ms}ms`;
        m.dialog.querySelector('#form-preview-area').innerHTML = renderResultsTable(previewRows, parsedFields);
        UI.toast({ type: 'success', title: '解析成功', desc: `识别 ${parsedFields.length} 个字段 · 预览 ${parsedRowCount} 行` });
      } catch (error) {
        if (m.dialog.isConnected) UI.toast({ type: 'error', title: '执行失败', desc: error.message });
      } finally {
        if (btn.isConnected) { btn.innerHTML = original; btn.disabled = false; }
      }
    });

    m.dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => m.close());

    m.dialog.querySelector('#f-save').addEventListener('click', async () => {
      const btn = m.dialog.querySelector('#f-save');
      if (btn.disabled || !m.dialog.isConnected) return;
      const name = m.dialog.querySelector('#f-name').value.trim();
      const datasourceId = m.dialog.querySelector('#f-datasource').value;
      if (!name) { UI.toast({ type: 'warning', title: '请填写数据集名称' }); return; }
      if (!datasourceId) { UI.toast({ type: 'warning', title: '请选择关联数据源' }); return; }
      const ds = Store.getDatasource(datasourceId);
      const payload = {
        name,
        datasourceId,
        datasourceName: ds ? ds.name : '',
        description: m.dialog.querySelector('#f-desc').value.trim(),
        sql: editorTextarea.value,
        fields: parsedFields,
        rowCount: parsedRowCount,
      };
      btn.disabled = true;
      const original = btn.innerHTML;
      btn.innerHTML = '<span class="btn-spinner"></span>保存中…';
      let saved;
      try { saved = editing ? await Store.updateDataset(id, payload) : await Store.addDataset(payload); }
      catch (error) {
        if (m.dialog.isConnected) { UI.toast({ type: 'error', title: '保存失败', desc: error.message }); btn.disabled = false; btn.innerHTML = original; }
        return;
      }
      // The create is committed. Close its form before attempting the optional preview.
      const visible = m.dialog.isConnected;
      if (visible) {
        UI.toast({ type: 'success', title: editing ? '已保存' : '已创建', desc: name });
        m.close();
        if (ownsPage(root)) { renderList(); renderStats(); }
      }
      if (!visible) return;
      try {
        const result = await Store.executeDataset(saved.id);
        if (!ownsPage(root)) return;
        renderList(); renderStats();
        if (result?.refreshWarning) UI.toast({ type: 'warning', title: '已保存，列表刷新失败', desc: result.refreshWarning });
      } catch (error) { if (ownsPage(root)) UI.toast({ type: 'warning', title: '已保存，预览失败', desc: error.message }); }
    });
  }

  return { render, openItem: openQuery };
})();
