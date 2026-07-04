# QA-run: WA QR bootstrap contract/status flow — 2026-07-04

- Исполнитель (агент/человек): Codex task-agent
- Коммит/ветка: `feat/phase-1-wa-qr-bootstrap-contract`

## Автотесты
- Команда прогона: `pnpm --filter @smartmessage/wa test`
  - Результат: passed, 9 files / 48 tests.
- Команда прогона: `pnpm --filter @smartmessage/worker test`
  - Результат: passed, 11 files / 75 tests.
- Команда прогона: `pnpm --filter @smartmessage/worker lint`
  - Результат: passed.
- Команда прогона: `pnpm typecheck`
  - Результат: passed across workspace packages/apps.
- Команда прогона: `pnpm test`
  - Результат: passed across workspace packages/apps.
- Команда прогона: `pnpm build`
  - Результат: passed. Prisma generate ran; `packages/db/ERD.md` had no diff.
- Команда прогона: `git diff --check`
  - Результат: passed, no whitespace errors.
- Команда прогона: `rg -n "\.skip|\.only|xit\(" --glob "*.spec.ts" --glob "*.test.ts" --glob "*.spec.tsx" --glob "*.test.tsx"`
  - Результат: no matches.
- Команда прогона: `rg -n '@whiskeysockets/baileys|makeWASocket\(|useMultiFileAuthState\(|auth_info|wa-sessions' packages/wa/src apps/worker/src --glob '!*.spec.ts'`
  - Результат: no matches.
- CI результат (ссылка на GitHub Actions run): не запускался локальным агентом.
- Покрытие критичных зон (рассылки/биллинг/auth/интеграции/ИИ):
  - WA bootstrap contract tested without Baileys, sockets, session files, or real WA numbers.
  - QR pending lifecycle hook now requires active instance ownership before status/QR side effects.
  - Internal QR endpoint tested for auth guard, missing account, no QR yet, and QR pending state.
  - CodeRabbit follow-up: QR bootstrap state preserves `restricted`/`banned` statuses instead of collapsing them to `disconnected`.
  - Existing start/stop/renew worker and lifecycle tests remain green.

## Ручной QA (из QA_CHECKPOINTS.md, раздел: WA internal contract)
- [x] QR bootstrap endpoint without token returns `401` and does not touch admin service.
- [x] Missing WA account returns `404`.
- [x] Existing account with no QR returns `{ instanceId, status }` without `500`.
- [x] Existing account with latest non-expired QR returns `{ instanceId, status: "qr_pending", qrCode, expiresAt }`.

## Найденные дефекты / решения
- Prisma schema has no durable QR bootstrap event storage. No migration was added in this task.
- QR bootstrap repository is intentionally volatile in-memory worker-side storage through a neutral port. Limitation: QR state is lost on worker restart and is not shared across processes until a persistence decision is made.
- No Baileys adapter, `makeWASocket`, real sockets, session files, or real QR generation were introduced.
