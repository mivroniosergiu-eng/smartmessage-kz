# QA-run: Phase 1 single-send и защищённая WhatsApp web-страница — 2026-07-16

Последнее обновление фактического real-WA прогона: 2026-07-22.

- Исполнитель: Codex task-agent; review выполнен subagent-аудитами и targeted tests
- Ветка: `feat/phase-1-wa-phone-validation`
- PR/CI: PR #29; серверный `quality-gate` passed, CodeRabbit check completed, unresolved review threads: 0

## Автотесты

- Queue contracts: `pnpm --filter @smartmessage/queue test` — passed, 26/26.
- WA transport/sender: `pnpm --filter @smartmessage/wa test` — passed, 252/252.
- Worker на отдельной `smartmessage_test` и Redis DB 15: `pnpm --filter @smartmessage/worker test` — passed, 254/254.
- Web/auth/middleware/actions: `pnpm --filter @smartmessage/web test` — passed, 41/41.
- Playwright: `pnpm test:e2e` — passed, 2/2 (protected dashboard link, tenant-filtered WA account/contact/QR rendering; no real worker/WA).
- Workspace на отдельной test-БД/test-Redis: `pnpm test` — passed, 620/620 (shared 42, queue 26, db 5, WA 252, web 41, worker 254).
- TypeScript: `pnpm typecheck` — passed.
- Lint: `pnpm lint` — passed без warnings.
- Build: `pnpm install --frozen-lockfile && pnpm build` — passed для всех workspace-пакетов после финального runtime/safety hardening.
- Coverage: `pnpm test:cov` — passed; shared 97.60% statements / 92.64% branches, queue 96.40% / 92.53%, WA 91.75% / 83.94%, worker 92.95% / 86.77% (worker `src/wa`: 93.16% / 86.75%).
- Prisma: `prisma migrate deploy` и `prisma validate` — passed; migration `20260722150000_add_single_send_dispatch_fence` добавляет отдельный `DISPATCHING` status и `dispatchAttemptedAt`; DB integration 5/5 подтверждает их фактическую персистентность.
- `git diff --check` — passed.
- Anti-weakening scan (`.skip/.only/xit`), secret/session-file scan и forbidden WA surface diff scan — clean.

## Что проверено

- `MessageLog` получает обязательный `(teamId, idempotencyKey)` fence и provider message id; повторный enqueue того же ключа не создаёт второй log/side effect.
- Конфликтующий payload с тем же idempotency key получает отдельный hash-fenced job id и отклоняется repository conflict-check, а worker boundary ограничивает размеры строк.
- Generic `wa-single-send` job маршрутизирует команду в exact owner queue (`workerId + epoch`), не открывает новый socket и использует deterministic message id на retry.
- До provider-вызова owner атомарно ставит durable fence `QUEUED → DISPATCHING` с `dispatchAttemptedAt`; после provider ack тот же owner завершает `DISPATCHING → SENT`. Crash/timeout после fence остаётся честным `delivery_ambiguous`: retry не маршрутизирует и не отправляет сообщение повторно, а запись требует ручной сверки. Это сознательный at-most-once trade-off: редкий crash до фактического provider-вызова может потерять одну отправку, но не создать дубль.
- Startup/periodic terminal-failure reconciler повторяет DB-завершение retained failed validation/send jobs после временного сбоя; overlapping sweeps сериализованы, `DISPATCHING` не понижается в ложный `FAILED`.
- Connector сериализует accepted send перед stop/logout, а send, auth persistence, remote-close tail и Baileys `logout()` ограничены bounded timeout: зависшая операция не блокирует terminal command навсегда. Auth write timeout оставляет transport fail-closed и не очищает state до безопасного drain; доставка остаётся `DISPATCHING`/ambiguous без автоматического повтора.
- Повторный idempotency request для уже повышенного `DELIVERED`/`READ` лога трактуется как terminal `sent` и не маршрутизируется повторно.
- Mock Baileys sender и реальный Redis/BullMQ integration smoke проходят через один owner socket path; final/stalled failure переводит `QUEUED` в `FAILED`.
- Internal worker routes для validation/send закрыты `InternalWorkerApiGuard`; team выводится/проверяется в worker DB.
- Новый single-send разрешён только для contact `CONFIRMED`; web, generic repository и exact-owner boundary повторно проверяют статус, а terminal/ambiguous idempotent replay не создаёт новый side effect.
- `/dashboard/whatsapp` защищён middleware и page-level Prisma membership check; server actions повторно проверяют team-scoped account/contact, worker token не уходит в браузер.
- Malformed form data безопасно возвращает пользовательскую ошибку без raw 500 и worker-вызова; web→worker client отдельно проверен на secret header, timeout, HTTP-error mapping и schema rejection.
- Страница показывает tenant-scoped account status, QR payload, start/stop/logout, async validation и manual single-send.
- Страница создаёт account только в пределах тарифного лимита; dashboard содержит ссылку на WA page; connecting accounts обновляются через безопасный server refresh.
- Worker bootstrap проверен на Node 24 через production dev-path `tsx/cjs`. Безопасный default `WA_SESSION_RUNTIME=mock` не создаёт Baileys connector; real runtime доступен только по точному `WA_SESSION_RUNTIME=baileys` и даже тогда не открывает socket до explicit `start`.

