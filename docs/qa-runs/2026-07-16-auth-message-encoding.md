# QA-run: читаемые auth-ошибки и favicon — 2026-07-16

- Исполнитель: Codex task-agent
- Ветка: `feat/phase-1-wa-phone-validation` (изменения не закоммичены, PR не открыт)

## Автотесты

- TDD: обновлён контракт русских auth-сообщений и добавлен сценарий короткого пароля; до исправления 4 проверки падали ожидаемо.
- `pnpm --filter @smartmessage/web test` — passed, 19/19.
- `pnpm --filter @smartmessage/web lint` — passed без warnings.
- `pnpm --filter @smartmessage/web typecheck` — passed.
- `pnpm --filter @smartmessage/web build` — passed.
- `git diff --check` — passed.

## Runtime QA

- [x] Реальная `/register` с паролем `1234` показывает: `Пароль должен содержать не менее 6 символов` без mojibake.
- [x] Metadata содержит `/smartmessage-icon.svg`; asset отвечает HTTP 200 с `image/svg+xml`.
- [x] `/register` отвечает HTTP 200; worker `/health` отвечает HTTP 200.
- [x] В изолированном in-app browser после проверки нет console errors/warnings.

## Найденные дефекты / решения

- Пользовательские auth-сообщения были сохранены в `auth.ts` уже испорченными UTF-8/Windows-1251 последовательностями; исправлены все validation, duplicate, credentials и internal-error тексты.
- `favicon.ico` отсутствовал; добавлен локальный SVG icon через Next metadata без новой production-зависимости.
- Chrome warning про дополнительные `processed_*` и `bis_register` атрибуты создаётся расширением браузера до React hydration. Приложение не маскирует его через `suppressHydrationWarning`; для проверки достаточно Incognito/отключения расширения.

## Safety-scope

- Auth/session/permission поведение не менялось.
- Новые зависимости, внешние favicon/QR-сервисы и секреты не добавлялись.
