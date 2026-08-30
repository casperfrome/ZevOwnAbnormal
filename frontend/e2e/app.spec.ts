import { expect, test, type Page } from "@playwright/test"

const admin = { id: "u1", login_name: "admin", display_name: "管理员", job_title: "平台负责人", is_superuser: true, is_active: true }
const analyst = { id: "u2", login_name: "analyst", display_name: "分析师", job_title: "风险运营", is_superuser: false, is_active: true }
const record = {
  id: "rec-1",
  rule_id: "rule-1",
  rule_name: "订单金额监控",
  dataset_name: "订单",
  severity: "high",
  status: "pending",
  business_key: { order_id: "ORDER-42" },
  row_details: { amount: 999, reviewer_id: "ou-reviewer" },
  matched_conditions: [{ field: "amount", actual: 999 }],
  hit_count: 1,
  first_seen_at: "2026-08-30T01:00:00Z",
  last_seen_at: "2026-08-30T01:00:00Z",
  resolved_at: null,
  assignee: "王敏",
  description: "订单金额异常",
  validation_deadline: "2026-08-31T01:00:00Z",
  deadline_seconds_snapshot: 86400,
  first_delivered_at: "2026-08-30T01:02:00Z",
  timed_out_at: null,
  resolution_source: null,
  resolved_by_user_id: null,
  validation_method: "pseudo",
  delivery_status: "sent",
}
const recordDetail = {
  ...record,
  last_sql_validation_result: null,
  timeline: [{ type: "detected", description: "规则命中", created_at: "2026-08-30T01:00:00Z" }],
  validation_requests: [{ recipient_user_id: "ou-reviewer", delivery_status: "sent", delivery_attempts: 1, message_id: "validation-1", last_error: null, delivered_at: "2026-08-30T01:01:00Z" }],
  deliveries: [{ receive_id_type: "open_id", recipient: "ou-owner", status: "sent", attempts: 1, message_id: "message-1", last_error: null }],
  push_jobs: [
    { id: "push-notification", kind: "notification", status: "sent", publish_attempts: 1, dispatch_attempts: 1, next_attempt_at: null, last_error: null, updated_at: "2026-08-30T01:02:00Z" },
    { id: "push-validation", kind: "validation", status: "sent", publish_attempts: 1, dispatch_attempts: 1, next_attempt_at: null, last_error: null, updated_at: "2026-08-30T01:02:00Z" },
    { id: "push-broadcast", kind: "group_broadcast", status: "sent", publish_attempts: 1, dispatch_attempts: 1, next_attempt_at: null, last_error: null, updated_at: "2026-08-30T01:02:00Z" },
  ],
  validation_submission: null,
}
const rule = {
  id: "rule-1",
  name: "订单金额监控",
  description: "检查高金额订单",
  dataset_id: "ds-1",
  dataset_name: "订单",
  severity: "high",
  logic: "AND",
  conditions: [{ field: "amount", operator: "gt", value: 100, upper_value: null, baseline: null, value_source: "literal", value_field: null, upper_value_source: "literal", upper_value_field: null }],
  anomaly_key_fields: ["order_id"],
  repeat_push_enabled: true,
  schedule: { frequency: "day", interval: 1, time: "09:00", start_date: "2026-08-30", end_date: null },
  notification_targets: [{ receive_id_type: "user_id", source: "literal", value: "owner", field: null }],
  private_message_template: "订单 {order_id} 金额异常",
  validation_enabled: false,
  validation_targets: [],
  deadline_seconds: 86400,
  validation_method: "pseudo",
  sql_validation_config: null,
  group_broadcast: {
    enabled: true,
    webhook_url: "https://open.feishu.cn/open-apis/bot/v2/hook/example",
    mention_targets: [{ source: "field", field: "reviewer_id", value: null }],
    message_template: "异常 {order_id列表}",
    situation: { enabled: true, mention_targets: [{ source: "field", field: "reviewer_id", value: null }], message_template: "异常 {order_id列表}" },
    timeout: { enabled: false, mention_targets: [], message_template: null },
  },
  enabled: true,
  sync_status: "synced",
  sync_error: null,
  ds_workflow_code: "workflow-1",
  ds_schedule_id: 101,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-30T00:30:00Z",
}
const dataset = {
  id: "ds-1",
  name: "订单",
  datasource_id: "source-1",
  datasource_name: "生产库",
  description: "订单监控视图",
  sql: "select order_id, amount, reviewer_id from orders",
  fields: [{ name: "order_id", type: "VARCHAR" }, { name: "amount", type: "DECIMAL" }, { name: "reviewer_id", type: "VARCHAR" }],
  row_count: 120,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-30T00:00:00Z",
}
const datasource = {
  id: "source-1",
  name: "生产库",
  type: "mysql",
  host: "db.internal",
  port: 3306,
  database: "app",
  username: "reader",
  ssl: true,
  description: "只读生产副本",
  status: "online",
  last_checked: "2026-08-30T00:00:00Z",
  error_message: null,
  has_password: true,
}
const group = {
  group_id: "group-1",
  rule_id: "rule-1",
  rule_name: "订单金额监控",
  detected_at: "2026-08-30T01:00:00Z",
  scanned_rows: 120,
  matched_rows: 8,
  new_anomalies: 3,
  status_counts: { pending: 2, processing: 1, resolved: 4, timed_out: 1 },
  broadcast_status: "sent",
  situation_broadcast_status: "sent",
  timeout_broadcast_status: "waiting",
  timeout_waiting_count: 5,
  timeout_waiting_delivery_count: 6,
}
const groupRecords = ["pending", "pending", "processing", "resolved", "resolved", "resolved", "resolved", "timed_out"].map((status, index) => ({
  ...record,
  id: index === 0 ? "rec-1" : `rec-${index + 1}`,
  status,
  business_key: { order_id: `ORDER-${42 + index}` },
  description: `订单 ${42 + index} 金额异常`,
}))

