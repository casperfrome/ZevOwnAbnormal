/* ============================================================
   app.js — SPA router, sidebar wiring, topbar wiring
   ============================================================ */
(function () {
  const routes = {
    records:    { title: '异常记录',    desc: '系统检测到的所有数据异常事件', module: 'RecordsModule' },
    rules:      { title: '异常规则',    desc: '配置数据质量检测规则与通知策略', module: 'RulesModule' },
    datasets:   { title: '数据集',      desc: '基于 SQL 的监控数据视图', module: 'DatasetModule' },
    datasources:{ title: '数据源',      desc: '管理 MySQL 与 StarRocks 连接', module: 'DatasourceModule' },
    overview:   { title: '总览',        desc: '平台运行状态全景', module: 'OverviewModule' },
    tests:      { title: '测试',        desc: '验证系统集成与消息通知链路', module: 'TestsModule' },
  };

  const pageRoot = document.getElementById('page-root');
  const breadcrumb = document.getElementById('breadcrumb');

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
    if (parts[0] === 'records' && parts[1]) {
      try { detailId = decodeURIComponent(parts.slice(1).join('/')); }
      catch (_) { detailId = parts.slice(1).join('/'); }
    }
    return { route, detailId };
  }

  function navigate(target) {
    const { route, detailId } = parseRoute(target);
    const hash = detailId ? `#records/${encodeURIComponent(detailId)}` : '#' + route;
    history.replaceState(null, '', hash);
    renderRoute(route);
    if (detailId && window.RecordsModule && typeof RecordsModule.openDetail === 'function') {
      Promise.resolve().then(() => RecordsModule.openDetail(detailId));
    }
    // Close mobile sidebar
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-backdrop').classList.remove('show');
    window.scrollTo({ top: 0, behavior: 'instant' });
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

  // Expose before loading so modules can navigate after async requests.
  window.App = { navigate, parseRoute };

  // ---------- Initial route ----------
  const initial = (location.hash || '#records').slice(1);
  pageRoot.innerHTML = UI.loadingState(6, 5);
  Store.init()
    .then(() => navigate(initial))
    .catch(error => {
      pageRoot.innerHTML = UI.emptyState({ icon: Icon.alert({ size: 24 }), iconCls: 'danger', title: '后端连接失败', desc: error.message });
      UI.toast({ type: 'error', title: '无法加载平台数据', desc: error.message });
    });
})();
