# QA-run: WA account bootstrap runtime DI — 2026-07-16

- Исполнитель: Codex task-agent
- Ветка: `feat/phase-1-wa-phone-validation` (изменения не закоммичены, PR не открыт)

## Автотесты

- `pnpm --filter @smartmessage/worker test` — passed, 228/228.
- Runtime regression: `wa-package-runtime.spec.ts` проверяет `tsx/cjs` Baileys import и explicit injection metadata для controller, command queue и lifecycle/validation/send processors — passed, 2/2.
- `pnpm --filter @smartmessage/worker lint` — passed.
- `pnpm --filter @smartmessage/worker typecheck` — passed.
- `git diff --check` — passed.

## Runtime QA

- [x] Worker `/health` отвечает HTTP 200 на `3001`.
- [x] `POST /internal/wa/accounts` с валидным internal token и существующей team отвечает HTTP 201.
- [x] Созданный account `test` имеет `DISCONNECTED`; socket/QR при создании не открываются.
- [x] `GET /internal/wa/accounts?teamId=...` отвечает HTTP 200 и возвращает account.
- [x] `POST /internal/wa/accounts/test/start` с internal token отвечает HTTP 201 и возвращает `{"instanceId":"test","command":"start","queued":true}`.
- [x] В безопасном `WA_SESSION_RUNTIME=mock` lifecycle smoke `start → stop` обработан воркером без ошибки DI; состояние `test` изменилось `DISCONNECTED → CONNECTED → DISCONNECTED`.

## Найденный дефект / решение

- При запуске через `tsx watch` class-based constructor metadata для `WaAccountController` не обеспечивала runtime injection, и `adminService` был `undefined`, что давало HTTP 500 и общий текст `WhatsApp worker failed to process the request`.
- После исправления controller был найден такой же runtime DI-дефект в `WaLifecycleCommandQueueService`: `commandGuard` и `queueService` были `undefined` при нажатии `Старт`/`Стоп`/`Logout`.
- После исправления command queue был найден такой же runtime DI-дефект в `WaLifecycleJobProcessor`: `commandGuard` был `undefined` уже при обработке job.
- Добавлены явные `@Inject(...)` для class-based dependencies всех затронутых controller/queue/processors и runtime regression-test metadata. HTTP + queue smoke для `start`/`stop` теперь подтверждает не только постановку, но и обработку команды.

## Safety-scope

- Реальный WhatsApp socket, QR scan и отправка сообщения не выполнялись.
- Внешние API, реальные номера, секреты и session files не использовались.
- Реальный Baileys lifecycle не запускался: проверялась только безопасная постановка команды в BullMQ/Redis; QR и подключение требуют отдельного ручного owner-approved smoke.
- Lifecycle smoke выполнялся только в `WA_SESSION_RUNTIME=mock`; реальный сокет, QR scan и отправка не выполнялись.