const consoleFailures = new WeakMap<Page, string[]>()

async function installApiFixtures(page: Page, currentUser = admin, pendingCount = 1) {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    let body: unknown

    if (path === "/api/v1/auth/me" || path === "/api/v1/auth/login") body = currentUser
    else if (path === "/api/v1/rules") body = [rule]
    else if (path === "/api/v1/datasets") body = [dataset]
    else if (path === "/api/v1/datasources") body = [datasource]
    else if (path === "/api/v1/anomalies/rec-1") body = recordDetail
    else if (path === "/api/v1/anomalies") {
      const status = url.searchParams.get("status_filter")
      const severity = url.searchParams.get("severity")
      const isCount = url.searchParams.get("page_size") === "1"
      const matches = pendingCount > 0 && (!status || status === "pending") && (!severity || severity === "high")
      body = { items: isCount ? [] : matches ? [record] : [], total: matches ? pendingCount : 0, page: 1, page_size: Number(url.searchParams.get("page_size") ?? 20) }
    }
    else if (path === "/api/v1/anomaly-groups/group-1") body = {
      group,
      deliveries: [{ id: "broadcast-1", broadcast_kind: "situation", round_index: 0, part_index: 1, total_parts: 1, status: "sent", attempts: 1, last_error: null, delivered_at: "2026-08-30T01:02:00Z" }],
      items: groupRecords,
      total: groupRecords.length,
      page: 1,
      page_size: 20,
    }
    else if (path === "/api/v1/anomaly-groups") body = { items: [group], total: 1, page: 1, page_size: 20 }
    else if (path === "/api/v1/accounts") body = [admin, analyst]
    else if (path === "/api/v1/overview") {
      const overviewDays = Number(url.searchParams.get("days") ?? 30)
      const endDate = Date.UTC(2026, 7, 30)
      body = {
        stats: {
          pending_records: 1,
          processing_records: 0,
          timed_out_records: 0,
          resolved_records: 4,
          high_anomalies: 1,
          critical_anomalies: 1,
          push_in_transit_anomalies: 0,
          active_rules: 1,
          total_rules: 1,
          online_datasources: 1,
          total_datasources: 1,
          total_datasets: 1,
        },
        trend: Array.from({ length: overviewDays }, (_, index) => ({
          date: new Date(endDate - (overviewDays - index - 1) * 86_400_000).toISOString().slice(0, 10),
          count: index === overviewDays - 2 ? 2 : index === overviewDays - 1 ? 1 : 0,
        })),
        recent_anomalies: [record],
        top_rules: [{ id: "rule-1", name: "订单金额监控", dataset_name: "订单", anomaly_count: 1 }],
        days: overviewDays,
        timezone: "Asia/Shanghai",
      }
    }
    else throw new Error(`Unhandled API fixture: ${route.request().method()} ${url.pathname}${url.search}`)

    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
  })
}

