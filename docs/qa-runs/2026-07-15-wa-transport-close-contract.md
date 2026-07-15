# QA-run: WA transport close/logout contract — 2026-07-15

- Исполнитель (агент/человек): Codex task-agent
- Ветка: `feat/phase-1-wa-transport-close-contract`
- PR: [#23](https://github.com/mivroniosergiu-eng/smartmessage-kz/pull/23)

## Автотесты

- TDD red: `pnpm --filter @smartmessage/wa test -- baileys-transport-adapter.spec.ts baileys-connector.spec.ts` — expected failure, 9/23 tests failed до реализации close/logout contract.
- TDD green: та же команда — passed, 23/23.
- Ownership-race TDD red: `pnpm --filter @smartmessage/wa test -- baileys-connector.spec.ts` — expected failure подтвердил, что два конкурентных `connect()` проходили active-registry check до async auth-state read.
- Review-fix TDD red: последовательные целевые прогоны подтвердили дефекты в `logged_out` cleanup, concurrent close/logout, stale-socket identity, queued/in-flight auth writes, persistence-error visibility, fallback close и фактическом transport-close barrier.
- Review-fix TDD green: `pnpm --filter @smartmessage/wa test -- baileys-connector.spec.ts` — passed, 41/41.
- `pnpm --filter @smartmessage/wa test` — passed, 110/110.
- `pnpm --filter @smartmessage/wa lint` — passed.
- `pnpm --filter @smartmessage/worker test` — passed, 86/86.
- `pnpm --filter @smartmessage/worker lint` — passed.
- `pnpm typecheck` — passed для всех workspace-пакетов.
- `pnpm test` — passed, 262/262 workspace tests.
- `pnpm build` — passed.
- `git diff --check` — passed после удаления generated-only whitespace churn из `packages/db/ERD.md`.
- Anti-weakening scan — passed: в изменённой тестовой поверхности нет `.skip`, `.only`, `xit`, `xdescribe` или `xtest`.
- Session-file safety scan — passed: нет `useMultiFileAuthState`, `auth_info*`, `wa-sessions`, `*.session` и session-артефактов.
- Baileys/socket safety scan — passed: production `makeWASocket` изолирован в connector, `sendMessage()` не добавлен.
- Worker/web surface scan — passed: diff не затрагивает `apps/worker` и `apps/web`; worker default остаётся `MockSessionManager`.
- CI для локального незакоммиченного review-fix не запускался. Удалённый head PR до этих исправлений: `e3b253788e4a3c11eee039d2cdfb0b49ad641344`, старый `quality-gate` был green.

## Покрытие критических контрактов

- Neutral transport boundary возвращает SessionState-compatible результаты `closeTransport(instanceId)` и `logout(instanceId)`.
- Adapter делегирует connect/close/logout и fail-closed отклоняет операции без connector.
- Runtime close вызывает Baileys `end(undefined)`, сохраняет auth-state и не вызывает logout.
- Terminal logout вызывает `logout()`, очищает `WaAuthStateStore` и не дублирует side effects от собственного `logged_out` event.
- Active/opening registries блокируют последовательное и конкурентное двойное владение нормализованным `instanceId`.
- Close/logout используют first-wins terminal reservation; конкурирующие terminal operations завершаются детерминированной ошибкой.
- Ownership сохраняется до фактического `connection.update: close`, даже если `logout()` или `end()` вернули Promise раньше завершения transport cleanup.
- Ошибка logout запускает fallback `end(error)`; ошибка фактического close сохраняет socket в retryable `terminal_failed` и блокирует новый connect.
- Identity gate полностью игнорирует delayed events заменённого socket, включая stale `logged_out`.
- Remote close блокирует reconnect до drain/cleanup; lifecycle callback может безопасно инициировать новый connect после освобождения registry.
- Queued и in-flight `creds.update`/key writes дренируются до close/logout/remote-close; write-after-clear resurrection закрыт.
- Ошибка auth persistence наблюдаема через `onError` и contract rejection, не маскируется успешным close.
- Ошибка auth clear остаётся наблюдаемой, terminal lifecycle event не теряется, а следующий connect сначала повторяет pending clear.
- Transient disconnect доставляется через `onDisconnected` даже при persistence error.
- Missing/repeated close/logout отклоняются `WaTransportNotConnectedError`.
- `no-network.spec.ts` остаётся green; тесты не создают реальное WhatsApp-соединение и ничего не отправляют.

## Ручной QA

- [x] Локально проверен установленный Baileys `7.0.0-rc13`: `logout()` запускает `end()` без await, а фактическое закрытие подтверждается `connection.update: close`.
- [x] Runtime close и terminal logout разведены: close не очищает auth-state.
- [x] Worker default wiring остаётся `MockSessionManager`; real Baileys wiring не добавлен.
- [x] Нет HTTP/UI/QR/send surface, socket autostart или filesystem session path.
- [x] Все тесты используют fake Baileys socket и in-memory auth-state store; реальные WA-аккаунты не использовались.

## Найденные дефекты / решения

- Нормализованная opening reservation закрыла concurrent-connect race до регистрации socket.
- Identity/phase gates закрыли stale socket events и повторные close/logout side effects.
- Serialized event/auth persistence barrier закрыла потерю queued update и credential resurrection после clear.
- Persistence и auth-clear failures стали наблюдаемыми и получили fail-closed recovery/retry paths.
- Actual-close barrier закрыла раннее освобождение ownership из-за асинхронного контракта Baileys `logout()`/`end()`.
- `pnpm build` перегенерировал только whitespace в `packages/db/ERD.md`; файл отформатирован обратно, Prisma schema не менялась.
