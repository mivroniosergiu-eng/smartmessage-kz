# Переиспользование кода-донора (Ayat / smartmessage-waziper)

Донор: `C:\Users\user\Desktop\project\Ayat\smartmessage-waziper` — рабочий сервис WhatsApp/СМС-рассылок на Node.js. По решению владельца: **дизайн и структура там ужасны, но принцип работы рассылки возьмём; чат-бот ИИ не трогаем — делаем свой лучше.**

Этот документ — карта: какие **паттерны** перенести (с file:line донора как образцом), а какие **проблемы** не повторять (корень «слетают сессии, duplicate starts, Bad MAC»). Не копируем код дословно (он на JS с SQL-интерполяцией, мы пишем на TS/Prisma). Переносим **семантику**.

Стек донора: Express + **Baileys** (`@whiskeysockets/baileys`) + node-cron + OpenAI + MySQL + Bull (задекларирован, но **фактически не используется**). Ключевые файлы: `waziper/waziper.js` (2887 строк, бизнес-логика), `waziper/extend.js` (1617, медиа/AI/spintax/валидация), `waziper/common.js` (578, утилиты), `app.js` (259, точка входа).

**Уточнение после аудита донора 2026-07-02:** Baileys не является гипотезой "с нуля". В доноре уже есть рабочий proof-of-concept рассылки: QR-подключение, сохранение сессии, одиночная/массовая отправка, `onWhatsApp`, spintax, задержки, ротация аккаунтов, история и circuit-breaker. Это снижает риск Фазы −1: проверяем не "можно ли вообще отправлять", а стабильность сессий, reconnect без принудительного QR, повтор отправки после временного сбоя и ban-rate на контролируемой базе. Код донора при этом не становится эталоном архитектуры.

> ⚠️ Это «живой» документ: при переносе каждого паттерна обновлять ссылку на реализацию в новом проекте (`packages/.../file.ts:line`) и отмечать ✅.

---

## TL;DR

| Зона | Решение |
|------|---------|
| Baileys как транспорт | **Использовать** по ADR-0001. Не спорить с выбором канала без новых данных Фазы −1 или решения владельца. |
| QR/reconnect/logout-семантика | **Перенести принцип**: обычный disconnect закрывает только транспорт; `logout()` только явный logout пользователя или подтверждённый `DisconnectReason.loggedOut`. |
| Очередь рассылок | **Не переносить** SQL-polling + `node-cron`. Делать на **BullMQ/Redis** (`AGENTS.md` §14). |
| Троттлинг/jitter/ротация аккаунтов | **Перенести** принцип (`waziper.js:876-887`, `extend.js:447`). |
| Классификация ошибок + circuit-breaker | **Перенести** таксономию (`waziper.js:181-204`, `:38, :891`). |
| Spintax per-message | **Перенести** (`extend.js`, вызовы в `:2168, 2505-2727`). |
| Валидация номеров `onWhatsApp` | **Перенести** принцип, переписать как job-очередь (`extend.js:868-899`). |
| Нормализация номеров/JID | **Перенести** как pure-функции (`common.js:319-436`). |
| Шаблонизатор `%key%` | **Перенести** (`common.js:463-490`). |
| Унифицированный `auto_send` по провайдерам | **Перенести** форму (`waziper.js:1759, 2095`). |
| Модель расписаний/истории/статистики | **Перенести** контур таблиц в Prisma-модели. |
| WA auth-state | **Перенести идею сохранения сессии**, но не полагаться в production только на файлы. Phase −1/dev может стартовать с `useMultiFileAuthState`; production-контур - Redis/БД или атомарное хранилище под sticky owner. |
| Reconnect/`logout()` | **Не переносить** агрессивный reconnect (`waziper.js:308-335`). |
| `retry_onfail` (только реконнект) | **Не переносить**. Делать retry с повтором отправки. |
| `forEach(async)` | **Не переносить**. Строгая очередь/`for...of`. |
| SQL-интерполяция | **Не переносить**. Только Prisma parameterized. |
| Чат-бот ИИ донора | **Не переносить** (решение владельца). Свой. |
| Дизайн/структура UI донора | **Не переносить** (решение владельца). С нуля. |
| Операц. дисциплина (backup/rollback/staging) | **Перенести** (`OPERATIONS.md`, `AGENT_HANDOFF.md`). |

