# Task 1 report — frontend legacy restoration foundation

## Changed files

- `frontend/src/api/types.ts` — normalized anomaly record/detail, group/detail, broadcast delivery, and overview contracts.
- `frontend/src/api/resources.ts` — backend-response mappers, normalized overview/detail requests, and pending-record count resource.
- `frontend/src/lib/format.ts` — stable business-key summaries and JSON-safe detail values.
- `frontend/src/index.css` and `frontend/src/App.tsx` — legacy canvas, shell tokens, 248px sidebar, 72px top bar, active rail, responsive sidebar, and real pending count badge.
- `frontend/src/components/shared.tsx` — Chinese status labels, statistics/details/pagination/tooltip shared composition.
- `frontend/src/api/resources.test.ts`, `frontend/src/lib/format.test.ts`, `frontend/src/App.test.tsx` — mapper, format, and count-badge coverage.

## TDD record

- Red: `npm test -- --run src/lib/format.test.ts src/api/resources.test.ts src/App.test.tsx`
  - Expected failures: missing `businessKeyText`, missing normalization mappers and `records.pendingCount`, and missing real pending badge.
- Green: `npm test -- --run src/lib/format.test.ts src/api/resources.test.ts src/App.test.tsx`
  - Result: 3 files passed, 16 tests passed.

## Verification

- `npm test -- --run src/lib/format.test.ts src/api/resources.test.ts src/App.test.tsx` — passed (16 tests).
- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `git diff --check` — passed.

## Commit

- Commit hash: `23b2f07cf881ee96577e3e64e794d22509f639d4` (amended below to include this report entry).

## Concerns

- The visual foundation is restored in the React shell; remaining page-level dense tables and detail presentations are intentionally deferred to Tasks 2–4.
