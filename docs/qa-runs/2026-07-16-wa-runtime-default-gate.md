# QA-run: Phase 1 WA worker runtime default gate — 2026-07-16

- Исполнитель: Codex task-agent
- Ветка: `feat/phase-1-wa-phone-validation`

## Автотесты

- TDD red: default DI ожидал `MockSessionManager`, но получал `BaileysSessionManager`; строгий runtime resolver отсутствовал.
- Targeted: `pnpm --filter @smartmessage/worker exec vitest run src/wa/wa.module.spec.ts` — passed, 20/20.
- Runtime DI regression: `pnpm --filter @smartmessage/worker exec vitest run src/wa/wa-package-runtime.spec.ts src/wa/wa-lifecycle-job.processor.spec.ts src/wa/wa.module.spec.ts` — passed, 49/49; `tsx/cjs` сохраняет explicit metadata для controller, command queue и class-based dependencies lifecycle/phone-validation/single-send processors.
- Full worker: `pnpm --filter @smartmessage/worker test` — passed, 232/232.
- Worker lint/typecheck — passed.
- Safe runtime smoke (`WA_SESSION_RUNTIME=mock`): `start → stop` for local account `test` returned HTTP 201 for both commands and persisted `CONNECTED → DISCONNECTED`.

## Проверенные контракты

- Отсутствующий или пустой `WA_SESSION_RUNTIME`, а также точное значение `mock`, выбирают `MockSessionManager`.
- Mock runtime сохраняет lifecycle/ownership DI, но phone validation и send используют fail-closed unavailable adapters.
- Только точное `WA_SESSION_RUNTIME=baileys` создаёт real Baileys runtime; значение вроде `true` блокирует startup понятной ошибкой.
- Создание opt-in runtime не открывает socket: сетевой transport остаётся за explicit lifecycle `start`.

## Safety-scope

- Реальный WA-аккаунт, QR и отправка не использовались.
- Новые production dependencies и новые HTTP/UI/QR surfaces не добавлялись.
- `WA_SESSION_RUNTIME=baileys` не включался в runtime smoke; explicit owner-approved real-WA test остаётся отдельным checkpoint.
