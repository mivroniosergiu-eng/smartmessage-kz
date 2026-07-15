# ADR-0001. WhatsApp-канал и владение процессами

Статус: принято. Дата: 2026-06-30.

## Контекст

Платформа делает массовые рассылки и квалификацию лидов в WhatsApp. Официальный WhatsApp Cloud API требует ресурсов (модерация шаблонов, обязательный opt-in, бюджет), которых на текущем этапе нет.

В распоряжении проекта есть донор `C:\Users\user\Desktop\project\Ayat\smartmessage-waziper`: качество сайта, UI и чат-бота не переносится, но WhatsApp-рассылка через Baileys там уже работает как proof-of-concept. Аудит донора показал полезные механики (QR, сохранение сессии, `onWhatsApp`, spintax, jitter, ротация аккаунтов, история, circuit-breaker) и опасные причины нестабильности (duplicate starts, агрессивный reconnect/logout, `Bad MAC`, потеря отправки при retry).

## Решение

На текущем этапе используем **Baileys (неофициальный WA Web)**.

- Антибан-логика (jitter между сообщениями, ротация аккаунтов, дневные лимиты, прогрев номеров, реакция на состояния `restricted`/`banned`) — это **митигация риска, а не гарантия**. Ban-risk и нарушение ToS WhatsApp осознаны и приняты владельцем.
- Выбор Baileys не является открытым вопросом для каждого следующего агента. Пересматривать канал можно только по новым данным Фазы −1, по решению владельца или при переходе на официальный Cloud API.
- **Владение процессами:** один WA-аккаунт (`instanceId`) обслуживается строго одним воркер-процессом (**sticky ownership**). Маппинг `instanceId → workerId` хранится в **Redis-реестре**. От распределённого лока на инициализацию (Redlock) отказываемся в пользу владения процессом — это убирает гонки за auth-state и конфликты сессий. Запрещено хаотично поднимать сокет из произвольных BullMQ-джобов.
- Каждый новый claim ownership получает монотонную epoch. Renew/release и shared persistence выполняются только для точной пары `workerId + epoch`; новый owner активирует DB-fence до открытия сокета. Это запрещает запоздалым status/QR mutations старого процесса перезаписывать новую сессию.
- Общая lifecycle job остаётся durable coordinator до подтверждения owner-specific job. При ack-timeout она заново читает ownership; directed job несёт ожидаемые owner+epoch и становится no-op при смене generation. Поэтому падение owner не теряет команду, а осиротевший старый stop/renew не применяется к новой сессии.
- `WA_WORKER_ID` задаёт стабильный deployment-slot и переиспользуется его последовательными process generations. Одновременно живые процессы не могут разделять ID: startup до runtime занимает Redis lease через `SET NX PX` с уникальным process-token и подтверждает immediate renew; immediate/periodic renew ограничены fail-closed deadline `ttlMs/3`. Consumers создаются с `autorun: false`, запускаются после привязки loss-supervisor и проверяют identity перед каждой job. Renew/release выполняются только для exact token, потеря или зависание renew one-shot закрывает intake и transports. Graceful shutdown удаляет lease только после успешного физического session close и закрытия обоих consumers; иначе renewal останавливается, lease остаётся до TTL и fatal termination начинается до внешнего cleanup. Owner queue поэтому ограничены числом слотов, а ACK retention — 300 секундами и 1000 results на очередь.
- Auth-state сессий персистится. Для Phase −1/dev допустим файловый baseline `useMultiFileAuthState`, потому что он совпадает с рабочим донором. Для production Фазы 1 целевой контур - Redis/БД или другой атомарный adapter auth-state под sticky owner.
- Обычный transient disconnect/restartRequired/connectionClosed закрывает только транспорт и запускает сериализованный reconnect. `logout()` и удаление auth-state допустимы только по явному действию пользователя или подтверждённому `DisconnectReason.loggedOut`.
- Retry после временного сбоя обязан повторить отправку того же сообщения после reconnect/backoff. Простое пересоздание сокета без повторной отправки считается дефектом.

## Последствия / триггер пересмотра

Если спайк (`../ROADMAP.md`, Фаза −1) покажет ban-rate выше зафиксированного порога или появится бюджет — мигрируем на официальный Cloud API. Тогда этот ADR заменяется новым.