---

## 0. Контракт использования донора для ИИ-агентов

Перед любой задачей по `packages/wa`, рассылкам, подключению WA-аккаунтов или валидации номеров агент обязан считать этот документ входным контекстом.

Разрешённый способ использования:
- брать **поведение** и проверенные сценарии из донора;
- переписывать на TypeScript, Prisma, BullMQ, Redis и zod;
- фиксировать новый контракт тестом до переноса критичной логики;
- оставлять ссылку на источник донора и новую реализацию.

Запрещённый способ использования:
- копировать JS-файлы донора целиком или крупными кусками;
- переносить SQL-строки, query-token API, cron-polling, in-memory progress, chatbot prompts/UI;
- заменять архитектурные решения проекта "как было в Waziper";
- лечить Baileys-сбои простым пересозданием сокета без повторной отправки исходного сообщения.

Короткая формула: **Baileys и полезную механику берём; Waziper-архитектуру, UI и чат-бот не берём.**

---

## 1. Что перенять — подробно

### 1.0. Baileys transport + сессионная семантика
**Донор:** `waziper.js:211-280` создаёт Baileys-сокет через `makeWASocket`, `useMultiFileAuthState(session_dir + instance_id)`, получает WA Web version, подписывается на `creds.update` и сохраняет креды. После фиксов стабильности `closeSessionTransport(instance_id)` (`waziper.js:40-63`) закрывает только локальный транспорт и удаляет in-memory socket, не удаляя файлы сессии. `docs/WHATSAPP_SESSION_STABILITY.md` фиксирует корневую проблему production: duplicate starts, `Bad MAC`, агрессивный reconnect/logout и повторный QR для уже зарегистрированной сессии.

**Перенести как:** `packages/wa/SessionManager` с явной state-machine:
- `connecting` → QR → `connected`;
- transient disconnect/restartRequired/connectionClosed → закрыть транспорт, сериализованно переподключить, креды сохранить;
- QR для уже зарегистрированной сессии не удаляет auth-state и не считается logout;
- `DisconnectReason.loggedOut` или явный logout пользователя → только тогда удалить auth-state и пометить `logged_out`;
- `banned` и `restricted` определяются классификатором ошибок и не смешиваются с обычным reconnect.

**Хранилище:** для Phase −1/dev допустим `useMultiFileAuthState`, потому что он совпадает с рабочим proof-of-concept. Для production Фазы 1 целиться в Redis/БД или другой атомарный adapter auth-state, чтобы избежать рассинхрона файлов при нескольких процессах. В любом варианте socket-life-cycle принадлежит одному sticky owner.

**Тест:** `wa-session-reconnect.spec.ts`: transient disconnect не вызывает `logout()` и не удаляет креды; `wa-session-registered-qr.spec.ts`: QR на зарегистрированной сессии не сбрасывает auth-state; `wa-session-logged-out.spec.ts`: только `DisconnectReason.loggedOut` переводит аккаунт в `logged_out`.

### 1.1. Двухуровневый троттлинг с jitter + ротация аккаунтов
**Донор:** `waziper.js:876-887` — `random_time = rand(max_delay)+min_delay`, следующая отправка не раньше `time_post + random_time`; `next_account++` после каждой отправки, сброс в 0 на конце списка (`:796`).

**Перенести как:** в `packages/queue` — BullMQ-воркер с `limiter: { max, duration }` на уровне WA-аккаунта (глобальный rate-limit, которого у донора нет) **плюс** per-кампания `minDelay/maxDelay` jitter **плюс** round-robin по аккаунтам команды. Сохранить имитацию присутствия (presence/typing) — `extend.js:447-458` — она снижает подозрительность WA.

