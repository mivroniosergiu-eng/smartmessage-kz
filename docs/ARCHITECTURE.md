# Архитектура Smartmessage.kz

Долговечный контекст: монорепо, слои, потоки данных, модель. Детали реализации — в коде; здесь — что нужно знать, чтобы не наделать структурных ошибок. Правила разработки — в `../AGENTS.md`. Что перенято из донора — в `REUSE_DONOR.md`.

---

## 1. Контекст проекта

B2B SaaS-платформа — сквозная экосистема из 5 этапов (см. `../first plan.md` и `ROADMAP.md`):

1. **Трафик:** ИИ-таргетолог генерирует креативы и запускает рекламные кампании в Instagram/Facebook/TikTok → лиды падают в чат → крепятся в CRM.
2. **Ядро:** CRM + календарь + чат-бот. Чат-бот квалифицирует лида, заполняет календарь, шлёт уведомления. Менеджеры ведут лида по воронке.
3. **Дожим:** массовые рассылки по базе (WhatsApp) для реанимации отказников и допродаж.
4. **Обучение:** контент-хаб (курсы, гайды, медиа от наставников), обновляется каждые 2 недели — повышает LTV и удержание.
5. **Монетизация:** подписка $200–1000/мес.

Ключевое ограничение: **деньги, рассылки, база клиентов, внешние API, ИИ-агенты**. Ошибки в этих зонах стоят дорого → повышенные требования к тестам, идемпотентности, безопасности (см. `AGENTS.md` §11, §13, §14).

---

## 2. Монорепо (pnpm workspace)

```
/
├── apps/
│   ├── web/            # Next.js (App Router): фронтенд + BFF + Server Actions
│   └── worker/         # NestJS: очереди, рассылки, ИИ-агенты, cron, WA-воркеры
├── packages/
│   ├── db/             # Prisma schema, миграции, клиент, seed, типы
│   ├── wa/             # Baileys: сессии, отправка, приём, валидация номеров, presence
│   ├── queue/          # BullMQ: очереди рассылок, идемпотентность, троттлинг, retry
│   ├── ai/             # ИИ-агенты: таргетолог, чат-бот, копирайтер (LLM-обёртки)
│   └── shared/         # Контракты, zod-схемы, утилиты, нормализация номеров, spintax
├── docs/               # Этот набор документов
├── AGENTS.md           # Правила
└── first plan.md       # Бизнес-план экосистемы
```

### Почему так

- **`apps/web` + `apps/worker` разделены**: веб-запросы (быстрые, пользовательские) отделены от долгих фоновых задач (рассылки, генерация, опрос внешних API). Веб не должен тормозить из-за того, что воркер шлёт 10 000 сообщений.
- **`packages/*` переиспользуются** между web и worker. Контракты — в `shared`, чтобы фронт и бэк не разъехались.
- **`packages/db` единственный** владелец Prisma schema. Никаких SQL-строк вне его.

---

## 3. Слои и ответственности

### apps/web (Next.js)
- **Routes (App Router)**: страницы, layout'ы, guards (auth/subscription).
- **Server Components**: читают данные через `packages/db` и сервисы.
- **Server Actions**: мутации от форм (создание кампании, сохранение лида, смена тарифа). Каждая — с zod-валидацией и auth-проверкой.
- **API routes**: тонкие, для вебхуков внешних сервисов (WA incoming, Meta ad lead, платёжный webhook MoR).
- **Client**: React-компоненты, React Query для кэша/инвалидации, optimistic UI где уместно.

### apps/worker (NestJS)
- **BullMQ workers**: потребляют очереди из `packages/queue` — отправка рассылок, валидация номеров, генерация креативов.
- **Cron/scheduler**: запуск отложенных и повторяющихся задач (ежедневные прогревы, обновление контента).
- **WA-менеджер**: через `packages/wa` — жизнь сессий Baileys, reconnect, watchdog, отправка.
- **ИИ-сервисы**: через `packages/ai` — вызовы LLM с retry, cost guard, валидацией ответа.
- **Graceful shutdown**: SIGTERM/SIGINT → дождаться текущих job'ов → закрыть WA-сокеты → выйти.

### packages/db (Prisma)
- Единственное место со схемой и миграциями.
- Модели (см. §5) — мульти-тенантные через `teamId`.
- Seed — для dev/staging; никогда не содержит реальных данных.

### packages/queue (BullMQ)
- Определения очередей: `broadcast`, `validate-phone`, `ai-generate`, `ad-publish`, `notification`.
- Идемпотентность: unique job id (например `${campaignId}:${contactId}`), дедупликация.
- Rate-limit: `limiter: { max, duration }` per WA-аккаунт.
- Retry/backoff: экспонента + jitter, классификация ошибок → разные стратегии.

