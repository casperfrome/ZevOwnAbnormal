# Final review fix report

Date: 2026-08-22
Baseline: `6151f8b`
Scope: all Critical and Important findings in `final-review-findings.md`, plus all feasible Minor findings.

## Resolution evidence

### Critical

- **C1 — MySQL 8.4 TEXT default:** `20260822_0002_anomaly_validation.py` now builds the anomaly `description` column with the MySQL expression default `sa.text("('')")`. Migration tests compile both the column and the emitted MySQL `ALTER TABLE`, reject the invalid quoted form, and retain SQLite coverage.
- **C2 — message POST ambiguity:** interactive message POST transport loss, HTTP 408/5xx, truncated/unparseable responses, malformed success bodies, and missing `message_id` are `FeishuDeliveryUncertainError`. Token HTTP/transport failures remain pre-POST `FeishuError`; parsed 4xx application rejection remains definitive. Ambiguous delivery preserves `sending` and `send_started_at`, uses the same UUID, and caps the durable send sequence at three POSTs even when the process crashes after a POST but before saving its error. It becomes `uncertain` after the one-hour boundary without a fourth POST. Combined token-failure/4xx/recovery regressions protect the distinction.
- **C3 — Card JSON 2.0 form contract:** the production card uses globally distinct `validation_form`, `validation_text`, and `submit_validation` names. The button uses `form_action_type: submit` and a callback behavior carrying the full anomaly ID. The long-connection test constructs the real production card and round-trips its real button name, callback value, and official flat `form_value` shape.

### Important

- **I1 — durable initial-delivery recovery:** every maintenance cycle scans a bounded batch of durable `pending`/`failed`/`sending` requests, reuses the existing claim/UUID and one-hour ambiguity rules, closes resolved never-posted requests without sending, and moves expired ambiguous requests to `uncertain`. A file-backed SQLite restart test commits a request, simulates a crash before send, and verifies delivery after restart.
- **I2 — authenticated production sessions and mutations:** `AUTO_LOGIN` defaults to `false`; `/auth/me` validates the signed cookie/JWT and reloads the current persistent user. Deleted/tampered users fail, non-admin users can read their identity but receive 403 on management writes, and datasource/dataset/rule/execution/test-message/anomaly status mutations require the current admin dependency. Controlled test apps explicitly retain auto-login compatibility. README and acceptance docs state that public card deep links require an existing authenticated session and never auto-grant superadmin.
- **I3 — complete root `.env` startup:** the launcher loads the repository-root `.env` with `override=False`. Bootstrap writes the canonical internal-token name, public/API base URLs, scan interval, maintenance batch size, Feishu timeout, and `AUTO_LOGIN=false` without printing secret values. Tests cover `.env`-only launcher startup and explicit environment precedence. `python-dotenv==1.2.2` is now a direct pinned dependency.
- **I4 — bounded anomaly queries and responsive UI:** `/anomalies` uses SQL `COUNT`, global `ORDER BY`, `LIMIT/OFFSET`, and one grouped delivery-status query for the page. The new `0004` migration and model metadata add status/deadline, first-seen sort, and delivery maintenance indexes. Search is debounced by 250 ms; request-sequence tests retain newest-response ownership. CSV export now accepts the same server filters/sort, the UI flushes pending search before export, and the toast reports the authoritative filtered total.
- **I5 — safe rule field options:** all field/target/condition selectors are populated with DOM-created `option` nodes using `.value` and `textContent`; no field name/type is interpolated into option HTML. Browser coverage uses quotes, tags, injected option markup, and `onerror` text across every affected selector.
- **I6 — bounded, cancellable terminal convergence:** initial delivery and terminal patching use configured finite batches, log remaining work, commit before each external call, and finalize each card in a small transaction. Shutdown signals a thread event, checks it between cards/retries, and a production Feishu client checks it between token and message/patch requests, so shutdown does not drain an N-card queue or start a second external call after cancellation.
- **I7 — complete demo ownership guard:** demo Dataset/rule creation now requires the complete seed datasource fingerprint, not only update paths. A custom same-named datasource with no Dataset is preserved and produces an explicit skip message; no demo Dataset/rule is created.

### Minor

- Validation request timeline text now says requests were created and are awaiting send.
- Callback exceptions emit one structured warning containing only event name and exception type; no token, callback payload, exception text, or traceback is logged.
- Export filtering/sorting/count messaging is consistent end-to-end, including a search/export race regression.
- `20260809_0001` no longer imports mutable application metadata; it contains a frozen original schema. Tests assert that validation tables/columns are absent at revision 0001, and the acceptance guide includes a disposable MySQL 8.4 migration gate.

