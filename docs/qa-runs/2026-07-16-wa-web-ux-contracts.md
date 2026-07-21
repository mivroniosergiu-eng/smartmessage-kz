# QA-run: Phase 1 WhatsApp web UX contracts — 2026-07-16

- Исполнитель: Codex task-agent
- Ветка: `feat/phase-1-wa-phone-validation`

## Автотесты

- Targeted: `pnpm --filter @smartmessage/web exec vitest run app/actions/whatsapp.spec.ts app/dashboard/whatsapp/whatsapp-live-refresh.spec.tsx` — passed, 8/8.
- Web: `pnpm --filter @smartmessage/web test` с тестовым `DATABASE_URL` — passed, 24/24.
- TypeScript: `pnpm --filter @smartmessage/web typecheck` — passed.
- Lint: `pnpm --filter @smartmessage/web lint` — passed без warnings.
- `git diff --check` — passed.

## Проверенные контракты

- Исчерпанный тарифный лимит аккаунтов возвращает понятную русскую ошибку и не обращается к worker.
- `start`, `stop` и `logout` для tenant-owned аккаунта вызывают соответствующую защищённую worker-команду, обновляют страницу и возвращают пользователя на `/dashboard/whatsapp`.
- Пока аккаунт находится в `CONNECTING`, страница вызывает безопасный server refresh раз в пять секунд; после выхода из этого состояния таймер прекращается.

## Safety-scope

- Реальный WhatsApp, QR-сканирование и отправка не выполнялись.
- Новые production dependencies, HTTP endpoints и новые WA/QR surfaces не добавлялись.