### packages/wa (Baileys)
- **SessionManager**: life-cycle сессий Baileys, auth-state в Redis, сериализованный reconnect.
- **Sender**: отправка (text/media/button/list/poll) с presence/typing-имитацией.
- **Receiver**: входящие `messages.upsert`/`update` → доменные события.
- **PhoneValidator**: `onWhatsApp`-проверка с enum-статусами.
- **Spintax/normalize**: вызовы в `shared` для вариаций текста и нормализации номеров.
- **Владение процессами и диспетчеризация** (см. `adr/0001-whatsapp-channel.md` и §7): один `instanceId` = один воркер-процесс (sticky ownership), команды отправки идут через Redis-реестр `instanceId → workerId`; поднимать сокет из произвольных BullMQ-джобов запрещено.

### packages/ai (LLM-агенты)
- Стабильные интерфейсы: `TargetingAgent`, `ChatBot`, `Copywriter`.
- Zod-схема ответа, retry, cost guard, логирование вызова, safety-rails.
- Не вызывает внешние мутации напрямую — возвращает типизированный payload, который воркер/web подтверждает и выполняет.

### packages/shared
- Контракты (DTO), zod-схемы, enum'ы статусов.
- Pure-утилиты: нормализация номеров, JID, spintax, шаблонизатор `%key%`, классификация ошибок отправки.

---

## 4. Потоки данных (ключевые)

### 4.1. Лидогенерация (Этап 1)
```
ИИ-таргетолог (packages/ai)
  → генерирует creative-payload (текст/визуал/аудитория)
  → [человек одобряет]
  → ad-API (Meta/TikTok) публикует кампанию
  → клик → лид падает в чат (WA или web-chat)
  → Webhook → apps/web/api → Lead created (packages/db) → крепится в CRM
```

### 4.2. Воронка и чат-бот (Этап 2)
```
Входящее WA-сообщение
  → packages/wa Receiver → доменное событие
  → ChatBot (packages/ai) квалифицирует, ведёт диалог
  → обновляет Lead (этап воронки), заполняет CalendarItem, шлёт уведомление
  → менеджер видит в CRM (apps/web) и подхватывает при необходимости
```

### 4.3. Массовая рассылка (Этап 3)
```
Пользователь создаёт Campaign (apps/web Server Action)
  → Campaign(status=draft) в БД
  → [старт] → Campaign(status=active) + schedule
  → BullMQ-очередь broadcast: одно задание на (campaignId, contactId), unique-job-id
  → worker: throttle(jitter) + ротация аккаунтов + global rate-limit
  → Sender (packages/wa): spintax → presence → sendMessage
  → результат → MessageLog(status: sent|delivered|read|failed) + Stats
  → при >= N technical_failed → circuit-breaker → Campaign(status=paused) + уведомление
```

### 4.4. Обучение (Этап 4)
```
Контент-менеджер/админ публикует CourseItem (apps/web)
  → CourseItem в БД (доступ по подписке)
  → фронт показывает по правам тарифа
  → cron каждые 2 недели: флаг «новое» на свежих материалах
```

### 4.5. Подписка/биллинг (Этап 5)

Платёжный провайдер — **Merchant of Record (Paddle / Lemon Squeezy)**, см. `adr/0002-payment-gateway.md`. В коде — тонкий слой `PaymentService` поверх MoR (без фабрики провайдеров).

> ⚠️ **Привязка платежа к тенанту — по метаданным сессии оплаты, не по payload.** В рекуррентных вебхуках провайдера **нет** нашего внутреннего `teamId` — только `providerCustomerId`/`providerSubId`. Идти этим путём, не иначе.

```
Пользователь выбирает Plan
  → apps/web (PaymentService) создаёт Checkout Session с:
      metadata: { teamId, subscriptionId }     // ОБЯЗАТЕЛЬНО
      client_reference_id: teamId              // ОБЯЗАТЕЛЬНО
  → успех → webhook (apps/web/api)
      → extract providerSubId из event
      → find Subscription по уникальному providerSubId (@unique)
      → получить teamId из найденной Subscription
      → обновить Permissions (+ AuditLog)
  → рекуррентные списания → тот же путь (metadata/уникальный индекс)
  → при failed payment → downgrade прав + уведомление
  → идемпотентность по event.id провайдера
```

**Запрещено:** искать тенанта напрямую из сырого payload вебхука (там нет `teamId`). Только через `Subscription.providerSubId` (`@unique`).

---

## 5. Доменная модель (контур)