## TDD and verification evidence

Every behavior group was introduced with a failing regression before implementation. Observed red failures included invalid MySQL default helpers, definitive classification of 5xx/malformed POST responses, missing Card JSON button keys, absent crash recovery, unauthenticated-cookie rejection, absent `.env` loading, Python-side list slicing/N+1 queries, immediate search requests, hostile option corruption, unbounded card patching, unsafe seed creation, stale export totals, mutable 0001 metadata, a possible fourth POST (including a crash before persisting the ambiguous error), token transport misclassification, and an explicit internal-token constructor value being ignored after aliasing.

Final commands were run on the exact pre-commit tree:

- `python -m pytest backend/tests tests -q` — **172 passed**, 7 upstream `lark_oapi/pkg_resources` deprecation warnings, 0 failed.
- `NODE_PATH=<Codex bundled dependency path> node --test` from `frontend` — **22 passed**, 0 failed.
- `python -m pytest backend/tests/test_anomaly_validation_migration.py -q` — **6 passed** (included in the 172 above), covering frozen 0001, MySQL 8.4 column/ALTER compilation, SQLite defaults, and query indexes.
- Disposable SQLite Alembic `upgrade 20260809_0001`, `upgrade head`, `current` — reached **`20260822_0004 (head)`**.
- `python -m compileall -q backend tests 飞书长连接启动` — exit 0.
- Recursive `node --check` for all frontend JavaScript — exit 0.
- `docker compose config --quiet` — exit 0.
- `git diff --check` — exit 0 (only Git's existing LF/CRLF conversion notices).

## External constraints and deferred work

- No real Feishu message, callback, card patch, credential read, or external-service mutation was performed. All transport tests used local mocks/fakes.
- No live or container MySQL server was started. MySQL 8.4 evidence is dialect/DDL compilation plus a documented disposable-container gate; the real/container gate remains execution-time gated.
- The repository has no frontend package manifest/lockfile. Introducing and validating a complete Node dependency lifecycle is broader than this final fix, so Node lockfile creation is deferred and explicitly documented; tests used the already-provided bundled Playwright runtime without modifying global dependencies.

## Final Fix Round 2

Baseline: `69dc764`
Scope: the four Important and two Minor findings from the Round 2 branch re-review.

### Important

- **Resolved claim TOCTOU:** `_claim_validation_delivery()` now refreshes both the request and anomaly with `populate_existing` inside the database lock/SQLite serialization critical section. If resolution lands after candidate selection but before claim, a never-delivered `pending`/`failed` request is atomically closed as `resolved`; an ambiguous `sending` request keeps the existing one-hour convergence semantics. A file-backed two-session barrier regression resolves the anomaly at precisely that boundary and proves that the outbound POST count remains zero.
- **Persistent fair retry scheduling:** revision `20260822_0005` adds nullable `next_attempt_at`, durable `consecutive_failures`, and the `(delivery_status, next_attempt_at, updated_at)` eligible-queue index. Candidate SQL excludes live leases and exhausted ambiguous sends before applying `LIMIT`, orders executable work by eligible time and age, and rechecks eligibility while claiming. Definitive and pre-POST failures use persisted exponential delay from five minutes, capped at one hour; success clears the schedule and failure count. Tests prove that fifty blocked older requests cannot starve one new pending request and that a definitive failure remains suppressed across a process restart until its persisted eligibility time. The three-POST UUID ambiguity cap and one-hour no-fourth-POST boundary remain covered by the Round 1 regressions.
- **Canonical internal token:** `SENTINEL_INTERNAL_TOKEN` is canonical for FastAPI, bootstrap, launcher, and gateway. A legacy-only `INTERNAL_EXECUTION_TOKEN` remains compatible. Two different non-empty aliases at the same source priority fail fast with variable names only; an explicit process alias takes precedence over the opposite alias in `.env`. Bootstrap now emits only the canonical key. Settings, gateway, launcher, and bootstrap regressions cover canonical-only, legacy-only, equal aliases, conflicting aliases, `.env`/process precedence, and secret-free errors.
- **Authenticated management reads:** every management list/detail/export route for datasources, datasets, rules, rule runs, anomalies/timeline, CSV, and overview uses the authenticated-reader dependency. Health, login, and static entry points remain public; `AUTO_LOGIN=true` remains an explicit controlled-test compatibility mode. Parameterized anonymous checks return 401 for list, detail, and CSV routes, while a normal authenticated user may read and still receives 403 on writes; an authenticated admin reaches the protected write handler.

### Minor

- **Export debounce race:** export freezes one filter/sort snapshot before awaiting its authoritative server count and builds the CSV URL from that same immutable snapshot. A browser regression types a second search while the count promise is pending and proves that both the exported filter and toast total still belong to the first snapshot.
- **Bounded cancellable expiry:** `expire_due_anomalies()` now reads at most `batch_size + 1`, orders deterministically, checks `should_stop` between records, commits each successful CAS/event pair independently, and logs when work remains. The maintenance loop passes the same configured batch and shutdown callback used by delivery/reconciliation. Tests prove one-record cancellation, bounded remainder, event consistency, and continued timeout idempotency/concurrent-resolution CAS behavior.

### Round 2 TDD and verification evidence

Each behavior was first protected by a failing regression. Observed red states included a POST after the pre-scan/claim resolution barrier, absent persistent scheduling columns, fifty ineligible sends consuming the batch, a failed request retrying before its durable eligibility time after restart, conflicting token aliases being silently selected, anonymous management reads returning data/404 instead of 401, export count/filter ownership changing while its promise was pending, unbounded expiry, and missing MySQL DDL helpers for revision `0005`.

Final commands were run on the exact pre-commit Round 2 tree:

- `python -m pytest backend/tests tests -q` — **204 passed**, 7 upstream `lark_oapi/pkg_resources` deprecation warnings, 0 failed.
- `NODE_PATH=<Codex bundled dependency path> node --test` from `frontend` — **23 passed**, 0 failed.
- `python -m pytest backend/tests/test_anomaly_validation_migration.py -q` — **8 passed** (included in the 204 above), covering SQLite persistence/indexes and MySQL 8.4 compilation of both new columns and the eligible-queue index.
- Disposable SQLite Alembic `upgrade 20260809_0001`, `upgrade head`, `current`, `downgrade 20260822_0004`, `upgrade head`, `current` — reached **`20260822_0005 (head)`**, downgraded to **`20260822_0004`**, and returned to **`20260822_0005 (head)`**.
- `python -m compileall -q backend tests 飞书长连接启动` — exit 0.
- Recursive `node --check` for all frontend JavaScript — exit 0.
- `docker compose config --quiet` — exit 0.
- `git diff --check` — exit 0 (only Git's existing LF/CRLF conversion notices).

Round 2 did not contact Feishu, inspect credentials, mutate any external service, or start a live/container MySQL server. HTTP behavior used local fakes; MySQL 8.4 evidence remains dialect/DDL compilation plus the documented disposable-container gate.

## Final Fix Round 3

Baseline: `35b5c1d`

Scope: the two remaining Minor findings.

- **Frontend export count cache isolation:** `Store.peekRecordsPage()` now fetches and maps an authoritative page without touching `Store.records` or the page request sequence. Export count uses this side-effect-free path, so an export started while page two is rendered cannot replace page-two records or make quick status actions target the wrong record. Store-level out-of-order coverage and a production `data.js` + `records.js` browser regression verify page-two DOM/cache continuity and the quick status target.
- **Canonical/legacy token normalization:** backend Settings, callback gateway resolution, and launcher environment loading now trim before emptiness checks, alias comparison, and return. Whitespace-only values are treated as absent; trimmed conflicts fail fast with variable names only; launcher `.env` loading preserves explicit nonblank process precedence while normalizing the selected canonical value. Explicit Settings constructor tokens are trimmed as well.

### Round 3 TDD and verification evidence

The inherited Round 3 regressions were reviewed and exercised. A new failing test first reproduced untrimmed explicit `Settings` constructor output (`'  explicit-token\\t '`), then the minimal constructor normalization made it pass.

Fresh verification on the exact working tree:

- `python -m pytest backend/tests/test_validation_runtime.py tests/test_feishu_long_connection.py -q` — **52 passed**.
- `NODE_PATH=<Codex bundled dependency path> node --test frontend/tests/*.test.js` — **25 passed**, 0 failed.
- `python -m pytest backend/tests tests -q` — **215 passed**, 7 upstream `lark_oapi/pkg_resources` deprecation warnings, 0 failed.
- `python -m pytest backend/tests/test_anomaly_validation_migration.py -q` — **8 passed**.
- `python -m compileall -q backend tests 飞书长连接启动` — exit 0.
- Recursive bundled `node --check` for `frontend/scripts/*.js` — exit 0.
- `docker compose config --quiet` — exit 0.
- `git diff --check` — exit 0 (only existing LF/CRLF conversion notices).

No credentials were read and no external service or Feishu endpoint was contacted.
