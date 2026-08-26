/* ============================================================
   app.js — SPA router, sidebar wiring, topbar wiring
   ============================================================ */
(function () {
  const routes = {
    records:    { title: '异常记录',    desc: '系统检测到的所有数据异常事件', module: 'RecordsModule' },
    'anomaly-groups': { title: '异常记录组', desc: '按规则执行批次汇总异常记录与群聊播报状态', module: 'AnomalyGroupsModule' },
    rules:      { title: '异常规则',    desc: '配置数据质量检测规则与通知策略', module: 'RulesModule' },
    datasets:   { title: '数据集',      desc: '基于 SQL 的监控数据视图', module: 'DatasetModule' },
    datasources:{ title: '数据源',      desc: '管理 MySQL 与 StarRocks 连接', module: 'DatasourceModule' },
    overview:   { title: '总览',        desc: '平台运行状态全景', module: 'OverviewModule' },
    tests:      { title: '测试',        desc: '验证系统集成与消息通知链路', module: 'TestsModule' },
  };

  const pageRoot = document.getElementById('page-root');
  const breadcrumb = document.getElementById('breadcrumb');
  const appShell = document.querySelector('.app-shell');
  let loginScreen = null;
  let failureScreen = null;
  let loginReturnHash = location.hash || '#records';
  let closeGlobalSearch = () => {};

  function businessShellIsVisible() {
    return !appShell || !appShell.hidden;
  }

  function setBusinessShellVisible(visible) {
    if (!appShell) return;
    appShell.hidden = !visible;
    appShell.setAttribute('aria-hidden', String(!visible));
  }

  function dismissBusinessOverlays() {
    closeGlobalSearch();
    document.querySelectorAll('.modal-backdrop, .drawer-backdrop').forEach(backdrop => {
      const close = backdrop.querySelector('.modal-close');
      if (close) close.click();
      else backdrop.remove();
    });
    document.body.style.overflow = '';
  }

  function removeStandaloneScreen() {
    loginScreen?.remove();
    failureScreen?.remove();
    loginScreen = null;
    failureScreen = null;
  }

  function showBackendFailure(error) {
    setBusinessShellVisible(false);
    loginScreen?.remove();
    loginScreen = null;
    if (failureScreen) return;
    failureScreen = document.createElement('main');
    failureScreen.className = 'backend-failure-screen';
    failureScreen.innerHTML = `
      <section class="backend-failure-card" aria-labelledby="backend-failure-title">
        <div class="login-brand-mark" aria-hidden="true">!</div>
        <p class="login-eyebrow">SENTINEL / CONNECTION</p>
        <h1 id="backend-failure-title">后端连接失败</h1>
        <p role="alert">${UI.escapeHtml(error.message || '无法连接到 Sentinel 后端服务')}</p>
      </section>
    `;
    document.body.appendChild(failureScreen);
  }

  function showLogin() {
    loginReturnHash = location.hash || loginReturnHash || '#records';
    dismissBusinessOverlays();
    setBusinessShellVisible(false);
    failureScreen?.remove();
    failureScreen = null;
    if (loginScreen) {
      loginScreen.querySelector('#login-username')?.focus();
      return;
    }

    loginScreen = document.createElement('main');
    loginScreen.className = 'login-screen';
    loginScreen.innerHTML = `
      <section class="login-card" aria-labelledby="login-title">
        <div class="login-brand-mark" aria-hidden="true">S</div>
        <p class="login-eyebrow">SENTINEL / ANOMALY</p>
        <h1 id="login-title">登录 Sentinel</h1>
        <p class="login-intro">使用您的 Sentinel 账号继续管理异常监控。</p>
        <form id="login-form" novalidate>
          <div class="field">
            <label class="field-label" for="login-username">用户名</label>
            <input class="input" id="login-username" name="username" type="text" autocomplete="username" required aria-required="true" />
          </div>
          <div class="field">
            <label class="field-label" for="login-password">密码</label>
            <input class="input" id="login-password" name="password" type="password" autocomplete="current-password" required aria-required="true" aria-describedby="login-error" />
          </div>
          <div class="login-error" id="login-error" role="alert" hidden></div>
          <button class="btn btn-accent btn-lg login-submit" type="submit">登录</button>
        </form>
      </section>
    `;
    document.body.appendChild(loginScreen);

    const form = loginScreen.querySelector('#login-form');
    const username = loginScreen.querySelector('#login-username');
    const password = loginScreen.querySelector('#login-password');
    const submit = loginScreen.querySelector('.login-submit');
    const errorEl = loginScreen.querySelector('#login-error');
    let pending = false;

    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (pending) return;
      const usernameValue = username.value.trim();
      const passwordValue = password.value;
      if (!usernameValue || !passwordValue) {
        errorEl.textContent = '请输入用户名和密码';
        errorEl.hidden = false;
        (!usernameValue ? username : password).focus();
        return;
      }

      pending = true;
      errorEl.hidden = true;
      submit.disabled = true;
      submit.innerHTML = '<span class="btn-spinner"></span>正在登录…';
      form.setAttribute('aria-busy', 'true');
      try {
        await Store.login(usernameValue, passwordValue);
        await Store.init();
        removeStandaloneScreen();
        setBusinessShellVisible(true);
        navigate((loginReturnHash || '#records').replace(/^#/, ''));
      } catch (error) {
        if (error.status === 401) {
          errorEl.textContent = error.message || '用户名或密码错误';
          errorEl.hidden = false;
        } else {
          showBackendFailure(error);
        }
      } finally {
        pending = false;
        if (loginScreen) {
          submit.disabled = false;
          submit.textContent = '登录';
          form.removeAttribute('aria-busy');
        }
      }
    });
    username.focus();
  }

  function setActiveNav(route) {
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.route === route);
    });
  }

  function setBreadcrumb(title) {
    breadcrumb.querySelector('.crumb-current').textContent = title;
  }

  function renderRoute(route) {
    const config = routes[route] || routes.records;
    setActiveNav(route);
    setBreadcrumb(config.title);

    // Update nav badge
    const navCount = document.getElementById('nav-anomaly-count');
    if (navCount) {
      const stats = Store.getStats();
      const unresolved = stats.unresolvedRecords ?? (stats.pendingRecords + stats.processingRecords + (stats.timedOutRecords || 0));
      navCount.textContent = unresolved;
      navCount.classList.toggle('muted', unresolved === 0);
    }

    // Build page header
    const headerHtml = `
      <div class="page-header animate-rise">
        <div class="page-title-block">
          <div class="page-eyebrow"><span class="dot"></span>SENTINEL / ${config.title.toUpperCase()}</div>
          <h1 class="page-title">${config.title}</h1>
          <p class="page-desc">${config.desc}</p>
        </div>
        <div class="page-actions" id="page-actions"></div>
      </div>
    `;

    pageRoot.innerHTML = headerHtml + `<div id="page-content"></div>`;

    const module = window[config.module];
    if (module && typeof module.render === 'function') {
      module.render(document.getElementById('page-content'), {
        actionsEl: document.getElementById('page-actions'),
        navigate,
      });
    } else {
      document.getElementById('page-content').innerHTML = UI.emptyState({
        icon: Icon.bug({ size: 24 }),
        title: '模块未实现',
        desc: `模块 ${config.module} 暂未实现`,
      });
    }
  }

  function parseRoute(target) {
    const parts = String(target || 'records').replace(/^#/, '').split('/');
    const route = routes[parts[0]] ? parts[0] : 'records';
    let detailId = null;
    if (['records', 'anomaly-groups'].includes(parts[0]) && parts[1]) {
      try { detailId = decodeURIComponent(parts.slice(1).join('/')); }
      catch (_) { detailId = parts.slice(1).join('/'); }
    }
    return { route, detailId };
  }

  function navigate(target) {
    const { route, detailId } = parseRoute(target);
    const hash = detailId ? `#${route}/${encodeURIComponent(detailId)}` : '#' + route;
    history.replaceState(null, '', hash);
    renderRoute(route);
    if (detailId) {
      const module = window[routes[route].module];
      if (module && typeof module.openDetail === 'function') {
        Promise.resolve().then(() => module.openDetail(detailId));
      }
    }
    // Close mobile sidebar
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-backdrop').classList.remove('show');
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  // ---------- Global command search ----------
  function setupGlobalSearch() {
    const triggers = [
      document.getElementById('global-search-trigger'),
      document.getElementById('global-search-mobile-trigger'),
    ].filter(Boolean);
    if (triggers.length === 0) return;

    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    document.querySelectorAll('.shortcut-label').forEach(el => { el.textContent = isMac ? '⌘ K' : 'Ctrl K'; });

    let panel = null;
    let input = null;
    let resultItems = [];
    let selectedIndex = -1;
    let searchTimer = null;
    let requestSequence = 0;
    let restoreFocus = null;

    const entityConfig = {
      record: { route: 'records', module: 'RecordsModule' },
      rule: { route: 'rules', module: 'RulesModule' },
      dataset: { route: 'datasets', module: 'DatasetModule' },
      datasource: { route: 'datasources', module: 'DatasourceModule' },
    };

    const matches = (value, query) => String(value || '').toLocaleLowerCase('zh-CN').includes(query);
    const rankAndLimit = (items, query, fields, limit = 4) => items
      .map(item => {
        const values = fields.map(field => String(item[field] || '').toLocaleLowerCase('zh-CN'));
        const score = values.some(value => value.startsWith(query)) ? 0 : 1;
        return { item, score };
      })
      .filter(entry => fields.some(field => matches(entry.item[field], query)))
      .sort((a, b) => a.score - b.score || String(a.item.name || '').localeCompare(String(b.item.name || ''), 'zh-CN'))
      .slice(0, limit)
      .map(entry => entry.item);

    function closeSearch() {
      if (!panel) return;
      window.clearTimeout(searchTimer);
      requestSequence += 1;
      panel.remove();
      panel = null;
      input = null;
      resultItems = [];
      selectedIndex = -1;
      const focusTarget = restoreFocus;
      restoreFocus = null;
      focusTarget?.focus();
    }
    closeGlobalSearch = closeSearch;

    function setSelected(index) {
      if (resultItems.length === 0) return;
      selectedIndex = (index + resultItems.length) % resultItems.length;
      resultItems.forEach((item, itemIndex) => {
        const active = itemIndex === selectedIndex;
        item.classList.toggle('active', active);
        item.setAttribute('aria-selected', String(active));
        if (active) {
          input?.setAttribute('aria-activedescendant', item.id);
          item.scrollIntoView({ block: 'nearest' });
        }
      });
    }

    function openResult(type, id) {
      const config = entityConfig[type];
      if (!config) return;
      closeSearch();
      if (type === 'record') {
        navigate(`records/${id}`);
        return;
      }
      navigate(config.route);
      const module = window[config.module];
      if (module && typeof module.openItem === 'function') module.openItem(id);
    }

    function resultMarkup(type, item, title, meta, icon) {
      return `
        <button class="command-result" type="button" role="option" aria-selected="false" data-type="${type}" data-id="${UI.escapeHtml(item.id)}">
          <span class="command-result-icon">${icon}</span>
          <span class="command-result-copy">
            <strong>${UI.escapeHtml(title)}</strong>
            <span>${UI.escapeHtml(meta)}</span>
          </span>
          ${Icon.arrowRight({ size: 14 })}
        </button>
      `;
    }

    function announceSearchStatus(message) {
      const status = panel?.querySelector('#global-search-status');
      if (status) status.textContent = message;
    }

    function renderGroups(groups) {
      if (!panel) return;
      const results = panel.querySelector('#global-search-results');
      const visibleGroups = groups.filter(group => group.items.length > 0);
      if (visibleGroups.length === 0) {
        results.removeAttribute('role');
        results.innerHTML = `<div class="command-state">${Icon.search({ size: 22 })}<strong>没有匹配结果</strong><span>尝试名称、描述、主机或异常字段</span></div>`;
        announceSearchStatus('没有匹配结果');
      } else {
        results.setAttribute('role', 'listbox');
        results.innerHTML = visibleGroups.map((group, groupIndex) => `
          <section class="command-group" role="group" aria-labelledby="global-search-group-${groupIndex}">
            <div class="command-group-label" id="global-search-group-${groupIndex}">${group.label}<span>${group.items.length}</span></div>
            ${group.items.map(group.render).join('')}
          </section>
        `).join('');
        const resultCount = visibleGroups.reduce((total, group) => total + group.items.length, 0);
        announceSearchStatus(`找到 ${resultCount} 个结果，分为 ${visibleGroups.length} 组`);
      }
      resultItems = [...results.querySelectorAll('.command-result')];
      selectedIndex = -1;
      input?.removeAttribute('aria-activedescendant');
      resultItems.forEach((item, index) => {
        item.id = `global-search-option-${index}`;
        item.addEventListener('mouseenter', () => setSelected(index));
        item.addEventListener('click', () => openResult(item.dataset.type, item.dataset.id));
      });
    }

    async function performSearch(rawQuery) {
      const queryText = rawQuery.trim();
      const query = queryText.toLocaleLowerCase('zh-CN');
      const sequence = ++requestSequence;
      if (!panel) return;
      const results = panel.querySelector('#global-search-results');
      if (!query) {
        results.removeAttribute('role');
        results.innerHTML = `<div class="command-state command-state-idle">${Icon.search({ size: 22 })}<strong>搜索整个 Sentinel</strong><span>输入关键词查找异常记录、规则、数据集和数据源</span></div>`;
        announceSearchStatus('请输入关键词开始搜索');
        resultItems = [];
        input?.removeAttribute('aria-activedescendant');
        return;
      }

      results.removeAttribute('role');
      results.innerHTML = `<div class="command-state"><span class="spinner"></span><strong>正在搜索</strong><span>正在汇总各业务模块</span></div>`;
      announceSearchStatus('正在搜索');
      input?.removeAttribute('aria-activedescendant');
      const rules = rankAndLimit(Store.getRules?.() || [], query, ['name', 'description', 'datasetName']);
      const datasets = rankAndLimit(Store.getDatasets?.() || [], query, ['name', 'description', 'datasourceName']);
      const datasources = rankAndLimit(Store.getDatasources?.() || [], query, ['name', 'type', 'host', 'database']);

      try {
        const recordPage = typeof Store.peekRecordsPage === 'function'
          ? await Store.peekRecordsPage({ search: queryText, page: 1, pageSize: 5 })
          : { items: rankAndLimit(Store.getRecords?.() || [], query, ['ruleName', 'datasetName', 'field'], 5) };
        if (sequence !== requestSequence || !panel) return;
        const records = recordPage.items || [];
        renderGroups([
          {
            label: '异常记录', items: records,
            render: item => resultMarkup('record', item, item.ruleName || item.id, `${item.datasetName || '未知数据集'} · ${item.field || '异常记录'}`, Icon.alert({ size: 16 })),
          },
          {
            label: '异常规则', items: rules,
            render: item => resultMarkup('rule', item, item.name, item.datasetName || item.description || '异常检测规则', Icon.shield({ size: 16 })),
          },
          {
            label: '数据集', items: datasets,
            render: item => resultMarkup('dataset', item, item.name, item.datasourceName || item.description || '监控数据视图', Icon.layers({ size: 16 })),
          },
          {
            label: '数据源', items: datasources,
            render: item => resultMarkup('datasource', item, item.name, `${item.type || '数据源'} · ${item.host || item.database || '连接配置'}`, Icon.database({ size: 16 })),
          },
        ]);
      } catch (error) {
        if (sequence !== requestSequence || !panel) return;
        results.removeAttribute('role');
        results.innerHTML = `<div class="command-state command-state-error">${Icon.alert({ size: 22 })}<strong>搜索暂时不可用</strong><span>${UI.escapeHtml(error.message)}</span></div>`;
        announceSearchStatus('搜索暂时不可用');
        resultItems = [];
        input?.removeAttribute('aria-activedescendant');
      }
    }

    function openSearch() {
      if (!businessShellIsVisible()) return;
      if (panel) {
        input?.focus();
        return;
      }
      restoreFocus = document.activeElement;
      panel = document.createElement('div');
      panel.className = 'command-backdrop';
      panel.innerHTML = `
        <section class="command-palette" role="dialog" aria-modal="true" aria-label="全局搜索">
          <div class="command-input-row">
            ${Icon.search({ size: 19 })}
            <input id="global-search-input" type="search" role="combobox" aria-label="全局搜索" aria-controls="global-search-results" aria-expanded="true" autocomplete="off" placeholder="搜索异常、规则、数据集或数据源…" />
            <button class="command-close" type="button" aria-label="关闭全局搜索"><kbd>Esc</kbd></button>
          </div>
          <div class="command-results" id="global-search-results"></div>
          <div class="sr-only" id="global-search-status" role="status" aria-live="polite" aria-atomic="true"></div>
          <div class="command-footer"><span><kbd>↑↓</kbd> 选择</span><span><kbd>Enter</kbd> 打开</span><span><kbd>Esc</kbd> 关闭</span></div>
        </section>
      `;
      document.body.appendChild(panel);
      input = panel.querySelector('#global-search-input');
      panel.querySelector('.command-close').addEventListener('click', closeSearch);
      panel.addEventListener('click', event => { if (event.target === panel) closeSearch(); });
      input.addEventListener('input', () => {
        window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(() => performSearch(input.value), 140);
      });
      panel.addEventListener('keydown', event => {
        if (event.key === 'Tab') {
          const focusable = [...panel.querySelectorAll('input, button:not([disabled])')].filter(el => el.offsetParent !== null);
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        } else if (event.key === 'Escape') { event.preventDefault(); closeSearch(); }
        else if (event.key === 'ArrowDown') { event.preventDefault(); setSelected(selectedIndex + 1); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setSelected(selectedIndex - 1); }
        else if (event.key === 'Enter' && selectedIndex >= 0) {
          event.preventDefault();
          const item = resultItems[selectedIndex];
          openResult(item.dataset.type, item.dataset.id);
        }
      });
      performSearch('');
      input.focus();
    }

    triggers.forEach(trigger => trigger.addEventListener('click', openSearch));
    document.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
      }
    });
  }

  // ---------- Sidebar nav wiring ----------
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.route));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(el.dataset.route); }
    });
  });

  // ---------- Mobile sidebar toggle ----------
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    const sb = document.getElementById('sidebar');
    const bd = document.getElementById('sidebar-backdrop');
    sb.classList.add('open');
    bd.classList.add('show');
  });
  document.getElementById('sidebar-backdrop').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-backdrop').classList.remove('show');
  });

  setupGlobalSearch();

  // Expose before loading so modules can navigate after async requests.
  window.App = { navigate, parseRoute };
  Store.setUnauthorizedHandler?.(showLogin);

  // ---------- Initial route ----------
  const initial = (location.hash || '#records').slice(1);
  pageRoot.innerHTML = UI.loadingState(6, 5);
  Store.init()
    .then(() => navigate(initial))
    .catch(error => {
      if (error.status === 401) showLogin();
      else showBackendFailure(error);
    });
})();
