# QA Run — Phase 0 normalization

**Дата:** 2026-07-02
**Ветка:** `feat/phase-0-foundation`
**Окружение:** локально, Postgres `localhost:5433`, Redis `localhost:6380`, Playwright Chromium

## Результат

PASS.

Этот прогон уточняет и дополняет `2026-06-30-phase-0.md`: после ревизии незавершённых локальных правок закрыты реальные долги Phase 0 — ESLint больше не заглушка, `Contact` добавлен как миграция Prisma, auth-поток проверен браузерным E2E.

## Что проверено

| Проверка | Результат |
|---|---|
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm --filter @smartmessage/db exec prisma validate` | PASS |
| `pnpm --filter @smartmessage/db exec prisma generate` | PASS |
| `pnpm --filter @smartmessage/db exec prisma migrate deploy` | PASS, применена `20260702090000_add_contact_model` |
| `pnpm lint` | PASS, root ESLint + Next lint |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS, 13 files / 53 tests |
| `pnpm test:cov` | PASS |
| `pnpm build` | PASS |
| `pnpm test:e2e` | PASS, 1 Chromium scenario |

## Покрытие и тесты

- `packages/shared`: 38 tests, coverage 98.09% lines, 100% functions, 92.15% branches.
- `packages/db`: 3 integration tests, включая `Contact` unique-per-team и `ContactWaStatus`.
- `apps/web`: 9 Vitest tests + 1 Playwright E2E сценарий:
  - `/dashboard` без сессии редиректит на `/login`;
  - регистрация создаёт пользователя/команду и открывает `/dashboard`;
  - logout возвращает на `/login`;
  - login снова открывает `/dashboard`;
  - очищенная сессия снова блокирует `/dashboard`.
- `apps/worker`: health + graceful shutdown tests; coverage включён через `@vitest/coverage-v8`.
- `packages/queue`: Redis/BullMQ integration test.

## Anti-weakening

- Новых `.skip`, `.only`, `xit` в тестовом diff нет.
- Тесты не ослаблялись; падающие проверки исправлялись в коде/конфигурации.

## Замечания

- Серверный GitHub CI не запускался в этом локальном прогоне, потому что изменения не коммитились и не пушились.
- Playwright/Next dev выводит предупреждение про будущий `allowedDevOrigins`; на Next 14 это warning, не failure.