**Тест:** `broadcast-rate-limit.spec.ts`, `broadcast-jitter.spec.ts` (`TESTING.md` §5.4, §11).

### 1.2. Классификация ошибок отправки + circuit-breaker
**Донор:** `get_send_error_type` (`waziper.js:181-204`) делит ошибки на `media_error` / `session_error` (включая `bad mac`, `no matching sessions`, `timeout`) / `send_error`. Технические сбои копит в `bulks[item.id].technical_failed`; при `>= BULK_TECHNICAL_FAILURE_LIMIT` (=3, `waziper.js:38`) кампания ставится на паузу (`:891-896`).

**Перенести как:** таксономию ошибок — в `packages/shared` (pure-функция `classifySendError(error): SendErrorType`). Circuit-breaker — в `CampaignService`: счётчик `technicalFailed` персистится в БД (не в RAM!), порог настраивается per-кампания или per-команду, триггер → `Campaign.status=paused` + уведомление + `AuditLog`.

**Тест:** `broadcast-circuit-breaker.spec.ts` (`TESTING.md` §5.4).

### 1.3. Spintax per-message на всех полях
**Донор:** пакет `spintax`, вызов `unspin(text)` разворачивает `{вариант1|вариант2}`. Применяется per-сообщение на каждое поле шаблона: `caption` (`:2168`), `title/text/footer` (`:2505,2515,2523,2531`), кнопки (`:2558,2572,2602`), секции list (`:2664-2686`), poll (`:2721-2727`).

**Перенести как:** pure-функцию `unspin(text: string, rng: () => number)` в `packages/shared` (с инжектируемым rng для детерминированных тестов). Вызывать в `packages/wa/Sender` при формировании payload, на каждое поле. Дешёвая и эффективная анти-дубликат-защита.

**Тест:** unit на `unspin` (детерминизм с seeded rng, граничные случаи: нет скобок, вложенные, пустые альтернативы).

### 1.4. Валидация номеров `onWhatsApp` с enum-статусами
**Донор:** `validatePhones` (`extend.js:868`) — фоновый поллинг; `onWhatsApp`-проверка с таймаутом (`extend.js:669-707`); статусы в `sp_whatsapp_phone_numbers.is_valid`: `null`=не проверен / `1`=confirmed / `2`=not_on_whatsapp / `3`=in_progress / `4`=error. Случайный выбор аккаунта для валидации (`extend.js:893`) для размазывания нагрузки.

**Перенести как:** `Contact.isValid` enum в Prisma-схеме (`ARCHITECTURE.md` §6). Валидация — BullMQ-очередь `validate-phone`, не поллинг. Один job на контакт (идемпотентный), round-robin по аккаунтам, таймаут на вызов.

**Реализовано в Фазе 1:** `packages/queue/src/index.ts` задаёт generic и owner-directed contracts; `apps/worker/src/wa/wa-phone-validation-job.processor.ts` выполняет DB-authoritative transitions, Redis round-robin и owner+epoch fence; `packages/wa/src/baileys-connector.ts` вызывает `onWhatsApp` только на активном сокете. Persistence adapter — `PrismaWaPhoneValidationRepository`; `Contact.waValidationRunId` защищает phone/run snapshot от stale completion и BullMQ terminal-failure reconciliation.

**Тест:** queue contract, mock-Baileys integration, worker unit/failure reconciliation, PostgreSQL integration и реальный Redis/BullMQ validation smoke в `packages/queue/src/wa-phone-validation.spec.ts`, `apps/worker/src/wa/wa-phone-validation-job.processor.spec.ts`, `apps/worker/src/wa/prisma-wa-phone-validation.repository.spec.ts`, `apps/worker/src/wa/wa-phone-validation.integration.spec.ts` (`TESTING.md` §11).

### 1.5. Нормализация номеров и разбор JID
**Донор:** `check_especials` (`common.js:319-348`) — исправление специфичных номеров; `get_phone(id, 'wid')` (`common.js:401-436`) — разбор JID `число:индекс@server`. Критично: без нормализации Baileys не доносит.

