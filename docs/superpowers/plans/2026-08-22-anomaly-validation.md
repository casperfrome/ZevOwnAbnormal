# Anomaly Real-time Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use test-driven development. Work only in `D:\260809\.worktrees\anomaly-validation`, do not spawn subagents, commit your task, and report exact test commands/results.

**Goal:** Add Feishu interactive-card validation where the first configured recipient to submit non-empty text resolves the anomaly, with persistence, timeout handling, deep links, and synchronized card closure.

**Architecture:** Rules own validation configuration. Anomalies snapshot the description, recipients, and deadline. A validation service owns target resolution, delivery, first-writer-wins submission, state transitions, timeouts, and card reconciliation. The Feishu WebSocket launcher forwards normalized callbacks to an internal FastAPI endpoint.

**Tech Stack:** FastAPI, SQLAlchemy 2, Alembic, MySQL/SQLite tests, httpx, lark-oapi 1.7.2, static HTML/CSS/JavaScript, Node test runner and Playwright.

## Global Constraints

- Valid states are `pending`, `processing`, `timed_out`, and terminal `resolved`.
- Only a successful validation submission or an administrator manual resolve may enter `resolved`.
- Validation text is trimmed, required, and limited to 1-1000 characters.
- Timeout range is 1-43200 minutes with a 1440-minute default.
- Targets are `user_id` values from N literal values and/or N anomaly-row fields; blank values are skipped and duplicates removed in configured order.
- Exactly one official submission may exist per anomaly; the first valid concurrent submitter wins.
- Historical rules default to validation disabled, and historical anomalies receive no retroactive deadline.
- `753f6bdf` is only a manual acceptance target and must not be hardcoded in production behavior.
- Store naive UTC datetimes, matching the existing project convention.

---

### Task 1: Persistence and API Contracts

Add tests first, verify they fail, then implement:

- Extend `Rule` with `validation_enabled`, `validation_targets`, and `validation_timeout_minutes`.
- Extend `AnomalyRecord` with `description`, `validation_deadline`, `timed_out_at`, `resolution_source`, and `resolved_by_user_id`.
- Add `AnomalyValidationRequest` and `AnomalyValidationSubmission` models. Requests are unique per anomaly/recipient. Submissions are unique per anomaly and store request, submitter user ID, original trimmed text, validator type `pseudo`, result `passed`, and submitted time.
- Add an Alembic migration after `20260809_0001`; existing rows remain validation-disabled/no deadline.
- Add Pydantic target/config/callback contracts. Validation enabled requires at least one target; literal targets require `value`, field targets require `field`; timeout is 1-43200.
- Extend rule/anomaly serialization contracts without removing existing fields.

Run focused model/schema/API tests and the existing backend suite. Commit the task.

### Task 2: Validation Domain Service and Feishu Cards

Add tests first, verify they fail, then implement:

- Create a focused validation service that resolves/deduplicates literal and field targets, snapshots description/deadline, creates requests, validates pseudo submissions, applies the state machine, expires due anomalies idempotently, and records timeline events.
- Use a database lock plus the unique submission constraint so concurrent callbacks create one submission and never overwrite the winner.
- Late submissions from `timed_out` resolve the anomaly. Duplicate winner callbacks are idempotent; non-winners get an already-resolved result. Resolved records cannot reopen.
- Extend the Feishu gateway with `send_interactive` and `patch_interactive` using the existing token/error handling.
- Build raw cards for pending/processing, timed-out, and resolved states. Active cards include description, rule, dataset, severity, deadline, a `${SENTINEL_PUBLIC_BASE_URL}/#records/<id>` link, required `validation_text` input, and a submit action containing the anomaly ID. Resolved cards are read-only and show resolver/time.
- Send one card per request with retries. Suppress a legacy text notification to the same `user_id`. Card-close/update failures persist for later retries and never roll back resolution.

Run focused service/Feishu tests and the backend suite. Commit the task.

### Task 3: HTTP APIs, State Machine Integration, and Timeout Runtime

Add tests first, verify they fail, then implement:

- Add `POST /api/internal/feishu/card-actions`, authenticated with the existing internal token. Normalize only the expected submit action and validate message/anomaly/operator relationships before calling the service.
- Return callback-friendly toast/card data for success, empty input, duplicate/already-resolved, and authorization failures without leaking internals.
- Route single and bulk manual status changes through the validation state service. Permit pending/processing interchange, allow any unresolved state to resolve manually, reject reopening resolved, and prevent manually selecting `timed_out`.
- Add `timed_out_records` to overview/statistics and include validation data in anomaly details.
- Add a one-minute lifespan task (disabled in tests) that expires due anomalies and retries pending card reconciliation, using a fresh database session each cycle and graceful cancellation.
- Add settings and `.env.example` entries for `SENTINEL_PUBLIC_BASE_URL`, `SENTINEL_API_BASE_URL`, and the timeout scan interval.

Run focused API/runtime tests and the backend suite. Commit the task.

### Task 4: Feishu Long-Connection Callback Gateway

Add behavior tests first, verify they fail, then implement:

- Pin `lark-oapi==1.7.2` in backend dependencies.
- Extend the existing launcher to register `p2.card.action.trigger`, normalize operator/message/action/form fields, call the internal endpoint with `X-Internal-Token`, and map its response to `P2CardActionTriggerResponse`.
- Use `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `SENTINEL_API_BASE_URL`, and `INTERNAL_EXECUTION_TOKEN`; fail fast with actionable messages for missing settings.
- Internal API/network errors must produce an error toast/card response and must not terminate the WebSocket process.
- Update launcher documentation/start instructions without exposing secrets.

Run launcher tests and relevant backend tests. Commit the task.

### Task 5: Rule and Anomaly Management UI

Use the existing refined industrial design system. Add browser/VM tests first, verify they fail, then implement:

- Rename rule description copy to `异常描述` and add a real-time validation section with enable switch, numeric timeout minutes, N literal user IDs, and N dataset-field targets. Preserve uncommitted tag input on save and serialize/map the new API fields.
- Add the `timed_out` badge, tab, counts, filtering, navigation count, overview statistics, and responsive styling.
- Extend anomaly details with description, deadline, timed-out time, resolution source, winning submitter/text/time, and validation request delivery/closure state.
- Support `#records/<uuid>` routing. After Store initialization render the records page and open that drawer; export `openDetail`; unknown IDs show a toast while leaving the list usable.
- Manual resolve updates the list and detail using the centralized backend behavior; resolved records expose no reopen action.

Run all frontend tests with the bundled Playwright dependency and relevant backend serialization tests. Commit the task.

### Task 6: Integration Regression and Acceptance Documentation

Add/fix tests before any behavior change:

- Cover multi-recipient sending, missing row user IDs, delivery retries, callback tampering, operator mismatch, empty/oversize content, duplicate callbacks, first-writer-wins, timeout idempotency, late submission, manual resolution, card close retries, and deep-link behavior.
- Update seed/demo compatibility without hardcoding the acceptance user.
- Document migration, backend/long-connection startup, Feishu callback subscription, public-base URL requirements, and the manual smoke flow targeting `user_id=753f6bdf`.
- Run Alembic upgrade against SQLite test setup or a disposable database, the full Python suite, all frontend tests, and static syntax/compile checks.
- Do not send a real Feishu message unless credentials are configured and the final external side effect is explicitly authorized at execution time.

Commit the task and report any environment-only limitations.
