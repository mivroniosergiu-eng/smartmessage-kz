# QA-run: повторный аудит закрытия Фазы 1 — 2026-07-22

- Исполнитель: Codex
- Рабочая ветка: `feat/phase-1-wa-phone-validation`
- База аудита: PR head `0dd198e`, merged `main` `8dc288c` (одинаковое дерево до closure-diff)
- Среда: отдельная PostgreSQL БД и отдельный Redis logical DB; реальные customer/WA данные не использовались

## Acceptance contract

- production real-WA runtime не теряет входящие события из-за отсутствующего consumer;
- auth token имеет строгую схему и expiry, middleware и server-side auth принимают одинаковое решение;
- production dependency audit не содержит известных уязвимостей;
- coverage thresholds исполняются, а полный gate детерминирован;
- build, миграции и E2E проходят после обновления Next/Nest.

## TDD / найденные дефекты

- Receiver: red — worker module не имел production consumer; green — явный Nest provider принимает upsert/update и не логирует JID, текст, message id или instance id.
- Session expiry: red — подписанный token не истекал и принимал произвольную role; green — обязательные `iat/exp`, строгий role enum, единый TTL 7 суток и constant-time signature check в Node/middleware.
- Runtime gate: red — `BAILEYS` и значение с пробелами включали real transport; green — принимается только точное `baileys`.
- Full coverage выявил 2 флапающих Redis lease tests при file-level contention; worker integration files изолированы последовательным запуском без удаления или ослабления assertions.
- Next.js 15 build выявил старые sync `cookies()` и sync `searchParams`; оба пути переведены на async API.

## Автотесты и статические gate'ы

- `pnpm test:cov` — passed, 623/623:
  - db 5/5;
  - queue 26/26;
  - shared 42/42;
  - WA 252/252;
  - web 43/43;
  - worker 255/255.
- Фактическое покрытие ключевых поверхностей:
  - queue: statements/lines 96.40 %, branches 92.53 %, functions 93.93 %;
  - WA: statements/lines 91.75 %, branches 83.93 %, functions 97.11 %;
  - worker: statements/lines 92.98 %, branches 86.71 %, functions 93.95 %;
  - web: statements/lines 53.49 %, branches 71.52 %, functions 81.25 %.
- `pnpm typecheck` — passed.
- `pnpm lint` — passed, 0 warnings/errors.
- `pnpm build` — passed с Next.js 15.5.21 и NestJS 11.1.28.
- `prisma migrate status` — 11 migrations, schema up to date.
- `pnpm audit --prod` — 0 известных уязвимостей.
- `git diff --check` — passed.

## E2E

- `PLAYWRIGHT_BASE_URL=http://127.0.0.1:3191 pnpm --filter @smartmessage/web test:e2e` — 2/2 passed.
- Подтверждены auth signup/logout/login/protected route и tenant-scoped WhatsApp page.
- Альтернативный порт доказывает, что Playwright webServer больше не захардкожен на `3100`.

## Ручной / real-WA QA

- В ходе closure-аудита новые реальные WA side effects не запускались.
- Сохранён evidence PR #29: owner-authorized QR connection, ciphertext restart recovery, phone `CONFIRMED` и одна одиночная отправка с одним `SENT` MessageLog/provider id без дубля.
- Массовая отправка и ban-rate эксперимент не выполнялись; это отдельный открытый риск Фазы −1, зафиксированный в `docs/ROADMAP.md`.

## Итог

Технический closure-gate Фазы 1 пройден. Для официального попадания closure-diff в `main` нужны обычные commit/PR/CI действия владельца; они не выполнялись в рамках локального аудита.
