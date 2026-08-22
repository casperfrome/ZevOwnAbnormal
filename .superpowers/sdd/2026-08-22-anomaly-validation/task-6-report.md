# Task 6 report — Integration Regression and Acceptance Documentation

## Scope delivered

- Audited the Task 6 acceptance matrix against the existing backend, launcher, and frontend regression suites. Existing tests already cover multi-recipient target resolution, missing/blank row targets, delivery retry and uncertain delivery, callback tampering and operator mismatch, empty/oversized content, duplicate callbacks, concurrent first-writer-wins, timeout idempotency and late submission, administrator resolution, card-close retries, and deep-link routing. No duplicate tests were added for those behaviors.
- Closed the uncovered seed/demo integration gap with strict RED/GREEN: StarRocks demo rows now expose deterministic non-production `manager_user_id` values (`demo_user_#####`), the seeded ADS dataset includes that field, and the seeded validation configuration is ready to use while remaining disabled by default with the 1440-minute timeout.
- Added `docs/anomaly-validation-acceptance.md` and linked it from `README.md`. It documents Alembic migration, FastAPI and long-connection startup, `p2.card.action.trigger` subscription, `SENTINEL_PUBLIC_BASE_URL` recipient-side reachability, secret-safe diagnostics, automated acceptance, and the explicitly gated manual smoke using `user_id=753f6bdf`.
- Added `.env.example` comments distinguishing the public browser/deep-link origin from the launcher-to-API origin.
- No real Feishu request was made and no external service state was changed.

## Acceptance coverage audit

| Requirement | Evidence |
| --- | --- |
| Multiple recipients; missing/blank field targets | `test_snapshot_creates_ordered_unique_requests_and_suppresses_matching_legacy_text` |
| Delivery retry; stable idempotency; uncertain result | `test_delivery_retries_real_feishu_gateway_and_persists_success`, `test_delivery_retry_uses_stable_remote_idempotency_key`, `test_lost_sent_commit_becomes_uncertain_after_dedupe_window_without_resend` |
| Callback tampering; anomaly/message/operator mismatch | `test_feishu_callback_returns_safe_transport_errors_for_bad_relationships` |
| Empty and oversized text | `test_invalid_submission_text_is_rejected_without_resolving`, `test_feishu_callback_returns_200_toasts_for_empty_and_repeat_submissions` |
| Duplicate callback; first writer wins | `test_duplicate_winner_is_idempotent_nonwinner_is_resolved_and_record_cannot_reopen`, `test_concurrent_callbacks_persist_exactly_one_winner` |
| Timeout idempotency; late submission; timeout race | `test_timeout_is_idempotent_and_late_submission_resolves`, `test_expiration_cannot_overwrite_a_concurrent_resolution` |
| Administrator resolve | `test_named_admin_can_manually_resolve`, `test_manual_resolution_uses_authenticated_admin_not_forged_assignee` |
| Card close retry and convergence | `test_card_patch_failure_is_retryable_and_does_not_rollback_resolution`, `test_timed_out_card_reconciliation_converges_after_one_success` |
| Deep link | frontend test `deep record hash renders the records list before opening its detail` |
| Long-connection callback normalization and subscription | `tests/test_feishu_long_connection.py` |

## TDD evidence

Command:

```powershell
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' -m pytest backend\tests\test_demo_data.py -q
```

- RED before implementation: `1 passed, 2 failed`.
  - `demo_manager_user_id` did not exist.
  - The seeded ADS dataset/rule did not expose `manager_user_id` or its disabled validation target.
- GREEN after the minimal implementation: `3 passed in 0.59s`.

## Final verification

### Alembic SQLite 0001 → head

Used a new disposable SQLite file through `DATABASE_URL`:

```text
Running upgrade  -> 20260809_0001
20260809_0001
Running upgrade 20260809_0001 -> 20260822_0002
Running upgrade 20260822_0002 -> 20260822_0003
20260822_0003 (head)
```

Result: exit `0`.

### Complete Python suite

```powershell
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' -m pytest backend\tests tests -q
```

Result: `129 passed, 7 warnings in 22.11s`, exit `0`.

The seven warnings are upstream deprecations from pinned `lark-oapi==1.7.2` / its vendored protobuf code (`pkg_resources`, namespace declarations, `utcfromtimestamp`, and event-loop lookup). There were no project warnings or failures.

### Complete frontend suite

Loaded the Codex desktop bundled Playwright package through `NODE_PATH`, then ran:

```powershell
Push-Location frontend
node --test
Pop-Location
```

Result: `18 tests`, `18 passed`, `0 failed`, duration `8338.4757 ms`, exit `0`.

### Static checks

```powershell
& 'D:\PythonVEnv\FirstVEnv\Scripts\python.exe' -m compileall -q backend tests 飞书长连接启动
Get-ChildItem frontend -Recurse -Filter '*.js' -File | ForEach-Object { node --check $_.FullName }
git diff --check
```

Results:

- Python `compileall`: exit `0`.
- JavaScript syntax: `14` files checked, all exit `0`.
- `git diff --check`: exit `0`; Git emitted only the repository's Windows LF→CRLF checkout warnings.

## Environment-only limitations

- A live MySQL 8.4 / StarRocks / DolphinScheduler deployment was not mutated or smoke-tested. Migration behavior was verified through the required disposable SQLite chain and existing MySQL dialect compilation tests.
- The raw shell initially could not resolve `playwright`; the frontend suite passed after loading the Playwright package bundled with the Codex desktop runtime. No package was downloaded or changed.
- Feishu credentials, organization installation, permissions, recipient-side public URL reachability, WebSocket connectivity, actual message arrival, and card update delivery require the deployment environment. They were not exercised because no execution-time authorization for a real external send was provided.
- The acceptance `user_id` appears only in human-facing smoke documentation. Production, seed, demo, tests, and callback logic do not hardcode it.
