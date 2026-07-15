# QA-run: WA receiver skeleton — 2026-07-15

- Исполнитель: Codex task-agent; subagent review запрошен, но внешний сервис вернул `402 deactivated_workspace`
- Ветка: `feat/phase-1-wa-receiver`
- PR/CI: pending

## Автотесты

- TDD red подтверждён: отсутствовал mapper и callbacks `messages.upsert/update` не доходили до connector/session/runtime observers.
- Mapper: notify/append batch, conversation и wrapped extended text, caption, update status, optional metadata, malformed records и unsafe timestamp.
- Connector: exact `instanceId`, сериализованный upsert/update stream, consumer error reporting и продолжение следующего события, отсутствие logout/close side effect.
- Session/runtime: current-generation fencing, stale callback no-op, явный receiver port без автоматической отправки.
- `pnpm --filter @smartmessage/wa test` — passed, 238/238.
- `pnpm --filter @smartmessage/wa typecheck` — passed.
- `pnpm --filter @smartmessage/wa lint` — passed.
- `pnpm --filter @smartmessage/worker test` — passed, 185/185.
- `pnpm --filter @smartmessage/worker typecheck` — passed.
- `pnpm --filter @smartmessage/worker lint` — passed.
- `pnpm lint` — passed без warnings.
- `pnpm typecheck` — passed для всех workspace-пакетов.
- `pnpm test:cov` — passed; WA 91.48% statements / 83.60% branches, receiver 87.05% / 78.35%; всего 501/501 workspace tests.
- `pnpm build` — passed.
- CI — pending.

## Ручной QA (QA_CHECKPOINTS.md §3.1 / §3.9)

- [x] Автоматическая часть выполнена на fake Baileys event source без сети и аккаунта.
- [ ] Реальный входящий message smoke-test не выполнялся: нужен отдельный OWNER_DECISION и тестовый WA-аккаунт.

## Найденные дефекты / решения

- Первый mapper имел type-only импорт Baileys вне connector и был остановлен существующим no-network architecture test. Граница исправлена: receiver принимает минимальный структурный input, единственный Baileys import остаётся в connector.
- Raw `requestId`, poll payload и прочие transport-specific поля не включаются в domain event.
- Receiver error не создаёт unhandled rejection и не блокирует следующий message event.

## Safety-scope

- Не добавлены автоответ, чат-бот, webhook, HTTP/UI, `sendMessage` или MessageLog persistence.
- Не выполнялись реальные WA-подключения, QR-сканирование, отправка/приём через реальный аккаунт.
- Не использовались секреты, номера клиентов или session files.
- `packages/wa` не зависит от Prisma.