async function assertRouteHealth(page: Page) {
  const text = await page.locator("body").innerText()
  expect(text).not.toContain("[object Object]")

  const pendingBadge = page.locator('[aria-label$="条待处理异常"]')
  const pendingBadgeCount = await pendingBadge.count()
  expect(pendingBadgeCount).toBeLessThanOrEqual(1)
  if (pendingBadgeCount === 1) await expect(pendingBadge).toHaveText(/^\d+$/)

  const layout = await page.evaluate(() => {
    const documentOverflow = document.documentElement.scrollWidth - window.innerWidth
    const unreachable = Array.from(document.querySelectorAll<HTMLElement>("main a, main button, main input, main select, main textarea, main [tabindex]:not([tabindex='-1']), header a, header button, header input"))
      .filter((element) => {
        const rect = element.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return false
        const style = getComputedStyle(element)
        if (style.display === "none" || style.visibility === "hidden") return false
        if (rect.right > 0 && rect.left < window.innerWidth) return false
        let ancestor = element.parentElement
        while (ancestor) {
          const overflow = getComputedStyle(ancestor).overflowX
          if ((overflow === "auto" || overflow === "scroll") && ancestor.scrollWidth > ancestor.clientWidth) return false
          ancestor = ancestor.parentElement
        }
        return true
      })
      .map((element) => element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 80) || element.tagName)
    return { documentOverflow, unreachable }
  })

  expect(layout.documentOverflow).toBeLessThanOrEqual(1)
  expect(layout.unreachable).toEqual([])
}

async function assertRecordNavigationHasNoDecorativeDot(page: Page, expectedCount: number | null, mobile: boolean) {
  const link = page.locator('a.app-nav-item[href="#records"]')
  if (mobile && !await link.isVisible()) await page.getByRole("button", { name: "打开导航" }).click()
  await expect(link).toBeVisible()

  const navItem = link.locator("xpath=..")
  const badges = navItem.locator('[data-sidebar="menu-badge"]')
  await expect(badges).toHaveCount(expectedCount === null ? 0 : 1)
  if (expectedCount !== null) {
    await expect(badges).toHaveAttribute("aria-label", `${expectedCount} 条待处理异常`)
    await expect(badges).toHaveText(new RegExp(`^${expectedCount}$`))
  }

  const decorativeDots = await navItem.evaluate((item) => {
    const forbidden = /[•·●]|(?:^|[\s"'(])dot(?:$|[\s"')])/i
    const isTransparent = (color: string) => color === "transparent" || /rgba\([^)]*,\s*0(?:\.0+)?\)$/.test(color) || /\/\s*0(?:\.0+)?\)$/.test(color)
    const radiusPixels = (value: string, size: number) => {
      const token = value.split(/[ /]/)[0]
      return token.endsWith("%") ? Number.parseFloat(token) * size / 100 : Number.parseFloat(token)
    }
    const paintedRoundShape = (style: CSSStyleDeclaration, width: number, height: number) => {
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2 || width > 12 || height > 12) return false
      const ratio = width / height
      if (ratio < 0.75 || ratio > 1.33 || style.visibility === "hidden" || style.display === "none" || Number.parseFloat(style.opacity || "1") <= 0.05) return false
      const size = Math.min(width, height)
      const rounded = Math.max(
        radiusPixels(style.borderTopLeftRadius, size),
        radiusPixels(style.borderTopRightRadius, size),
        radiusPixels(style.borderBottomRightRadius, size),
        radiusPixels(style.borderBottomLeftRadius, size),
      ) >= size * 0.35
      const hasBackground = !isTransparent(style.backgroundColor)
      const hasBorder = ["Top", "Right", "Bottom", "Left"].some((side) =>
        Number.parseFloat(style[`border${side}Width` as keyof CSSStyleDeclaration] as string) > 0
        && !isTransparent(style[`border${side}Color` as keyof CSSStyleDeclaration] as string),
      )
      return rounded && (hasBackground || hasBorder)
    }
    const textNodes: string[] = []
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const value = walker.currentNode.textContent ?? ""
      if (forbidden.test(value)) textNodes.push(`${walker.currentNode.parentElement?.tagName.toLowerCase() ?? "text"} text: ${value}`)
    }
    const shapeDecorations: string[] = []
    const elementDecorations = [item, ...item.querySelectorAll("*")].flatMap((node) => {
      const element = node as HTMLElement
      const tag = element.tagName.toLowerCase()
      const isSvgIcon = tag === "svg" || Boolean(element.closest("svg"))
      const elementStyle = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      const isEmptyElement = !element.textContent?.trim() && !element.getAttribute("aria-label")
      if (!isSvgIcon && isEmptyElement && paintedRoundShape(elementStyle, rect.width, rect.height)) {
        shapeDecorations.push(`${tag} element shape: ${rect.width}x${rect.height}`)
      }
      for (const pseudo of ["::before", "::after"] as const) {
        const pseudoStyle = getComputedStyle(element, pseudo)
        const generatedEmptyContent = pseudoStyle.content === '""' || pseudoStyle.content === "''"
        if (!isSvgIcon && generatedEmptyContent && paintedRoundShape(pseudoStyle, Number.parseFloat(pseudoStyle.width), Number.parseFloat(pseudoStyle.height))) {
          shapeDecorations.push(`${tag} ${pseudo} shape: ${pseudoStyle.width}x${pseudoStyle.height}`)
        }
      }
      const candidates = [
        ["aria-label", element.getAttribute("aria-label") ?? ""],
        ["::before", getComputedStyle(element, "::before").content],
        ["::after", getComputedStyle(element, "::after").content],
      ] as const
      return candidates
        .filter(([, value]) => forbidden.test(value))
        .map(([source, value]) => `${element.tagName.toLowerCase()} ${source}: ${value}`)
    })
    return [...textNodes, ...elementDecorations, ...shapeDecorations]
  })
  expect(decorativeDots).toEqual([])
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  consoleFailures.set(page, errors)
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
  page.on("pageerror", (error) => errors.push(error.message))
  await installApiFixtures(page)
})

