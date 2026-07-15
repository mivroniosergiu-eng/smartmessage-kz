# QA-run: Baileys-backed session manager — 2026-07-15

- Исполнитель (агент/человек): Codex task-agent + независимый review-субагент
- Ветка: `feat/phase-1-baileys-session-manager`
- PR: [#24](https://github.com/mivroniosergiu-eng/smartmessage-kz/pull/24)

## Автотесты

- TDD red: `pnpm --filter @smartmessage/wa test -- baileys-session-manager.spec.ts` — expected failure: модуль `baileys-session-manager` отсутствовал до реализации.
- Race TDD red: та же команда — expected failure 1/22: terminal callback не мог запустить reconnect до завершения исходного `connect()`.
- Review-fix TDD red: та же команда — expected failure 11/33: терялись post-terminal persistence errors, terminal failure блокировал recovery, offline close/logout не были идемпотентны, public disconnect снимал reservation, duplicate open повторял observer, banned позволял reconnect и auth-state не сверялся после failed logout.
- Additional review-fix TDD red: та же команда последовательно подтвердила stale auth reconciliation, незавершённый `not_connected` terminal retry, потерю callbacks после rejected recovery connect и downgrade terminal states через legacy handler.
- Review-fix TDD green: та же команда — passed, 38/38.
- `pnpm --filter @smartmessage/wa test` — passed, 150/150.
- `pnpm --filter @smartmessage/wa lint` — passed.
- `pnpm --filter @smartmessage/wa typecheck` — passed.
- `pnpm --filter @smartmessage/worker test` — passed, 86/86; локальный `DATABASE_URL` передан процессу из существующего ignored env-файла без вывода значения.
- `pnpm --filter @smartmessage/worker lint` — passed.
- `pnpm typecheck` — passed для всех workspace-пакетов.
- `pnpm lint` — passed для всего workspace без warnings.
- Финальный `pnpm test` — passed, 300/300 workspace tests.
- Финальный `pnpm build` — passed для всех workspace-пакетов; generated-only whitespace в `packages/db/ERD.md` отформатирован обратно, Prisma schema не менялась.
- `git diff --check` — passed.
- Task-file Prettier check — passed для четырёх файлов задачи; общий `pnpm format` остаётся красным на 90 существующих baseline-файлах, unrelated formatting не применялся.
- Anti-weakening scan — passed: в новом тесте нет `.skip`, `.only`, `xit`, `xdescribe` или `xtest`.
- Secret/session-file scan — passed: реальные ключи/URL, `auth_info*`, `wa-sessions` и `*.session` не добавлены.
- Forbidden-surface scan — passed: нет `sendMessage`, `useMultiFileAuthState`, прямого `makeWASocket`/Baileys/Prisma import, HTTP/UI/QR endpoint или socket autostart.
- CI и CodeRabbit — ожидают публикации PR.

## Покрытие критических контрактов

- Начальное состояние определяется через provider-neutral `WaAuthStateStore`: `idle` без auth-state, `disconnected` при сохранённом auth-state после рестарта.
- `connect()` регистрирует `connecting`, а `connected` публикуется только транспортным open-event.
- QR, connected, disconnected, logged-out и error события получают изолированный snapshot состояния с нормализованным `instanceId`.
- Transient/restart/connection-closed сохраняют auth-state; restricted/banned получают отдельные статусы; remote logged-out терминален и не вызывает второй transport logout.
- Explicit close/logout делегируются транспорту ровно один раз; logout-счётчик не доверяет transport snapshot и увеличивается один раз на уровне менеджера.
- First-wins reservation блокирует конкурирующие команды; generation gate полностью игнорирует delayed callbacks старого транспорта.
- Terminal callback освобождает поколение до observer callback, поэтому lifecycle может безопасно запустить reconnect без ожидания позднего результата старого `connect()`.
- Post-terminal persistence/auth errors старого транспорта доставляются с сохранённым terminal snapshot и не меняют уже переподключённую сессию.
- Offline/repeated close/logout идемпотентны; logout без активного socket очищает provider-neutral auth store напрямую.
- После uncertain terminal rejection auth-state сверяется со store, а следующий connect допускается до authoritative transport guard; banned reconnect отклоняется fail-closed.
- Stale async auth reconciliation повторно проверяет generation и не меняет новую сессию; `not_connected` на terminal retry подтверждает idempotent close/logout recovery.
- `already_connected` на recovery возвращает ownership старым callbacks и закрывает дальнейшие лишние connect-attempts; terminal banned/logged-out не понижаются legacy disconnect-handler'ом.
- Ошибки transport-команд не публикуют ложный success-state; rejected observer направляется в `onError` без unhandled rejection.
- Публичные snapshots клонируются и не позволяют мутировать внутреннее состояние.

## Ручной QA

- [x] Проверена package boundary: менеджер зависит только от neutral transport/auth/session contracts; Prisma и прямой Baileys import отсутствуют.
- [x] Worker/web wiring не менялось; worker default остаётся `MockSessionManager`.
- [x] Тесты используют fake transport и in-memory auth store; реальный WA-аккаунт и сеть не использовались.
- [x] HTTP/UI/QR endpoint, send surface, socket autostart и filesystem session storage не добавлены.

## Найденные дефекты / решения

- Generation reservation изначально сохраняла поколение до старта `connect()` и не освобождалась terminal callback; reservation синхронизирована с новым поколением и покрыта отдельным race-тестом.
- Два независимых review-субагента нашли post-terminal error loss, partial-terminal recovery wedge, stale reconciliation TOCTOU и terminal-state downgrade; все конкретные findings закрыты TDD. Финальный повторный агентский verdict не получен из-за исчерпания лимита субагентов, поэтому PR остаётся под обязательным CI/CodeRabbit review.
- Изолированный worktree не наследовал локальный Prisma env. Для интеграционного прогона значение было передано только дочернему процессу из существующего ignored env-файла; секрет не копировался, не логировался и не добавлялся в git.
