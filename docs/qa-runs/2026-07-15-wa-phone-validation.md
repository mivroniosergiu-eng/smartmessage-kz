# QA-run: WA phone validation — 2026-07-15

- Исполнитель: Codex task-agent; независимый review выполнен тремя subagent-аудитами
- Ветка/коммит: `feat/phase-1-wa-phone-validation` / commit будет зафиксирован перед PR
- PR/CI: pending

> Historical ledger: the later single-send/web hardening supersedes the web-scope note below; see `2026-07-16-wa-single-send-web.md` for the current Phase 1 runtime slice.

## Автотесты

- TDD red подтверждён: connector не имел `validate()`, а worker не имел durable validation queue, DB transitions и owner routing.
- Queue contract: строгие tenant/contact payloads, stable generic job-id, exact owner+epoch payload, отдельный per-run id для retained result.
- Baileys mock integration: `onWhatsApp` вызывается на уже открытом socket с нормализованным JID; новый socket не создаётся; результат маппится в `confirmed/not_on_whatsapp`.
- Worker unit/integration: `NULL/ERROR → IN_PROGRESS → terminal`, terminal idempotency, `ERROR` только после исчерпания retry, 10-секундный timeout, distributed round-robin, live owner registry, DB tenant/account/epoch fence, stale owner retry.
- Identity safety: оба validation consumer-а останавливаются вместе с lifecycle consumers при lease loss и graceful shutdown.
- `pnpm --filter @smartmessage/queue test` — passed, 22/22.
- `pnpm --filter @smartmessage/wa test` — passed, 241/241.
- `pnpm --filter @smartmessage/worker test` — passed, 203/203.
- `pnpm --filter @smartmessage/queue lint` — passed.
- `pnpm --filter @smartmessage/wa lint` — passed.
- `pnpm --filter @smartmessage/worker lint` — passed.
- `pnpm lint` — passed без warnings.
- `pnpm typecheck` — passed для всех workspace-пакетов.
- `pnpm test` — passed, 526/526 workspace tests.
- `pnpm build` — passed, включая production Next.js build и Prisma generate.
- `pnpm test:cov` — passed; WA 91.42% statements / 83.51% branches, worker 94.45% / 89.08%.
- `git diff --check` — passed.
- Anti-weakening, forbidden surface/session-file и secret scans — clean.
- CI — pending перед PR.

## Ручной QA (QA_CHECKPOINTS.md §3.8)

- [x] Автоматическая часть первого пункта §3.8 (enum-статусы) покрыта mock Baileys socket, реальным PostgreSQL и реальным Redis/BullMQ integration smoke; unit-контракты дополнительно проверяют payload/идемпотентность без реального аккаунта.
- [x] Асинхронный UI-trigger и single-send web-срез реализованы позднее; актуальное evidence находится в `2026-07-16-wa-single-send-web.md`. Campaign gating невалидных номеров остаётся scope Фазы 3.
- [ ] Real-WA `onWhatsApp` smoke-test не выполнялся: нужен отдельный OWNER_DECISION и тестовый WA-аккаунт.

## Найденные дефекты / решения

- Retained owner-result без идентификатора запуска мог быть повторно принят новой проверкой после `ERROR`. Добавлен `validationRunId`, стабильный между retry одного BullMQ job и новый при следующем enqueue; окончательно failed generic job удаляется (`removeOnFail: true`), чтобы повторный enqueue не поглощался старой BullMQ job.
- Последовательное bounded-закрытие четырёх consumers могло суммарно выйти за worker TTL. Pause/close выполняются параллельно внутри каждой shutdown-фазы; identity освобождается только после успешного закрытия всех consumers и transports.

## Safety-scope

- Не добавлены HTTP/UI/QR/send surface, массовые рассылки, campaign scheduling, jitter/rate-limit или circuit-breaker.
- Validation job не открывает WA socket и не вызывает `sendMessage`.
- Не выполнялись реальное WA-подключение, QR-сканирование, отправка или `onWhatsApp` через реальный аккаунт.
- Не использовались секреты, номера клиентов или session files.
- `packages/wa` не зависит от Prisma; persistence adapter остаётся в `apps/worker`.