test.afterEach(async ({ page }) => {
  expect(consoleFailures.get(page) ?? []).toEqual([])
})

const primaryRoutes = [
  { route: "records", heading: "异常记录", loaded: (page: Page) => page.getByRole("button", { name: "查看 rec-1 详情" }) },
  { route: "anomaly-groups", heading: "异常记录组", loaded: (page: Page) => page.getByRole("button", { name: "查看 订单金额监控 记录组" }) },
  { route: "rules", heading: "异常规则", loaded: (page: Page) => page.getByRole("button", { name: "订单金额监控", exact: true }) },
  { route: "datasets", heading: "数据集", loaded: (page: Page) => page.getByRole("button", { name: "编辑 订单" }) },
  { route: "datasources", heading: "数据源", loaded: (page: Page) => page.getByRole("button", { name: "测试 生产库" }) },
  { route: "overview", heading: "总览", loaded: (page: Page) => page.getByText("高风险未解决 1") },
  { route: "tests", heading: "系统测试", loaded: (page: Page) => page.getByRole("button", { name: "发送测试消息" }) },
  { route: "accounts", heading: "账号管理", loaded: (page: Page) => page.getByRole("button", { name: "编辑 管理员" }) },
  { route: "account", heading: "个人账号", loaded: (page: Page) => page.getByLabel("显示名称"), value: "管理员" },
] as const

for (const routeCase of primaryRoutes) {
  const { route, heading, loaded } = routeCase
  test(`keeps the ${route} route accessible and within the viewport`, async ({ page }) => {
    await page.goto(`/#${route}`)
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible()
    if ("value" in routeCase) await expect(loaded(page)).toHaveValue(routeCase.value)
    else await expect(loaded(page)).toBeVisible()
    await assertRouteHealth(page)
  })
}

test("uses only an accessible numeric record-navigation badge, never a decorative dot", async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === "mobile"
  await page.goto("/#records")
  await expect(page.getByRole("button", { name: "查看 rec-1 详情" })).toBeVisible()
  await assertRecordNavigationHasNoDecorativeDot(page, 1, mobile)

  await page.unroute("**/api/v1/**")
  await installApiFixtures(page, admin, 0)
  await page.reload()
  await expect(page.getByText("暂无匹配的异常记录")).toBeVisible()
  await assertRecordNavigationHasNoDecorativeDot(page, null, mobile)
})

