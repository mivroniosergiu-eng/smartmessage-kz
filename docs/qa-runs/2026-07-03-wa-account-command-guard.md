# QA-run: WA account command guard - 2026-07-03

- Исполнитель (агент/человек): Codex task-agent
- Коммит/ветка: PR #14, `feat/phase-1-wa-account-command-guard`

## Автотесты
- Команда прогона: `pnpm --filter @smartmessage/worker test`
  - Результат: passed, 8 files / 45 tests.
- Команда прогона: `pnpm --filter @smartmessage/worker lint`
  - Результат: passed.
- Команда прогона: `pnpm typecheck`
  - Результат: passed across workspace.
- Команда прогона: `pnpm test`
  - Результат: passed across workspace, 30 files / 150 tests.
- Команда прогона: `pnpm build`
  - Результат: passed across workspace.
- Команда прогона: `git diff --check`
  - Результат: passed.
- Команда прогона: anti-weakening `rg` check for `.skip` / `.only` / `xit`
  - Результат: passed.
- Результат CI (ссылка на GitHub Actions run): PR #14 `quality-gate` passed before review-fix; follow-up run is tracked on the same PR after push: https://github.com/mivroniosergiu-eng/smartmessage-kz/pull/14/checks
- Покрытие критичных зон (рассылки/биллинг/auth/интеграции/ИИ): worker-side WA lifecycle command enqueue guard is covered by unit/integration tests for existing/missing/blank `WaAccount.instanceId`, no create/update/status mutation, and facade delegation only after guard. Billing/auth/ИИ are out of scope.

## Ручной QA (из QA_CHECKPOINTS.md, раздел: не применимо для worker-only guard)
- [x] Worker command authorization path checked by tests: existing `WaAccount.instanceId` passes.
- [x] Missing `WaAccount.instanceId` rejects before low-level queue delegation.
- [x] Blank `instanceId` rejects before Prisma query.
- [x] No UI, HTTP endpoint, Server Action, QR flow, Baileys runtime/import, real sockets, WA session files, secrets, or real phone numbers were added.

## Найденные дефекты / решения
- Added `PrismaWaAccountCommandGuard` to validate/normalize the command target and reject missing `WaAccount.instanceId` with `WaAccountCommandTargetNotFoundError`.
- Added `WaLifecycleCommandQueueService` as the guarded facade for start/stop/renew lifecycle enqueue calls.
- Kept `WaLifecycleQueueService` as the low-level BullMQ producer without DB knowledge.
- Review-fix: guard validation receives the concrete lifecycle job name from the facade, so start/stop/renew errors use the correct queue parser context.

---

> Правило: задача или фаза не переводится в статус "Done", пока в папке `docs/qa-runs/` не появится заполненный отчёт по этому шаблону.
