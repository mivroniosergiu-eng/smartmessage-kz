# Статус Фазы 1 — WhatsApp-подключения

Дата актуальности: 2026-07-15.

Фаза 1 открыта. Массовые кампании, campaign scheduling, jitter/rate-limit и campaign circuit-breaker остаются вне её scope.

## Закрыто в `main`

- owner registry и guarded lifecycle-команды;
- start/stop/renew queues;
- QR bootstrap persistence и auth-state persistence;
- Baileys auth mapper, connector и session manager;
- transport close/logout contract;
- serialized reconnect supervisor с fail-closed ownership heartbeat.

## Готово в текущем runtime-срезе

- worker собран через единый real Baileys runtime; создание Nest-модуля и чтение состояния не открывают сокет;
- сокет создаётся только после защищённой `start`-команды;
- QR, connected, transient disconnect и logged-out события немедленно передаются единому serialized lifecycle drain;
- transient disconnect до завершения первоначального `connect()` не теряется и запускает один reconnect без logout;
- сохранённый Prisma auth-state подхватывается новым runtime после рестарта процесса;
- устаревший QR очищается и не перекрывает settled status;
- stop/status/reconnect события сериализованы; Redis ownership epoch и Prisma conditional writes не дают stale owner перезаписать status или QR новой сессии;
- старый ownership-loss close полностью завершается до same-process reclaim, поэтому retry старой generation не может закрыть новый transport;
- стабильный `WA_WORKER_ID` deployment-слота защищён Redis exact-token lease; immediate и periodic renew имеют deadline `ttlMs/3`, consumers остаются `autorun: false` до привязки loss-supervisor и проверяют identity перед каждой job; duplicate live process не стартует, потеря/timeout renew fail-closed останавливает intake и transports, а owner queue не растут с каждым рестартом;
- graceful shutdown без ожидания зависших BullMQ jobs останавливает intake обоих workers и активирует bounded physical transport close. Identity lease освобождается только после успешного закрытия sessions и обоих consumers; при ошибке lease сохраняется до TTL, а fatal termination запускается до queue/Redis/Prisma cleanup;
- stop/renew revalidate Redis owner при исполнении; общая BullMQ-job ждёт owner ack в пределах единого deadline для readiness/enqueue/result, переживает падение/migration и привязывает directed job к конкретной epoch. Renew дополнительно получает уникальный per-command id с сохранением между retry, поэтому новый heartbeat в той же epoch не поглощается retained result старой команды.
- явный logout проходит через durable generic → exact owner+epoch job, очищает auth-state/QR без открытия socket для offline-сессии и не понижает `BANNED`;
- Baileys 403/429 классифицируются как `banned`/`restricted`; cooldown имеет безопасный диапазон 1 минута–7 дней, повторное событие не сокращает `restrictedUntil`;
- `RESTRICTED` закрывает transport без logout и восстанавливается через точный delayed BullMQ job; DB-authoritative execution и startup reconciliation исключают ранний/stale reconnect;
- `BANNED` монотонно блокирует producer, execution и ownership start-gates после рестарта; fenced переход создаёт один санитизированный `AuditLog`.

## Остаток до DoD Фазы 1

- receiver skeleton: `messages.upsert/update` → типизированные доменные события без автоответа;
- асинхронная phone validation queue и enum-переходы Contact;
- идемпотентная одиночная text-отправка с `MessageLog`;
- защищённая web-страница WhatsApp: список/status, QR, start/stop/logout, validation и manual single send;
- финальный автоматический QA §3.1/§3.8 и отдельно разрешённый владельцем real-WA smoke-test.

Реальная отправка, QR-сканирование и использование настоящего WA-аккаунта не выполнялись.
