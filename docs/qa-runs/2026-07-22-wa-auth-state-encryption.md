# QA-run: WA auth-state encryption at rest — 2026-07-22

- Исполнитель: Codex task-agent
- Ветка: `feat/phase-1-wa-phone-validation` (локальный worktree, PR/CI pending)

## Автотесты

- TDD red: targeted repository suite завершался до collection, потому что encryption config/API отсутствовали.
- TDD green: `pnpm --filter @smartmessage/worker exec vitest run src/wa/prisma-wa-auth-state.repository.spec.ts` на изолированной `smartmessage_test` — passed, 14/14.
- `pnpm --filter @smartmessage/worker typecheck` — passed.
- `pnpm --filter @smartmessage/worker lint` — passed.
- Полный локальный gate: workspace tests 620/620, typecheck, lint, coverage, build и Playwright 2/2 — passed; серверный CI pending до PR.

## Проверенные контракты

- Новая запись сохраняет только versioned `aes-256-gcm` envelope; provider credentials и key material отсутствуют в raw Prisma JSON.
- 32-byte key принимается только в canonical base64 и не включается в тексты ошибок.
- IV генерируется случайно для каждой записи; GCM authentication tag и AAD по `instanceId` обнаруживают неверный ключ, повреждение и перенос ciphertext между аккаунтами.
- Неверный/отсутствующий key завершает read/write fail-closed без plaintext fallback; для `WA_SESSION_RUNTIME=baileys` отсутствие key блокирует конфигурацию repository до открытия socket.
- Legacy plaintext JSON остаётся читаемым для безопасного перехода и при первом чтении условно заменяется encrypted envelope, не перезаписывая конкурентный новый state.
- Схема БД не менялась: versioned envelope сохраняется в существующем `WaAuthState.payload Json`.

## Ручной/runtime QA

- Owner-authorized real-WA сессия была восстановлена после миграции legacy auth-state: raw Prisma JSON подтверждён только безопасными булевыми признаками как versioned `aes-256-gcm` envelope без открытых `creds/keys`.
- После второго контролируемого restart worker прочитал уже зашифрованный auth-state и вернул account в `CONNECTED` без нового QR.
- Новые сообщения не отправлялись; ранее разрешённая single-send осталась единственным реальным side effect.

## Safety-scope

- Реальные auth-state и encryption key не выводились: runtime-проверка раскрывала только булевы признаки envelope; номера и session-файлы не добавлялись в git/документацию.
- Не изменялись single-send, lifecycle ownership/race semantics, HTTP/UI/QR surfaces или Prisma schema.
- Новые production-зависимости не добавлялись: используется `node:crypto`.