Точный состав — в `packages/db/schema.prisma`. Здесь — обязательный контур. Все сущности мульти-тенантные через `teamId` (тенант = команда клиента).

### Ядро тенанта
- `Team` — клиентская команда. `ownerUserId`, `accessToken` (внешний, не в query — в заголовке).
- `User` — пользователь. `email`, `role` (owner/admin/manager), `expirationDate`, `status`.
- `Subscription` — подписка. `plan`, `status`, `paymentProvider` (какой именно MoR), `providerCustomerId` (**@unique**), `providerSubId` (**@unique**), `currentPeriodEnd`. Уникальные индексы обязательны: webhook маппится на тенанта именно по ним (см. §4.5), а не по полю из payload.
- `Permissions` — лимиты тарифа на команду. `whatsappMessagePerMonth`, `maxAccounts`, `featureFlags`.

### Лиды и CRM (Этапы 1–2)
- `Lead` — лид. `teamId`, `contactId`, `source` (ad/chat/manual), `creativeId` (какой креатив ИИ-таргетолога), `utm` (source/medium/campaign), `costPerLead`, `stage` (воронка), `assignedManagerId`, `createdAt`. **Атрибуция (`source`/`creativeId`/UTM) — обязательные базовые поля доменной модели с самого старта, а не фича на будущее: сервис должен уметь считать `cost-per-lead` и ROI.**
- `Contact` — контакт. `phone` (нормализованный), `name`, `isValid` (enum: null|confirmed|not_on_whatsapp|in_progress|error), `teamId`.
- `CalendarItem` — созвон/встреча. `leadId`, `scheduledAt`, `status`, `timezone`.
- `PipelineStage` — этап воронки. `teamId`, `order`, `name`.