**Перенести как:** pure-функции `normalizePhone()`, `parseJid()`, `toWhatsAppJid()` в `packages/shared`. Со 100 % unit-покрытием на международном диапазоне кейсов. Не привязывать к «бразильским/мексиканским» хардкодом донора — сделать таблицу правил.

**Тест:** граничные номера, разные форматы, некорректные → явная ошибка.

### 1.6. Шаблонизатор `%key%`
**Донор:** `params` (`common.js:463-490`) — подстановка `%name%`, `%phone%` и т.д. в текст рассылки из данных контакта.

**Перенести как:** `renderTemplate(tpl: string, ctx: Record<string,string>): string` в `packages/shared`. Применять **после** `unspin`. Whitelist ключей (не подставлять произвольные поля →避免 утечки PII). Экранирование.

**Тест:** unit на подстановку, отсутствие ключа, спецсимволы.

### 1.7. Унифицированный `auto_send` по провайдерам
**Донор:** единая точка `auto_send(item)` (`waziper.js:2095`) → сборка payload по `type` → `process_send_message` (`:1759`) → три ветки: Cloud API (`:1769`), Evolution (`:1974`), Baileys (`:2059`).

**Перенести как:** интерфейс `MessageSender` в `packages/wa` с Baileys-реализацией на active owner socket; Cloud API/Evolution остаются будущими слотами. Фаза 1 вызывает `sender.send(payload)` только через exact owner queue, с deterministic message id и `(teamId,idempotencyKey)` `MessageLog` fence. Доменная логика не знает конкретного провайдера; mock interface покрывает безопасный QA без реальной отправки.

**Тест:** контрактный тест на интерфейс + по реализации с mock HTTP.

### 1.8. Контур модели расписаний/истории/статистики
**Донор таблицы:**
- `sp_whatsapp_schedules` — кампании: `status` (0/1/2), `time_post`, `run` (lease), `accounts` (JSON), `next_account`, `schedule_time` (JSON часы), `timezone`, `result` (JSON статусы по номерам), `min_delay/max_delay`, `sent/failed`, `contact_id`, `team_id`.
- `sp_whatsapp_history` — лог отправок: `instance_id, team_id, phone, type, message, status, time_post`.
- `sp_whatsapp_stats` — агрегаты: `wa_total_sent`, `wa_total_sent_by_month`, `wa_bulk_*`.

**Перенести как:** Prisma-модели `Campaign`, `MessageLog`, `Stats` (`ARCHITECTURE.md` §5). Улучшить:
- `status` — enum не числовой, а именованный (`draft|active|paused|completed|failed`).
- `MessageLog.status` расширить до `queued|sent|delivered|read|failed` + `errorType` (донор не различал delivered/read).
- `result` JSON не хранить как ковчег — агрегировать в `Stats`, а per-контакт в `MessageLog`.

### 1.9. Часовые окна расписания
**Донор:** `waziper.js:726-750` — если текущий час (в tz кампании) не входит в `schedule_time`, рассчитывается следующий разрешённый час; если такого нет → `status=completed`. Микро-jitter по минутам (`:737`).

**Перенести как:** `scheduleNextRun(campaign, now)` в `packages/queue`/`shared`. С учётом tz через date-fns-tz или встроенное. Тесты на: переход через полночь, выходные (если будут), смена tz, пустой список часов → completed.

### 1.10. Операц. дисциплина (backup/rollback/staging)
**Донор:** `AGENT_HANDOFF.md` и `docs/OPERATIONS.md` — one-command rollback, SHA256-бэкапы (код+БД+WA-сессии), изолированный staging (отдельный порт/БД, nulled-сессии, выключенные расписания/боты/вебхуки), keepalive с защитой от дубля процесса, явные «не трогать prod без согласия».

**Перенести как:** `AGENTS.md` §19 + `QA_CHECKPOINTS.md` §6. Это оправдавшая себя часть донора.

