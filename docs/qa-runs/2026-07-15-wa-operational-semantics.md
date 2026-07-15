# QA-run: WA logout/restricted/banned operational semantics — 2026-07-15

- Исполнитель: Codex task-agent + три review/implementation-субагента
- Ветка/коммит: `feat/phase-1-wa-operational-semantics` / `9f02cfbc40499f326a506bd25a93c687440aad89`
- PR: https://github.com/mivroniosergiu-eng/smartmessage-kz/pull/27
- CI: `quality-gate` passed — https://github.com/mivroniosergiu-eng/smartmessage-kz/actions/runs/29438989459
- CodeRabbit: check passed без inline threads, но текстовый review не выполнен из-за внешнего rate-limit; выполнен локальный финальный review.

## Автотесты

- TDD: explicit logout проходит durable generic queue → exact owner+epoch; stale epoch не claim-ит новую generation, duplicate delivery не повторяет side effect, offline auth очищается без socket.
- TDD: Baileys 403 → `banned`, 429 → `restricted`; Retry-After ограничен диапазоном 1 минута–7 дней, повторное ограничение не сокращает cooldown.
- TDD: `RESTRICTED` fenced-персистится, закрывает transport без logout, ставит точную delayed job и release-ит owner только после enqueue; ранняя/stale/BANNED recovery не открывает socket.
- TDD: startup reconciliation восстанавливает recovery jobs из PostgreSQL до запуска consumers.
- TDD: producer, execution и Prisma ownership fence блокируют новый start для `BANNED` и будущего `RESTRICTED`; due restriction допускается.
- TDD: `BANNED` монотонен для reconnect/stop/logout/shutdown; конкурентный fenced transition создаёт ровно один санитизированный `AuditLog`.
- `pnpm --filter @smartmessage/wa test` — passed, 230/230.
- `pnpm --filter @smartmessage/wa lint` — passed.
- `pnpm --filter @smartmessage/shared test` — passed, 42/42.
- `pnpm --filter @smartmessage/shared lint` — passed.
- `pnpm --filter @smartmessage/queue test` — passed, 18/18.
- `pnpm --filter @smartmessage/queue lint` — passed.
- `pnpm --filter @smartmessage/worker test` — passed, 185/185; `DATABASE_URL` передан только дочернему процессу из ignored env-файла без вывода значения.
- `pnpm --filter @smartmessage/worker lint` и `typecheck` — passed.
- `pnpm typecheck` — passed для всех workspace-пакетов.
- `pnpm lint` — passed без warnings.
- `pnpm test` — passed, 493/493 workspace tests.
- `pnpm test:cov` — passed; WA 91.63% statements / 84.04% branches, worker 95.41% / 91.08%, shared 97.6% / 92.64%.
- `pnpm build` — passed; generated ERD возвращён к canonical formatting.
- `git diff --check`, anti-weakening и secret/session/forbidden-surface scans — passed.
- CI `quality-gate` — passed; CodeRabbit — check passed, review rate-limited, unresolved review threads: 0.

## Ручной QA (QA_CHECKPOINTS.md §3.1)

- [x] Автоматическая часть выполнена с fake transport/auth и mocked queue; настоящий Baileys socket не создавался.
- [ ] Реальный QR/logout/restricted/banned smoke-test не выполнялся: нужен отдельный OWNER_DECISION и тестовый аккаунт.

## Найденные дефекты / решения

- `restricted` ранее сохранялся как `DISCONNECTED` и бесконечно удерживал heartbeat; добавлены typed deadline, durable recovery и startup reconciliation.
- Worker start job повторно не проверял текущий DB-статус; добавлен execution gate и атомарный ownership fence до socket.
- Shutdown/stop/logout могли понизить terminal state; persistence и session managers сделаны монотонными.
- Документация ошибочно утверждала, что подтверждённый logout не очищает creds; контракт выровнен с ADR и кодом.

## Safety-scope

- Не выполнялись реальные WA-отправки, QR-сканирование или подключение аккаунта.
- Не добавлены send/campaign/UI/публичные HTTP surfaces.
- Не использованы реальные номера, секреты, session files или customer data.
- `packages/wa` не зависит от Prisma; DB adapters остаются в `apps/worker`.
