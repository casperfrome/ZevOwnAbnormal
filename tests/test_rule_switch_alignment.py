from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]


def render_rules_page(page):
    page.set_content('<main><div id="actions"></div><div id="content"></div></main>')
    for stylesheet in ("base.css", "components.css", "pages.css"):
        page.add_style_tag(path=str(ROOT / "frontend" / "styles" / stylesheet))
    page.add_script_tag(
        content="""
              window.Icon = new Proxy({}, {
                get: () => ({ size = 16 } = {}) =>
                  `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"></svg>`,
              });
              window.UI = {
                escapeHtml: value => String(value),
                formatTime: () => '—',
                severityBadge: severity => `<span>${severity}</span>`,
                renderPagination: () => '',
                emptyState: () => '',
              };
              const rules = [
                {
                  id: 'disabled-rule', name: '无描述规则', description: '',
                  datasetName: '配送车辆温度', severity: 'medium', enabled: false,
                  anomalyCount: 0, lastRun: null,
                  schedule: { frequency: 'day', interval: 1, time: '09:00' },
                },
                {
                  id: 'enabled-rule', name: '带描述规则', description: '规则描述',
                  datasetName: '配送车辆温度', severity: 'high', enabled: true,
                  anomalyCount: 1, lastRun: null,
                  schedule: { frequency: 'hour', interval: 1, time: null },
                },
              ];
              window.Store = {
                getRules: () => rules,
                getRule: id => rules.find(rule => rule.id === id),
                getStats: () => ({ pushInTransitAnomalies: 0 }),
              };
        """
    )
    page.add_script_tag(path=str(ROOT / "frontend" / "scripts" / "rules.js"))
    page.evaluate(
        """RulesModule.render(
              document.getElementById('content'),
              { actionsEl: document.getElementById('actions') }
            )"""
    )


def test_rule_switches_are_vertically_centered_in_their_cells():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        render_rules_page(page)

        alignment = page.locator('#r-table tbody tr').evaluate_all(
            """rows => rows.map(row => {
              const cell = row.querySelector('td.rule-toggle-cell');
              const wrapper = cell?.querySelector('.rule-toggle-align');
              const toggle = wrapper?.querySelector('.switch');
              if (!cell || !wrapper || !toggle) return null;
              const wrapperStyle = getComputedStyle(wrapper);
              const wrapperBox = wrapper.getBoundingClientRect();
              const toggleBox = toggle.getBoundingClientRect();
              return {
                display: wrapperStyle.display,
                alignItems: wrapperStyle.alignItems,
                centerOffset: Math.abs(
                  (toggleBox.top + toggleBox.height / 2) -
                  (wrapperBox.top + wrapperBox.height / 2)
                ),
              };
            })"""
        )

        browser.close()

    assert alignment
    assert all(item is not None for item in alignment)
    assert all(item["display"] == "flex" for item in alignment)
    assert all(item["alignItems"] == "center" for item in alignment)
    assert max(item["centerOffset"] for item in alignment) <= 1