---

## 2. Что НЕ переносить — корень проблем

### 2.1. SQL-polling как очередь (`waziper.js:703, 2880-2883`)
`SELECT ... WHERE status=1 AND time_post<=now ORDER BY time_post ASC LIMIT 50` каждые 5 сек через `node-cron`. `run`-lease на 300 сек (`:711`) — короткий относительно `max_delay`, поэтому два тика могут взять одну кампанию → **duplicate starts**. Bull декларирован, но мёртв.

**Не повторять.** Очередь — только BullMQ: atomic-take, visibility-timeout, retry/backoff, concurrency — из коробки. Идемпотентность через unique job id.

### 2.2. `forEach(async)` без await (`waziper.js:710, 714, 804`)
Гонки при записи `bulks[item.id]` и `sp_whatsapp_schedules`. Не «параллельность», а потеря контроля.

**Не повторять.** Строгий `for...of` с await или BullMQ worker с явным concurrency.

### 2.3. Прогресс рассылки только в RAM (`bulks = {}`, `waziper.js:24, 756`)
Любой рестарт процесса = обнуление runtime-счётчиков. Прямая причина «слетели сессии/рассылка встала».

**Не повторять.** Состояние — в БД (`Campaign.sent/failed/technicalFailed`) и/или Redis. RAM — только кэш.

### 2.4. `retry_onfail` пересоздаёт сокет, не повторяет отправку (`waziper.js:1712-1714, 2087`)
Сообщение помечается failed и теряется; сокет пересоздаётся.

**Не повторять.** Retry должен повторять **отправку того же сообщения** после реконнекта, с backoff, для `session_error`/`timeout`. Классификация ошибок решает, какой retry уместен.

### 2.5. `Bad MAC` / `no matching sessions` лечатся пересозданием сокета (`waziper.js:190-201, 323-332`)
Корень — рассинхрон signal-key-store при `useMultiFileAuthState` (файлы на диске) + конкурентные реконнекты. `live_back` каждую секунду (`:2744-2776`) может параллельно с `retry_onfail` пересоздать один сокет дважды → снова «conflict: replaced».

**Не повторять.** Auth-state — персистентное атомарное хранилище (Redis или БД, не файлы). Сериализовать рестарты сокета на один instance_id (один маршрут реконнекта). Watchdog — с задержкой, не ежесекундной гонкой.

### 2.6. `logout()` на обычном reconnect (`waziper.js:308-335`, до фикса)
Старый код вызывал `sessions[id].logout()` при reconnect → инвалидация WA-сессии → клиенту приходится сканировать QR заново. (Донор уже патчил это — `closeSessionTransport` вместо `logout` — но мы не наследуем хрупкость.)

**Не повторять.** `logout()` — только по `DisconnectReason.loggedOut` (401) или явному действию пользователя. QR для зарегистрированной сессии не должен удалять креды.

### 2.7. Нет глобального rate-limit
Донер имеет только per-кампанию паузы. N кампаний в одной команде = xN скорости → бан.

**Не повторять.** BullMQ `limiter: { max, duration }` на уровне WA-аккаунта. Плюс token-bucket на команду для защиты тарифа.

### 2.8. SQL-инъекции (`waziper.js:558, 703, 2232`)
Интерполяция значений в SQL-строках. Плюс `multipleStatements:true`, CORS `origin:'*'`, body-лимит 50mb, токены в URL query.

**Не повторять.** Только Prisma parameterized. CORS — белый список origin. Секреты — в заголовках, не в query. См. `AGENTS.md` §13.

### 2.9. Нет graceful shutdown
Донер не ловит SIGTERM/SIGINT; на EADDRINUSE — `process.exit(0)` (`app.js:248-255`). Активные отправки прерываются, WA-сокеты не закрываются чисто.

**Не повторять.** Воркер: перехват сигналов → дождаться текущих job'ов → закрыть WA-сокеты → выйти.

