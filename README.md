# Smartmessage.kz — точка входа для ИИ-агента и разработчика

B2B SaaS сквозной экосистемы: ИИ-таргет → CRM + чат-бот → дожим базы через WhatsApp-рассылки → обучение → подписка $200–1000. Деньги, рассылки, база клиентов, ИИ — цена ошибки высокая.

> ⚠️ Этот README — **карта и точка входа**, а не инвентарь файлов. Структуру репозитория открывать динамически (см. `AGENTS.md` §2).


## Репозиторий и git-доступ
- **Remote (origin):** `https://github.com/mivroniosergiu-eng/smartmessage-kz`
- **Владелец / аккаунт:** `mivroniosergiu-eng` (GitHub).
- **Видимость:** Public 🌍 (исходники открыты; секреты — никогда в репо, см. ниже).
- **Ветка по умолчанию:** `main`.
- **Авторизация:** GitHub CLI (`gh`) уже залогинен под этим аккаунтом (scopes: `repo`, `workflow`, `read:org`). Токен — в системном keyring, не в репозитории.
- **Git-конвенции:**
  - работать через ветки `feat/*`, `fix/*`, `docs/*`, `chore/*`; вливать в `main` только через Pull Request;
  - коммиты — Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`);
  - **никогда** не коммитить секреты и WA-сессии — см. `.gitignore` (`.env*`, `auth_info*/`, `wa-sessions/`, `*.session`); шаблон переменных — `.env.example`;
  - переводы строк нормализованы через `.gitattributes` (`eol=lf`).
- **Защита ветки `main`: АКТИВНА** (серверный branch-protection GitHub):
  - **прямой push в `main` запрещён — только через Pull Request** (распространяется и на админов, enforce_admins);
  - linear history (rebase/squash), force-push и удаление `main` запрещены;
  - обязательное разрешение всех тредов в PR перед merge;
  - **CI-гейт `quality-gate` как required-чек подключается в Фазе 0** — когда активируется `.github/workflows/ci.yml`. Сейчас CI ещё нет, поэтому required-status-check намеренно не выставлен (иначе ни один PR нельзя слить). Это последовательность, а не послабление.
  - approve пока не требуется (соло-аккаунт: автор не может апрувить свой PR); человек контролирует merge кнопкой. При появлении второго ревьюера — поднять `required_approving_review_count`.
- **Защита от утечки секретов: АКТИВНА** — GitHub secret scanning + push protection (push с обнаруженным ключом блокируется на сервере). Плюс локально `.gitignore` (`.env*`, `auth_info*/`, `wa-sessions/`, `*.session`).

## С чего начать (порядок чтения)
1. `first plan.md` — бизнес-контекст (что строим и зачем).
2. `AGENTS.md` — **обязательные правила** (стек, TDD-гейты, безопасность, стоп-факторы). Исполняются всегда.
3. `docs/ROADMAP.md` — план работ по фазам + **протокол прохождения фазы**.
4. `docs/ARCHITECTURE.md` — как устроено (слои, потоки данных, доменная модель).
5. По необходимости: `docs/TESTING.md`, `docs/QA_CHECKPOINTS.md`, `docs/REUSE_DONOR.md`, `docs/adr/`.

## Карта репозитория
- `AGENTS.md` — правила (binding).
- `first plan.md` — бизнес-план.
- `docs/` — долговечный контекст:
  - `ARCHITECTURE.md`, `ROADMAP.md`, `TESTING.md`, `QA_CHECKPOINTS.md`, `REUSE_DONOR.md`;
  - `adr/` — Architecture Decision Records (тектонические решения, **не пересматривать без владельца**);
  - `qa-runs/` — test-evidence ledger (отчёты прогона по каждой задаче/фазе).
- `packages/`, `apps/`, `.github/workflows/` — код и CI (появляются начиная с Фазы 0).

## Зафиксированные решения (не менять без владельца)
- **Стек:** Next.js + NestJS + Prisma + PostgreSQL + Redis/BullMQ + Baileys + Playwright/Vitest + pnpm (`AGENTS.md` §0).
- **WhatsApp-канал:** Baileys (неофициальный), sticky ownership процессов — `docs/adr/0001-whatsapp-channel.md`.
- **Биллинг:** Merchant of Record (Paddle/Lemon Squeezy) — `docs/adr/0002-payment-gateway.md`.
- **Мульти-тенантность** через `teamId` во всех запросах (`docs/ARCHITECTURE.md` §7).

## Незыблемые правила исполнения
- **TDD-first** для денег/рассылок/auth/интеграций/ИИ; **anti-weakening** — нельзя глушить тесты (`AGENTS.md` §11).
- Каждая фаза/задача закрывается только через **3 гейта**: зелёный CI + ручной QA-чекпоинт + отчёт в `docs/qa-runs/` (см. ROADMAP «Протокол прохождения фазы»).
- **Единый язык:** канонические имена сущностей и их смысл — в `docs/ARCHITECTURE.md` §5 и `packages/db/schema.prisma`. Синонимы не выдумывать.