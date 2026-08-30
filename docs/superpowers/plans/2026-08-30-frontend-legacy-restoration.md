# Frontend Legacy Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` for behavior changes and `superpowers:verification-before-completion` before reporting completion. Do not spawn subagents.

**Goal:** Restore the pre-React frontend's visual system, information density, and user-facing capabilities while retaining the current React, TypeScript, React Query, and shadcn architecture.

**Architecture:** Commit `1eea019` is the visual and behavioral reference. Normalize backend responses in `frontend/src/api`, compose installed shadcn primitives through focused shared components, and keep page state/query ownership inside each React page.

**Tech Stack:** React 19, TypeScript, React Query, Vite, Tailwind CSS v4, shadcn/Radix, Vitest, Playwright.

## Global Constraints

- Keep every existing backend route, payload, database model, and hash deep link compatible.
- Use the warm paper canvas, dark 248px sidebar, 72px top bar, indigo primary, coral anomaly accent, and compact operating-console density from commit `1eea019`.
- Never render `[object Object]`; object business keys must have a stable readable summary and full JSON in detail views.
- Navigation badges show real counts or stay hidden; never show decorative dots.
- Display backend enum/status values with Chinese user-facing labels.
- Desktop tables stay information-dense; narrow screens use readable cards/drawers without clipped actions.
- All icon-only actions require an accessible name, visible tooltip/hover, and keyboard focus.
- Use `D:\PythonVenv\Scripts\python.exe` for Python verification.

---

### Task 1: Data contracts, formatting, design foundation, and application shell

**Files:**
- Modify: `frontend/src/api/types.ts`, `frontend/src/api/resources.ts`, `frontend/src/lib/format.ts`
- Modify: `frontend/src/index.css`, `frontend/src/App.tsx`, `frontend/src/components/shared.tsx`
- Test: `frontend/src/api/resources.test.ts`, `frontend/src/lib/format.test.ts`, `frontend/src/App.test.tsx`

**Requirements:**
- Add explicit normalized record/group/detail/delivery/overview types and mappers.
- Format object business keys as readable field/value summaries and keep JSON-safe detail formatting.
- Restore the legacy design tokens, typography stack, content widths, spacing, side navigation, active rail, top bar, and mobile sidebar behavior.
- Replace the hard-coded record dot with the real pending count loaded from `/anomalies?page=1&page_size=1&status_filter=pending` and hide it when zero or unavailable.
- Expand shared components with Chinese status labels, statistic cards, detail rows/sections, pagination, and tooltip composition needed by later tasks.
- Add failing unit/component tests first and record the red/green commands.

### Task 2: Restore anomaly records and anomaly groups

**Files:**
- Modify: `frontend/src/pages/records.tsx`, `frontend/src/pages/groups.tsx`
- Modify if needed: `frontend/src/api/types.ts`, `frontend/src/api/resources.ts`, `frontend/src/components/shared.tsx`
- Test: relevant Vitest tests and `frontend/e2e/app.spec.ts`

**Requirements:**
- Records: summary metrics/tabs, debounced server search, status/severity/rule filters, server sorting, scoped selection, bulk status changes, selected/current-filter export, pagination, resizable dense desktop table, mobile cards, and safe concurrent query/mutation behavior.
- Record columns: anomaly/business key, severity, rule, anomalous field/value, status, occurred time, assignee, actions.
- Record detail sections: basic information, validation audit, push diagnostics, anomaly data, business key and deliveries, processing timeline.
- Groups list: rule, detection time, scanned/matched/new counts, processing status counts, situation broadcast, timeout broadcast, keyboard-openable rows, and pagination.
- Group detail: overview, delivery diagnostics, paginated member records, and links to record details.
- Tests must prove object keys are readable, group summary fields are present, deep links work, and mobile actions are not clipped.

### Task 3: Restore rule list and full rule editor

**Files:**
- Modify: `frontend/src/pages/rules.tsx`
- Modify if needed: `frontend/src/api/types.ts`, `frontend/src/api/resources.ts`, `frontend/src/components/shared.tsx`
- Test: relevant Vitest tests and `frontend/e2e/app.spec.ts`

**Requirements:**
- Rule list: statistics, search, schedule summary, enable/disable, execute, sync, delete, pending states, and tooltips/hover for every icon action.
- Editor sections: basic info, condition logic with literal/field operands and bounds, schedule preview, accessible anomaly-key multi-selection, repeat push, deadline, pseudo/SQL validation, validation datasource/parameter mappings, notification targets, template parameter insertion, situation broadcast, timeout broadcast, webhook, mention targets.
- Preserve drafts across tabs. Saving invalid data opens and focuses the owning tab/field. Mobile keeps tabs and save/cancel actions reachable.
- Round-trip all currently supported backend fields without weakening backend validation.

### Task 4: Restore datasets, datasources, overview, system, and accounts

**Files:**
- Modify: `frontend/src/pages/datasets.tsx`, `frontend/src/pages/datasources.tsx`, `frontend/src/pages/overview.tsx`, `frontend/src/pages/system.tsx`
- Modify if needed: `frontend/src/api/types.ts`, `frontend/src/api/resources.ts`, `frontend/src/components/shared.tsx`
- Test: relevant Vitest tests and `frontend/e2e/app.spec.ts`

**Requirements:**
- Datasets: search, deep-link editor, SQL server validation, execution preview, result table, and safe CSV export.
- Datasources: search, connection tests, immutable type during edit, blank-password preservation, status, and protected deletion.
- Overview: range selection, refresh, authoritative statistics, trend/severity visualization, recent anomalies, and top rules without fabricated health data.
- System: Feishu test and confirmed administrator push queue recovery/cleanup/abort actions.
- Account: profile/credential update. Account management: search, create, edit/enable state, reset password, delete, and admin-only visibility.

### Task 5: Responsive, accessibility, regression, and final verification

**Files:**
- Modify: `frontend/e2e/app.spec.ts`, focused frontend unit tests, and only production files required by failing regressions.

**Requirements:**
- Add desktop and Pixel 7 coverage for every primary route.
- Assert no visible `[object Object]`, no decorative navigation dot, real-or-hidden count badge, visible rule action hover/tooltip/focus, complete group information, no horizontal viewport overflow, and reachable controls.
- Verify deep links, Escape/focus behavior, role restrictions, reduced motion, and console errors.
- Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:e2e`, and `D:\PythonVenv\Scripts\python.exe -m pytest backend/tests`.
- Review `git diff`, commit the finished work, and push `main`.
