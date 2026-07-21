# Статус Фазы 1 — WhatsApp-подключения

Дата актуальности: 2026-07-22.

Функциональный скоуп Фазы 1 реализован и прошёл локальные автотесты и owner-authorized real-WA QA в текущем worktree. Формально Фаза 1 остаётся открытой до обязательных review → commit → PR → серверный CI → merge gates; утверждать полный Done до CI нельзя. Массовые кампании, campaign scheduling, jitter/rate-limit и campaign circuit-breaker остаются вне её scope.

## Закрыто в `main`

- owner registry и guarded lifecycle-команды;
- start/stop/renew queues;
- QR bootstrap persistence и auth-state persistence;
- Baileys auth mapper, connector и session manager;
- transport close/logout contract;
- serialized reconnect supervisor с fail-closed ownership heartbeat.

## Готово в текущем runtime-срезе

- worker по умолчанию использует `WA_SESSION_RUNTIME=mock`: `MockSessionManager` сохраняет lifecycle/ownership-контур, а phone validation и send остаются fail-closed unavailable без реального transport;
- real Baileys runtime включается только точным `WA_SESSION_RUNTIME=baileys` для явно разрешённого owner smoke-test; неизвестное значение блокирует startup;
- Baileys ESM transport загружается лениво только в opt-in runtime и после защищённой `start`-команды; обычный worker bootstrap не открывает сокет;
- QR, connected, transient disconnect и logged-out события немедленно передаются единому serialized lifecycle drain;
- transient disconnect до завершения первоначального `connect()` не теряется и запускает один reconnect без logout;
- в opt-in Baileys runtime сохранённый Prisma auth-state подхватывается после рестарта процесса; at-rest payload защищён versioned AES-256-GCM envelope с AAD по `instanceId`, real runtime требует отдельный 32-byte env-key и не допускает plaintext fallback; legacy JSON мигрирует в envelope при первом чтении, а owner-authorized post-migration restart подтвердил чтение ciphertext и `CONNECTED` без нового QR;
- устаревший QR очищается и не перекрывает settled status;
- stop/status/reconnect события сериализованы; Redis ownership epoch и Prisma conditional writes не дают stale owner перезаписать status или QR новой сессии;
- старый ownership-loss close полностью завершается до same-process reclaim, поэтому retry старой generation не может закрыть новый transport;
- стабильный `WA_WORKER_ID` deployment-слота защищён Redis exact-token lease; immediate и periodic renew имеют deadline `ttlMs/3`, consumers остаются `autorun: false` до привязки loss-supervisor и проверяют identity перед каждой job; duplicate live process не стартует, потеря/timeout renew fail-closed останавливает intake и transports, а owner queue не растут с каждым рестартом;
- graceful shutdown без ожидания зависших BullMQ jobs останавливает intake всех lifecycle, phone-validation и single-send workers и активирует bounded operation drain + physical transport close; never-settling `sendMessage`, auth-state write или Baileys `logout()` не блокируют stop/logout/remote-close бесконечно. Таймаут auth persistence сохраняет transport в fail-closed `terminal_failed`, не очищает потенциально перезаписываемый auth-state и запрещает reconnect до безопасного повторного drain; неоднозначная отправка остаётся честным `DISPATCHING`/ambiguous. Identity lease освобождается только после успешного закрытия sessions и всех consumers; при ошибке lease сохраняется до TTL, а fatal termination запускается до queue/Redis/Prisma cleanup;
- stop/renew revalidate Redis owner при исполнении; общая BullMQ-job ждёт owner ack в пределах единого deadline для readiness/enqueue/result, переживает падение/migration и привязывает directed job к конкретной epoch. Renew дополнительно получает уникальный per-command id с сохранением между retry, поэтому новый heartbeat в той же epoch не поглощается retained result старой команды.
- явный logout проходит через durable generic → exact owner+epoch job, очищает auth-state/QR без открытия socket для offline-сессии и не понижает `BANNED`;
- Baileys 403/429 классифицируются как `banned`/`restricted`; cooldown имеет безопасный диапазон 1 минута–7 дней, повторное событие не сокращает `restrictedUntil`;
- `RESTRICTED` закрывает transport без logout и восстанавливается через точный delayed BullMQ job; DB-authoritative execution и startup reconciliation исключают ранний/stale reconnect;
- `BANNED` монотонно блокирует producer, execution и ownership start-gates после рестарта; fenced переход создаёт один санитизированный `AuditLog`.
- `messages.upsert/update` единственного активного socket-generation преобразуются в нормализованные типизированные domain batch-события; malformed records фильтруются, consumer failure не рвёт event stream, raw Baileys payload и автоответ отсутствуют.
- `validate-phone` — durable BullMQ queue с одним stable job-id на tenant/contact и retry/backoff. Контакт атомарно проходит `NULL/ERROR → IN_PROGRESS → CONFIRMED/NOT_ON_WHATSAPP`, а после последней неуспешной попытки — `ERROR`; окончательно failed job удаляется, поэтому явный новый enqueue после `ERROR` запускает новую проверку, а terminal status повторно не вызывает внешний transport;
- generic validation job выбирает только `CONNECTED`-аккаунты своей команды через распределённый Redis round-robin cursor, сверяет live ownership и направляет `onWhatsApp` в exact owner queue с epoch-fence. Directed result дедуплицируется в пределах одного validation run, но новая проверка после `ERROR` получает новый run-id;
- `onWhatsApp` использует только уже открытый owner socket, нормализует KZ-номер и ограничен 10-секундным timeout. Validation consumers входят в identity-loss fail-closed и graceful shutdown; сокет ради проверки не открывается.
- `wa-single-send` реализует at-most-once text-отправку только для контакта со статусом `CONFIRMED`: web, generic repository и exact-owner boundary fail-closed повторно проверяют validation state. `(teamId,idempotencyKey)` уникален в `MessageLog`, generic→exact owner queue сохраняет tenant/owner/epoch fence, а owner перед provider-вызовом атомарно переводит `QUEUED → DISPATCHING` и фиксирует `dispatchAttemptedAt`. После provider ack owner завершает `DISPATCHING → SENT`; retry/рестарт для `DISPATCHING` не выполняет повторную отправку и сообщает `delivery_ambiguous` для ручной сверки. Final/stalled failure до dispatch переводит `QUEUED` в `FAILED`.
- startup/periodic terminal-failure reconciler повторно обрабатывает retained failed phone-validation/single-send jobs после временного сбоя БД; overlap сериализован, а неоднозначные `DISPATCHING` отправки не понижаются в ложный `FAILED`.
- worker защищёнными internal routes принимает только server-to-server команды validation/send; web `/dashboard/whatsapp` повторно проверяет session, team membership и принадлежность аккаунта/контакта перед каждым вызовом, токен worker остаётся server-side.
- web `/dashboard/whatsapp` позволяет создать account в пределах `maxWhatsappAccounts`, вести lifecycle-команды и автоматически обновляет connecting status; worker admin adapter повторно проверяет тарифный лимит.
- свежий QR локально преобразуется в сканируемый SVG через `qrcode.react` прямо в web-приложении, обновляется вместе с connecting status и не передаётся внешнему QR-сервису; raw pairing payload больше не показывается пользователю.
- owner-authorized real-WA QA подтвердил полный QR connect: после pairing обязательный Baileys transport restart восстанавливается автоматически, статус становится `CONNECTED`, QR очищается;
- crash/restart smoke подтвердил persistence: новый worker с тем же стабильным identity восстановил подключение из Prisma auth-state без повторного QR.
- owner-authorized real phone validation прошла полный generic → exact-owner BullMQ path и завершила self-contact статусом `CONFIRMED`;
- owner-authorized single-send создала одну `MessageLog` со статусом `SENT` и provider message id; повторная постановка того же idempotency key сохранила одну terminal-запись без нового side effect по worker/DB evidence;
- production-подобный real-WA QA обнаружил и закрыл отсутствующие explicit Nest injection metadata у operations controller и validation account selector; runtime regression-test теперь защищает эти constructor boundaries.
- transitive `libsignal` больше не выводит Signal session objects и cryptographic material в runtime console: воспроизводимый pnpm patch сохраняет только безопасные сообщения, regression-test проверяет установленную зависимость.

## Остаток до появления в `main`

- отдельный review текущего большого Phase 1 diff;
- ветка → PR → зелёный серверный CI → merge после разрешения review threads. Campaign gating остаётся Фазой 3.

Owner-authorized real Baileys QR/restart, phone validation, single-send и web status подтверждены на настоящем WA-аккаунте. Сообщение пришло ровно один раз; `MessageLog` содержит одну terminal `SENT`-запись. Полный workspace test/typecheck/lint/build, coverage и Playwright прошли на изолированных test-БД/test-Redis.