### 2.10. Чат-бот ИИ донора и UI/структура донора
**По решению владельца не переносим.** Чат-бот делаем свой (лучше). Дизайн/структуру — с нуля. Это явно отмечено, чтобы не возникло соблазна «скопировать рабочий кусок».

---

## 3. Маппинг таблиц донора → модели нового проекта

| Донор (таблица) | Новый проект (Prisma-модель) | Примечание |
|---|---|---|
| `sp_team` | `Team` | `accessToken` — в заголовке, не в query |
| `sp_users` | `User` | + `role`, `expirationDate` |
| `sp_whatsapp_schedules` | `Campaign` | `status` enum, не число; `technicalFailed` персистить |
| `sp_whatsapp_history` | `MessageLog` | `status` расширен, `errorType` добавлен |
| `sp_whatsapp_stats` | `Stats` | агрегаты на команду |
| `sp_whatsapp_phone_numbers` | `Contact` | `isValid` enum |
| `sp_accounts` | `WaAccount` | `loginType` enum (baileys/cloud_api/evolution) |
| `sp_whatsapp_sessions` | `WaSession` | auth-state в Redis, не только файлы |
| `sp_whatsapp_chatbot` | `ChatBotRule` | своя реализация бота |
| `sp_whatsapp_autoresponder` | `AutoResponder` | throttle по `lastResponsePerContact` |
| `sp_whatsapp_template` | `Template` | + `spintaxEnabled` |
| `sp_whatsapp_webhook` | `Webhook` | исходящие вебхуки наружу |
| `sp_whatsapp_ai` | (часть `packages/ai` config) | своя реализация |
| — (новое) | `Subscription`, `Permissions` | биллинг ($200–1000) |
| — (новое) | `Lead`, `CalendarItem`, `PipelineStage` | CRM-ядро |
| — (новое) | `AdCampaign`, `Creative` | Этап 1 |
| — (новое) | `Course`, `CourseItem` | Этап 4 |
| — (новое) | `AuditLog`, `AiCallLog` | аудит и логирование LLM |

---

## 4. Чек-лист переноса (для работы по фазам)

При реализации каждого элемента отмечать:
- [ ] паттерн перенят семантически (не копией кода);
- [ ] переписан на TS с типами;
- [ ] SQL → Prisma parameterized;
- [ ] состояние в БД/Redis, не в RAM;
- [ ] идемпотентность обеспечена;
- [ ] retry с повтором отправки (где применимо);
- [ ] unit/интеграционный тест написан;
- [ ] соответствующий антипаттерн донора учтён защитным тестом (`TESTING.md` §11);
- [ ] ссылка на новую реализацию добавлена в этот документ.

---

## 5. Источники донора (для справки)

- `C:\Users\user\Desktop\project\Ayat\smartmessage-waziper\waziper\waziper.js` — бизнес-логика рассылок, Baileys, cron.
- `C:\Users\user\Desktop\project\Ayat\smartmessage-waziper\waziper\extend.js` — медиа, AI, spintax, валидация номеров.
- `C:\Users\user\Desktop\project\Ayat\smartmessage-waziper\waziper\common.js` — утилиты, нормализация номеров, шаблоны.
- `C:\Users\user\Desktop\project\Ayat\smartmessage-waziper\app.js` — точка входа, HTTP API.
- `C:\Users\user\Desktop\project\Ayat\smartmessage-waziper\config.example.js` — конфиг.
- `C:\Users\user\Desktop\project\Ayat\AGENT_HANDOFF.md` — прод-контекст, VPS, известные проблемы.
- `C:\Users\user\Desktop\project\Ayat\smartmessage-waziper\docs\OPERATIONS.md` — операционка.
- `C:\Users\user\Desktop\project\Ayat\smartmessage-waziper\docs\WHATSAPP_SESSION_STABILITY.md` — фиксы стабильности сессий.

> ⚠️ Донор содержит production-контекст (VPS IP, пути, упоминание пароля в `SSH.md`). Не копировать эти данные в новый репозиторий, доки, коммиты, логи. Секреты — только в env нового проекта.