### WhatsApp и рассылки (Этапы 2–3)
- `WaAccount` — подключённый WA-аккаунт. `teamId`, `instanceId`, `loginType` (baileys|cloud_api|evolution), `status` (connecting|connected|disconnected|logged_out|restricted|banned), `pid`, `restrictedUntil` (для `restricted`). `banned` и `logged_out` — терминальные в плане ротации; `restricted` — временный (пауза до `restrictedUntil`, затем auto-reconnect).
- `WaSession` — связка instance↔team + auth state ref (в Redis). `instanceId`, `teamId`, `status`.
- `Campaign` — кампания рассылки. `teamId`, `status` (draft|active|paused|completed|failed), `timePost`, `run` (lease ref), `accounts` (JSON id'ы), `nextAccount`, `scheduleTime` (JSON часы), `timezone`, `minDelay`, `maxDelay`, `sent`, `failed`, `technicalFailed`, `result` (JSON статусы по номерам).
- `MessageLog` — лог отправки. `instanceId`, `teamId`, `phone`, `type`, `message`, `status` (queued|sent|delivered|read|failed), `errorType` (media_error|session_error|send_error), `timePost`.
- `ChatBotRule` — правило чат-бота. `teamId`, `keywords`, `typeSearch` (contains|exact), `responseTemplate`, `delay`, `isActive`, `isDefault`.
- `AutoResponder` — автоответчик с throttle. `teamId`, `delayMinutes`, `lastResponsePerContact`.
- `Template` — шаблон сообщения. `teamId`, `body`, `type` (text|button|list|poll|media), `spintaxEnabled`.
- `Stats` — агрегаты. `teamId`, `waTotalSent`, `waTotalSentByMonth`, `waTimeReset`, `bulkTotal/Sent/Failed`.

### Реклама (Этап 1)
- `AdCampaign` — рекламная кампания. `teamId`, `platform` (instagram|facebook|tiktok), `externalId`, `creative`, `audience`, `budget`, `status`, `approvedByUserId` (человек в цикле).
- `Creative` — сгенерированный креатив. `adCampaignId`, `content`, `mediaUrl`, `generatedBy` (agent), `status` (draft|approved|rejected|published).

### Обучение (Этап 4)
- `Course` / `CourseItem` — материалы. `type` (guide|video|case), `accessTier`, `publishedAt`, `isNewWindow` (флаг свежести).
- `Enrollment` / `Progress` — прогресс пользователя (опционально).

### Операционное
- `Webhook` — внешние вебхуки наружу. `teamId`, `url`, `allowedEvents`.
- `AuditLog` — аудит дорогих действий (publish ad, broadcast start, tariff change).
- `AiCallLog` — лог вызовов LLM. `agent`, `promptHash`, `model`, `tokensIn/Out`, `cost`, `result` (ok|schema_error|retry).

---

## 6. Статусы и переходы состояний (контракт)

### Campaign
```
draft → active → paused → active (resume)
                ↘ completed (контакты закончились)
                ↘ failed   (circuit-breaker / лимит тарифа)
```
Любой переход — через явную мутацию с проверкой прав и логированием.

### MessageLog.status
```
queued → sent → delivered → read
              ↘ failed (с errorType и решением о retry)
```

### Contact.isValid (enum)
```
null (не проверен) → in_progress → confirmed
                                → not_on_whatsapp
                                → error
```

### WaAccount.status
```
connecting → connected → disconnected → connecting (reconnect)
                          ↘ logged_out  (QR слетел; creds не удаляем автоматически; терминальный для ротации)
                          ↘ restricted  (временная блокировка Meta / rate-limit; пауза до restrictedUntil, затем auto-reconnect)
                          ↘ banned      (перманентный бан номера; терминальный; исключить из ротации навсегда; алерт владельцу)
```
Переходы `→ restricted` / `→ banned` определяет `classifySendError` (`packages/shared`) по ответу Baileys/Meta — это **не** обычный `session_error`. `banned`/`logged_out` исключают аккаунт из ротации кампаний; `restricted` — временно, до истечения `restrictedUntil`.

---

## 7. Кросс-каттингие принципы

- **Мульти-тенантность через `teamId`** во всех запросах. Никаких запросов «по всем командам» в пользовательских потоках. Проверка cross-tenant при доступе к `instanceId`/`contactId`.
- **Sticky single-process ownership WA-сокетов.** Жизненный цикл Baileys-сокета одного `instanceId` принадлежит ровно одному физическому процессу на всём протяжении (long-lived stateful ресурс — короткие блокировки с TTL здесь бессильны и ведут к сокет-шторму/«conflict: replaced»).
  - **Stateless-задачи** (AI-генерация, email, валидация номеров, копирайтер, агрегации) масштабируются горизонтально в общем пуле BullMQ.
  - **WA-сокеты изолируются в выделенном процессе** (или шардированном наборе процессов с leader-election на шарде; шард — по консистентному хэшу от `instanceId`).
  - **Job отправки не открывает сокет.** Он направляет команду процессу-владельцу через Redis-реестр `instanceId → workerId`. Реестр — источник правды, кто владеет сокетом прямо сейчас.
  - **Распределённая блокировка** (Redlock) — только как вспомогательное средство при миграции владельца сессии (падение процесса, ребалансировка шардов), **не** как первичный механизм удержания.
- **Агрегаты для UI — из `Stats`, не из `MessageLog`.** Прогресс кампании/статистика в пользовательских потоках читаются **только** из модели `Stats` (running aggregates, инкрементальные счётчики). Прямые тяжёлые `COUNT(*)`/`GROUP BY` по живой таблице `MessageLog` в пользовательских потоках **категорически запрещены** — она точный лог, не источник агрегаций. `MessageLog` читается только по конкретной отправке/фильтру точечно.
- **Retention `MessageLog` (политика, реализация — Фаза 8).** Хранить точные логи за последние 60 дней; старше — архивация/очистка по расписанию. Партиционирование таблицы **не** закладываем на ранних фазах (нарушает Minimal Sufficient Change, не выражается декларативно в Prisma) — revisit по реальным метрикам в Фазе 8.
- **Идемпотентность** на мутациях с side effects: `Campaign` start, `MessageLog` insert, payment. Idempotency-key + unique constraint.
- **Аудит дорогих действий** в `AuditLog`: публикация рекламы, старт массовой рассылки, смена тарифа, удаление команды, перевод `WaAccount` в `banned`.
- **Внешние интеграции за стабильным интерфейсом**: WA-provider, Ad-platform, LLM, Payment — каждый за порт/adapter, тестируемый с mock.
- **Secrets только в env**, не в БД/query/коде (см. `AGENTS.md` §13).
- **Никаких in-memory хранилищ состояния как первоисточника** (донор терял прогресс рассылок при рестарте). Состояние — в БД/Redis; RAM — только кэш.

---

## 8. Не-цели (что мы НЕ строим)

Чтобы избежать over-engineering:

- Не строим собственный ad-сервер — используем API Meta/TikTok.
- Не строим собственный LLM — вызываем внешние через стабильный интерфейс.
- Не строим собственный платёжный процессор — используем Merchant of Record (Paddle/Lemon Squeezy, см. `adr/0002-payment-gateway.md`).
- Не делаем «взрослую» CI/CD-машинерию без явной просьбы (см. `AGENTS.md` §12).
- Не переносим чат-бот донора — делаем свой (решение владельца).
- Не клонируем дизайн/структуру донора — UI с нуля (донор «ужасен» по признанию владельца).