import { expect, test } from "@playwright/test"

const user = { id: "u1", login_name: "admin", display_name: "管理员", job_title: "平台负责人", is_superuser: true, is_active: true }
const record = { id: "rec-1", title: "订单金额异常", anomaly_key: "ORDER-42", rule_id: "rule-1", rule_name: "订单金额监控", severity: "high", status: "pending", detected_at: "2026-08-30T01:00:00Z", data: { amount: 999 } }

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    let body: unknown = {}
    if (path.endsWith("/auth/me") || path.endsWith("/auth/login")) body = user
    else if (path === "/api/v1/rules") body = [{ id: "rule-1", name: "订单金额监控", dataset_id: "ds-1", dataset_name: "订单", severity: "high", logic: "AND", conditions: [], enabled: true }]
    else if (path === "/api/v1/datasets") body = [{ id: "ds-1", name: "订单", datasource_id: "source-1", datasource_name: "生产库", sql: "select * from orders" }]
    else if (path === "/api/v1/datasources") body = [{ id: "source-1", name: "生产库", type: "mysql", host: "db", port: 3306, database: "app", username: "reader", ssl: false, status: "online" }]
    else if (path === "/api/v1/anomalies/rec-1") body = record
    else if (path === "/api/v1/anomalies") body = { items: [record], total: 1, page: 1, page_size: 20 }
    else if (path === "/api/v1/anomaly-groups") body = { items: [], total: 0, page: 1, page_size: 50 }
    else if (path === "/api/v1/accounts") body = [user]
    else if (path === "/api/v1/overview") body = { stats: { pending_records: 1, active_rules: 1, online_datasources: 1 } }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
  })
})

test("supports authenticated navigation, global search and record deep links", async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
  await page.goto("/#records/rec-1")
  await expect(page.getByRole("heading", { name: "异常记录" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "异常记录详情" })).toBeVisible()
  await page.keyboard.press("Escape")
  await page.keyboard.press("Control+k")
  await expect(page.getByPlaceholder("搜索规则、数据集或页面…")).toBeVisible()
  await page.getByPlaceholder("搜索规则、数据集或页面…").fill("订单金额监控")
  await page.getByRole("option", { name: /订单金额监控/ }).click()
  await expect(page.getByRole("heading", { name: "编辑异常规则" })).toBeVisible()
  await expect(page.getByText("7 群广播")).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("rule-editor.png"), fullPage: true })
  expect(errors).toEqual([])
})

test("keeps administrator routes reachable on narrow screens", async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
  await page.goto("/#accounts")
  await expect(page.getByRole("heading", { name: "账号管理" })).toBeVisible()
  await expect(page.getByText("管理员").first()).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("accounts.png"), fullPage: true })
  expect(errors).toEqual([])
})
