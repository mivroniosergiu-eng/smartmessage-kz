# QA-run: WA auth-state persistence port — 2026-07-06

- Исполнитель (агент/человек): Codex task-agent
- Коммит/ветка: `feat/phase-1-wa-auth-state-port`

## Автотесты
- Команда прогона:
  - `pnpm --filter @smartmessage/db db:deploy` — passed; migration `20260706103000_add_wa_auth_state` applied.
  - `pnpm --filter @smartmessage/db db:generate` — passed.
  - `pnpm --filter @smartmessage/wa test` — passed, 62 tests.
  - `pnpm --filter @smartmessage/wa lint` — passed.
  - `pnpm --filter @smartmessage/worker test` — passed, 86 tests.
  - `pnpm --filter @smartmessage/worker lint` — passed.
  - `pnpm typecheck` — passed.
  - `pnpm test` — passed.
  - `pnpm build` — passed.
  - `git diff --check` — passed.
  - Anti-weakening scan — passed.
  - Secret/session-file scan — passed.
  - Baileys/socket pattern search — passed.
- Результат CI (ссылка на GitHub Actions run): not run yet; local validation only
- Покрытие критичных зон (рассылки/биллинг/auth/интеграции/ИИ): WA auth-state persistence boundary only; covered by neutral store contract tests, Prisma adapter integration tests, WaModule wiring tests, worker tests/lint, workspace typecheck/test/build, and safety scans.

## Ручной QA (из QA_CHECKPOINTS.md, раздел: WA auth-state persistence boundary)
- [x] Auth-state contract is provider-neutral JSON object payload, not Baileys public types.
- [x] Prisma adapter persists DB JSON payload for existing WaAccount only.
- [x] Missing WaAccount write raises an explicit domain error and does not create an account.
- [x] Clear removes auth-state only and leaves WaAccount intact.
- [x] WaModule exports the auth-state store provider while MockSessionManager remains worker default.
- [x] No real Baileys runtime, socket connect, QR generation, send-message implementation, UI, or HTTP endpoint.
- [x] No filesystem WA session storage or session file paths.

## Найденные дефекты / решения
- Added migration `20260706103000_add_wa_auth_state` with `WaAuthState.instanceId` unique FK to `WaAccount.instanceId` and `payload Json`.
- Auth-state payload is stored in PostgreSQL as provider-neutral JSON; filesystem session storage remains out of scope.
- The future Baileys connector is not implemented or wired to production runtime in this task.
