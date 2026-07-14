# QA-run: WA transport close/logout contract — 2026-07-15

- Исполнитель (агент/человек): Codex task-agent
- Коммит/ветка: `feat/phase-1-wa-transport-close-contract`

## Автотесты
- TDD red: `pnpm --filter @smartmessage/wa test -- baileys-transport-adapter.spec.ts baileys-connector.spec.ts` — expected failure, 9/23 tests failed до реализации close/logout contract.
- TDD green: `pnpm --filter @smartmessage/wa test -- baileys-transport-adapter.spec.ts baileys-connector.spec.ts` — passed, 23/23.
- Ownership-race TDD red: `pnpm --filter @smartmessage/wa test -- baileys-connector.spec.ts` — expected failure, 1/21; два конкурентных `connect()` проходили active-registry check до async auth-state read.
- Ownership-race TDD green: `pnpm --filter @smartmessage/wa test -- baileys-connector.spec.ts` — passed, 21/21 после reservation нормализованного `instanceId` на время открытия.
- Команда прогона: `pnpm --filter @smartmessage/wa test` — passed, 90/90.
- Команда прогона: `pnpm --filter @smartmessage/wa lint` — passed.
- Команда прогона: `pnpm --filter @smartmessage/worker test` — passed, 86/86.
- Команда прогона: `pnpm --filter @smartmessage/worker lint` — passed.
- Команда прогона: `pnpm typecheck` — passed для всех workspace-пакетов.
- Команда прогона: `pnpm test` — passed, 242/242 workspace tests.
- Команда прогона: `pnpm build` — passed.
- Команда прогона: `git diff --check` — passed.
- Anti-weakening scan: passed, no `.skip`, `.only`, `xit`, `xdescribe`, or `xtest` found.
- Session-file safety scan: passed, no `useMultiFileAuthState`, `auth_info*`, `wa-sessions`, or `*.session` artifacts found.
- Baileys/socket safety scan: passed; production `@whiskeysockets/baileys`/`makeWASocket` remains isolated to `packages/wa/src/baileys-connector.ts`, no production `sendMessage()` added.
- Worker/web surface scan: passed; no diff under `apps/worker` or `apps/web`, worker default remains `MockSessionManager`.
- Результат CI (ссылка на GitHub Actions run): not run locally.
- Покрытие критичных зон (рассылки/биллинг/auth/интеграции/ИИ):
  - Neutral transport boundary exposes SessionState-compatible `closeTransport(instanceId)` and `logout(instanceId)` results.
  - Adapter delegates connect/close/logout and rejects all operations with `WaTransportUnavailableError` when no connector is configured.
  - Fake Baileys socket verifies runtime close uses the installed Baileys `end(undefined)` contract and preserves auth-state.
  - Fake Baileys socket verifies terminal logout uses `logout()`, clears `WaAuthStateStore`, and removes the socket from the registry.
  - Normalized active/opening registries reject sequential and concurrent duplicate socket ownership.
  - Close/logout before connect and repeated close/logout reject with deterministic `WaTransportNotConnectedError`.
  - Close failure reaches `onError`, rejects with the original error, removes the failed socket, and does not create an unhandled rejection.
  - `no-network.spec.ts` remains green; no real WhatsApp connection or send occurs in tests.

## Ручной QA (из QA_CHECKPOINTS.md, раздел: WA transport/session safety)
- [x] Installed Baileys `7.0.0-rc13` declarations verified locally: `end(error: Error | undefined): Promise<void>` and `logout(msg?: string): Promise<void>`.
- [x] Runtime close and terminal logout are distinct; close never calls logout or clears auth-state.
- [x] Worker default wiring remains `MockSessionManager`; no worker wiring was added.
- [x] No HTTP/UI/QR endpoint, real socket/send call, or filesystem session path was added.
- [x] Tests use only an in-memory fake Baileys socket and in-memory auth-state store.

## Найденные дефекты / решения
- Conservative missing-socket behavior is fail-closed: close/logout before connect and repeated calls raise `WaTransportNotConnectedError` instead of reporting a misleading successful state.
- Self-review found a concurrent-connect gap before the active socket was registered. A normalized opening reservation now prevents two in-process sockets for one `instanceId`.
- Socket registry deletion is identity-checked so a delayed close event from an old socket cannot remove a newer socket.
- `pnpm build` regenerated whitespace in `packages/db/ERD.md`; generated churn was restored because the Prisma schema was not changed.