test("supports record, group, rule and dataset deep links", async ({ page }) => {
  const deepLinks = [
    { route: "records/rec-1", heading: "异常记录详情", loaded: async (page: Page) => { await expect(page.getByRole("heading", { name: "推送诊断" })).toBeVisible(); await expect(page.getByText("通知推送")).toBeVisible() } },
    { route: "anomaly-groups/group-1", heading: "异常记录组详情", loaded: async (page: Page) => { await expect(page.getByRole("heading", { name: "组内异常记录" })).toBeVisible(); await expect(page.getByText("order_id: ORDER-42")).toBeVisible() } },
    { route: "rules/rule-1/edit", heading: "编辑异常规则", loaded: async (page: Page) => { await expect(page.getByLabel("描述")).toHaveValue("检查高金额订单") } },
    { route: "datasets/ds-1/edit", heading: "编辑数据集", loaded: async (page: Page) => { await expect(page.getByLabel("SQL")).toHaveValue("select order_id, amount, reviewer_id from orders") } },
  ] as const

  for (const { route, heading, loaded } of deepLinks) {
    await page.goto(`/#${route}`)
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible()
    await loaded(page)
    expect(new URL(page.url()).hash).toBe(`#${route}`)
    await assertRouteHealth(page)
  }
})

test("restores focus when Escape closes record details and global search", async ({ page }) => {
  await page.goto("/#records")
  const detailTrigger = page.getByRole("button", { name: "查看 rec-1 详情" })
  await detailTrigger.click()
  await expect(page.getByRole("heading", { name: "异常记录详情" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("heading", { name: "异常记录详情" })).toBeHidden()
  await expect(detailTrigger).toBeFocused()
  expect(new URL(page.url()).hash).toBe("#records")

  const searchTrigger = page.getByRole("button", { name: /搜索规则、数据集|打开全局搜索/ })
  await searchTrigger.click()
  await expect(page.getByPlaceholder("搜索规则、数据集或页面…")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByPlaceholder("搜索规则、数据集或页面…")).toBeHidden()
  await expect(searchTrigger).toBeFocused()

  await searchTrigger.click()
  await page.getByPlaceholder("搜索规则、数据集或页面…").fill("订单金额监控")
  await page.getByRole("option", { name: /订单金额监控/ }).click()
  await expect(page.getByRole("heading", { name: "编辑异常规则" })).toBeVisible()
})

test("keeps each rule switch aligned with its rule title", async ({ page }) => {
  await page.goto("/#rules")
  const ruleRow = page.getByRole("row").filter({ hasText: "订单金额监控" })
  const switchBox = await ruleRow.getByRole("switch", { name: "启用/停用 订单金额监控" }).boundingBox()
  const titleBox = await ruleRow.getByRole("button", { name: "订单金额监控", exact: true }).boundingBox()
  expect(switchBox).not.toBeNull()
  expect(titleBox).not.toBeNull()
  expect(Math.abs(switchBox!.y - titleBox!.y)).toBeLessThanOrEqual(1)
})

test("keeps complete rule drafts and editor controls reachable across tabs", async ({ page }) => {
  await page.goto("/#rules/rule-1/edit")
  const description = page.getByLabel("描述")
  await description.fill("尚未保存的跨分区草稿")
  await page.getByRole("tab", { name: "2 触发条件" }).click()
  await expect(page.getByLabel("条件 1 字段")).toContainText("amount")
  await page.getByRole("tab", { name: "4 异常键" }).click()
  await expect(page.getByRole("checkbox", { name: /order_id/ })).toBeChecked()
  await expect(page.getByText("允许重复推送")).toBeVisible()
  await page.getByRole("tab", { name: "1 基本信息" }).click()
  await expect(description).toHaveValue("尚未保存的跨分区草稿")
  await expect(page.getByRole("button", { name: "保存规则" })).toBeVisible()
  await page.getByRole("tab", { name: "7 群广播" }).click()
  await expect(page.getByLabel("群机器人 Webhook")).toHaveValue(/open\.feishu\.cn/)
})

test("keeps readable record operations in both responsive layouts", async ({ page }, testInfo) => {
  await page.goto("/#records")
  if (testInfo.project.name === "desktop") {
    await expect(page.getByRole("columnheader", { name: "异常字段 / 值" })).toBeVisible()
    await expect(page.getByRole("columnheader", { name: "处理人" })).toBeVisible()
    await expect(page.getByText("order_id: ORDER-42").first()).toBeVisible()
  } else {
    await expect(page.getByText(/字段：amount: 999/)).toBeVisible()
    await expect(page.getByText(/处理人：王敏/)).toBeVisible()
    await expect(page.getByRole("button", { name: "查看 rec-1 详情" })).toBeVisible()
  }
})

test("exposes every rule icon action to hover and keyboard focus", async ({ page }) => {
  for (const label of ["立即执行 订单金额监控", "同步调度 订单金额监控", "编辑 订单金额监控", "删除 订单金额监控"]) {
    await page.goto("/#rules")
    const action = page.getByRole("button", { name: label })
    await expect(action).toBeVisible()
    await action.focus()
    await expect(action).toBeFocused()
    await expect(page.getByRole("tooltip", { name: label })).toBeVisible()
    await action.evaluate((element) => element.blur())
    await expect(page.getByRole("tooltip", { name: label })).toBeHidden()
    await action.hover()
    await expect(page.getByRole("tooltip", { name: label })).toBeVisible()
  }
})

test("shows complete record-group summaries and keyboard-reachable members", async ({ page }) => {
  await page.goto("/#anomaly-groups")
  const groupTrigger = page.getByRole("button", { name: "查看 订单金额监控 记录组" })
  await expect(groupTrigger.getByText("120 / 8 / 3")).toBeVisible()
  await expect(groupTrigger.getByText(/待处理 2 · 处理中 1 · 已解决 4 · 已超时 1 · 超时待播报 5 · 超时待投递 6/)).toBeVisible()
  await groupTrigger.focus()
  await groupTrigger.press("Enter")
  await expect(page.getByRole("heading", { name: "异常记录组详情" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "组内异常记录" })).toBeVisible()
  await expect(page.getByText("order_id: ORDER-42")).toBeVisible()
  await expect(page.getByRole("cell", { name: "异常情况播报" })).toBeVisible()
})

test("redirects regular users away from administrator deep links", async ({ page }) => {
  await page.unroute("**/api/v1/**")
  await installApiFixtures(page, analyst)

  for (const restrictedRoute of ["tests", "accounts"]) {
    await page.goto("/#overview")
    await page.goto(`/#${restrictedRoute}`)
    await expect(page).toHaveURL(/#records$/)
    await expect(page.getByRole("heading", { name: "异常记录", exact: true })).toBeVisible()
    await expect(page.getByRole("navigation", { name: "breadcrumb" }).getByRole("link", { name: "异常记录" })).toHaveAttribute("aria-current", "page")
    await expect(page.getByRole("link", { name: /系统测试/ })).toHaveCount(0)
    await expect(page.getByRole("link", { name: /账号管理/ })).toHaveCount(0)
    await page.goBack()
    await expect(page).toHaveURL(/#overview$/)
  }
})

test("keeps interactive overlays compatible with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/#overview")
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true)
  await expect(page.getByRole("heading", { name: "总览", exact: true })).toBeVisible()
  await expect(page.getByText("高风险未解决 1")).toBeVisible()

  const searchTrigger = page.getByRole("button", { name: /搜索规则、数据集|打开全局搜索/ })
  const durations = await searchTrigger.evaluate((element) => {
    const maximumMilliseconds = (value: string) => Math.max(...value.split(",").map((part) => {
      const token = part.trim()
      return token.endsWith("ms") ? Number.parseFloat(token) : Number.parseFloat(token) * 1000
    }))
    const style = getComputedStyle(element)
    return {
      animationMilliseconds: maximumMilliseconds(style.animationDuration),
      transitionMilliseconds: maximumMilliseconds(style.transitionDuration),
    }
  })
  expect(durations.animationMilliseconds).toBeLessThanOrEqual(0.02)
  expect(durations.transitionMilliseconds).toBeLessThanOrEqual(0.02)
  await searchTrigger.click()
  await expect(page.getByPlaceholder("搜索规则、数据集或页面…")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(searchTrigger).toBeFocused()
})
