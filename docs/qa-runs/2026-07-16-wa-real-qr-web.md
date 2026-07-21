# QA-run: Phase 1 real Baileys QR и сканируемый web QR — 2026-07-16

Последнее обновление фактического прогона: 2026-07-21.

- Исполнитель: Codex task-agent + владелец для ручного сканирования
- Ветка: `feat/phase-1-wa-phone-validation`

## Автотесты

- TDD red: `pnpm --filter @smartmessage/wa test -- src/baileys-connector.spec.ts` — воспроизведены пустые initial credentials, затем потеря типа `Buffer` на JSON auth-state boundary.
- TDD green: `pnpm --filter @smartmessage/wa test -- src/baileys-connector.spec.ts` — passed, 50/50.
- WA: `pnpm --filter @smartmessage/wa test` — passed, 245/245.
- Worker с `DATABASE_URL=postgresql://postgres:postgres@localhost:5433/smartmessage?schema=public` и `REDIS_URL=redis://127.0.0.1:6380`: `pnpm --filter @smartmessage/worker test` — passed, 232/232.
- Web targeted: `pnpm --filter @smartmessage/web test -- app/dashboard/whatsapp/whatsapp-qr-code.spec.tsx` — passed, 1/1.
- Web с локальным test `DATABASE_URL`: `pnpm --filter @smartmessage/web test` — passed, 25/25.
- Web Playwright: `pnpm --filter @smartmessage/web test:e2e -- e2e/whatsapp-page.spec.ts` — passed, 1/1.
- `pnpm --filter @smartmessage/web lint` — passed без warnings.
- `pnpm --filter @smartmessage/wa lint` и `pnpm --filter @smartmessage/worker lint` — passed.
- `pnpm typecheck` — passed.
- `pnpm --filter @smartmessage/web build` и `pnpm --filter @smartmessage/wa build` — passed.

## Ручной QA (QA_CHECKPOINTS.md §3.1)

- [x] Owner явно разрешил real-WA QR smoke-test; `WA_SESSION_RUNTIME=baileys` включён только для локального worker.
- [x] Реальный handshake дошёл до `not logged in, attempting registration`, QR создавался и ротировался без отправки сообщений.
- [x] Свежий QR на `/dashboard/whatsapp` успешно отсканирован; статус перешёл в `CONNECTED` и QR bootstrap был очищен.
- [x] После принудительной остановки и рестарта worker сохранённый auth-state восстановил подключение без нового QR; protected `start` вернул аккаунт в `CONNECTED`.

Runtime evidence 2026-07-21:

- post-pairing Baileys restart-required disconnect (`515`) был обработан автоматически: новый transport открыл подключение примерно через 0,5 секунды без повторного сканирования;
- после остановки процесса, ожидания истечения ownership lease и старта worker с тем же стабильным `WA_WORKER_ID` аккаунт восстановился из Prisma auth-state;
- после восстановления: account status `CONNECTED`, QR rows `0`, worker health `200`;
- реальная отправка сообщений в этом прогоне не выполнялась.

## Найденные дефекты / решения

- Новый auth-state передавал Baileys пустые credentials и падал до QR. Исправлено через `initAuthCreds()` только для пустого состояния; существующий auth-state не заменяется.
- JSON boundary превращал `Buffer` приватного ключа в `Uint8Array`, что отклонял `libsignal`. Добавлен отдельный marker/roundtrip для `Buffer`; обычные `Uint8Array` сохранены без изменения.
- Статичный QR из task-чата устаревал раньше сканирования. Web теперь локально рендерит свежий `QRCodeSVG`, а существующий 5-секундный refresh подхватывает ротацию QR.
- Pairing payload не отправляется внешнему QR-сервису и больше не отображается как raw text.
- После QR pairing обновлённые credentials сохранялись, но runtime продолжал считать исходный auth-state пустым и не запускал reconnect после обязательного Baileys `515`. Session manager теперь перечитывает persisted auth-state перед классификацией disconnect; добавлен regression-тест.
- Повторный явный `start` для owned-аккаунта в `DISCONNECTED` только продлевал ownership и не открывал transport. Lifecycle service теперь выполняет serialized reconciliation и реальный reconnect; добавлен regression-тест.

## Safety-scope

- Реальные сообщения не отправлялись; `sendMessage` не вызывался.
- Не добавлялись campaign/bulk surfaces, scheduler, HTTP QR endpoint или socket autostart.
- Default worker runtime остаётся `mock`; real Baileys включается только точным opt-in значением.