## Ручной QA / owner decision

- [x] Владелец явно разрешил real-WA phone validation и одну отправку текста `Тест SmartMessage` в self-chat подключённого аккаунта.
- [x] Реальный QR smoke завершён: account status `CONNECTED`, auth-state пережил перезапуск, новый QR не потребовался.
- [x] Реальный `onWhatsApp` завершил контакт статусом `CONFIRMED` через generic → exact-owner BullMQ path.
- [x] Фактическая single-send завершилась `MessageLog.status=SENT`; сохранён provider message id, payload совпал, `(teamId,idempotencyKey)` представлен ровно одной строкой.
- [x] Повторная постановка точно того же запроса с тем же idempotency key сохранила одну строку `SENT` и не создала новый side effect по данным worker/БД.
- [x] Владелец визуально подтвердил на телефоне, что self-chat получил текст ровно один раз.
- [x] Владелец визуально подтвердил web-состояния: account `connected`, QA-contact `confirmed`.
- [x] Свежий QR отображается локальным `QRCodeSVG`; pairing payload не передаётся внешнему QR-сервису.

## Найденные runtime-дефекты / решения 2026-07-22

- `WaOperationsController` терял четыре constructor dependencies в production-подобном `tsx/cjs` runtime, хотя unit-тесты создавали controller вручную. Реальный validation endpoint возвращал `500` до постановки job. Добавлены явные `@Inject(...)` и runtime regression-contract.
- `WaPhoneValidationAccountSelector` тем же образом терял Prisma repository; BullMQ retry оставлял контакт в `IN_PROGRESS`. Repository теперь имеет явный injection token, runtime-contract охватывает selector.
- Ни один из двух дефектов не дошёл до `onWhatsApp` или `sendMessage`; после TDD red→green и перезапуска worker real validation завершилась `CONFIRMED`, затем была выполнена единственная разрешённая отправка.
- Transitive `libsignal@6.0.0` печатал целый Signal session object при закрытии/открытии сессии. Добавлен воспроизводимый pnpm dependency patch, который сохраняет диагностическое сообщение без объекта; статический regression-тест запрещает возврат session object в `console.info/warn`.
- Crash-gap single-send раньше оставлял attempted delivery в обычном `QUEUED`, из-за чего истечение retained owner-result теоретически позволяло новый provider side effect. Добавлены отдельный `DISPATCHING` enum/CAS fence и owner-side `markSent`; regression-тесты покрывают crash до provider, provider ack + DB outage и повторную подготовку ambiguous-записи.
- BullMQ `failed` listener не гарантирует успешную запись terminal state при кратком сбое БД. Retained failed jobs теперь сверяются при startup и каждые 30 секунд до успешного reconciliation; тест имитирует первый DB outage и успешный следующий sweep.
- Первый вариант send/close serialization ждал provider promise без deadline. Добавлен bounded operation drain: по timeout connector фиксирует санитизированную ошибку и форсирует физический close; regression-тест использует never-settling `sendMessage` и подтверждает завершение stop.

## Safety-scope

- Не добавлены массовые рассылки, campaign scheduling, jitter/rate-limit/circuit-breaker.
- Real WA account использован только в локальном owner-authorized smoke-test; secrets, session files и номера не добавлены в git/документацию, browser→worker token exposure отсутствует.
- Не добавлены внешние QR APIs; единственная новая production dependency `qrcode.react` явно разрешена владельцем и используется только для локального SVG-рендера QR в web.
- Отправлен только один разрешённый self-chat текст; campaign/bulk отправки не запускались.
