# QA-run: WA Baileys connector behind adapter — 2026-07-15

- Исполнитель (агент/человек): Codex task-agent
- Коммит/ветка: `feat/phase-1-wa-baileys-connector`

## Автотесты
- TDD red: `pnpm --filter @smartmessage/wa test -- baileys-connector.spec.ts` — 4 новых error-routing теста failed; Vitest зафиксировал unhandled rejections из QR, connected и auth persistence paths.
- TDD green: `pnpm --filter @smartmessage/wa test -- baileys-connector.spec.ts` — passed, 11/11.
- Команда прогона: `pnpm --filter @smartmessage/wa test` с изолированным Redis через `REDIS_URL` — passed, 79/79.
- Команда прогона: `pnpm --filter @smartmessage/wa lint` — passed.
- Команда прогона: `pnpm --filter @smartmessage/worker test` — passed, 86/86.
- Команда прогона: `pnpm --filter @smartmessage/worker lint` — passed.
- Команда прогона: `pnpm typecheck` — passed.
- Команда прогона: `pnpm test` с изолированным Redis через `REDIS_URL` — passed, 231/231 workspace tests.
- Команда прогона: `pnpm build` — passed.
- Package manager: `pnpm --version` — `10.34.0`; команда завершилась без предупреждения об ignored root `pnpm` settings.
- Install guard: `pnpm install --frozen-lockfile` — passed; workspace `packageExtensions` и build-script policy согласованы с lockfile.
- Команда прогона: `git diff --check` — passed.
- Anti-weakening scan: passed, no `.skip`, `.only`, `xit`, `xdescribe`, or `xtest` found.
- Secret/session-file scan: passed, no `auth_info*`, `wa-sessions`, or `*.session` artifacts found.
- Baileys/socket pattern scan: passed, `@whiskeysockets/baileys` and `makeWASocket` are isolated to `packages/wa/src/baileys-connector.ts`.
- Результат CI (ссылка на GitHub Actions run): not run locally.
- Покрытие критичных зон (рассылки/биллинг/auth/интеграции/ИИ):
  - `baileys-connector.spec.ts` checks that mocked Baileys factory is called only on explicit `connect`.
  - QR, connected, disconnected, and logged_out connection events map to transport callbacks.
  - Auth-state reads, key writes, and creds updates go through `WaAuthStateStore`.
  - Rejected QR and connected callbacks report the original error through neutral `onError`.
  - Rejected `creds.update` persistence reports through the same error path.
  - Rejected `onError` does not escape as an unhandled rejection in the test model.
  - Binary Baileys key material roundtrips through a JSON-safe auth-state envelope.
  - Malformed stored auth-state fails before socket factory creation.
  - `no-network.spec.ts` keeps Baileys import and `makeWASocket` isolated to `packages/wa/src/baileys-connector.ts`.

## Ручной QA (из QA_CHECKPOINTS.md, раздел: WA connector safety)
- [x] Worker default wiring remains `MockSessionManager`; `apps/worker/src/wa/wa.module.ts` was not changed.
- [x] No socket starts on module import/compile; connector factory is invoked only by `connect` in unit tests.
- [x] No `useMultiFileAuthState`, `auth_info`, `wa-sessions`, or `*.session` artifacts introduced.
- [x] `@whiskeysockets/baileys` production import appears only in `packages/wa/src/baileys-connector.ts`.
- [x] Pinned pnpm 10 explicitly blocks Baileys/protobuf build scripts through workspace `ignoredBuiltDependencies` and `allowBuilds: false`.

## Найденные дефекты / решения
- Глобальная `pnpm`-обёртка v11 запускала закреплённый pnpm 9.15.9: обёртка предупреждала, что root `pnpm` settings игнорируются, а pnpm 9 не применял их после переноса в `pnpm-workspace.yaml`. Проект закреплён на pnpm 10.34.0 — минимальной поддерживаемой линии, которая читает workspace settings и сохраняет существующую `ignoredBuiltDependencies`/`allowBuilds` policy при Node >=20.
- Baileys объявляет `sharp` обязательным peer, хотя используемый connector не требует media helpers. Exact prerelease selector в workspace `packageExtensions` отмечает `sharp` optional без добавления direct dependency в `packages/wa`.
- Итоговый `pnpm-lock.yaml` добавляет 412 строк и не удаляет/переразрешает существующие записи. Добавлены только importer Baileys, 52 package-блока и 52 snapshot-блока его closure; изменения Next/Vitest/Testing Library/Rollup/SWC отсутствуют. Новая ссылка на `@types/node` находится только в новом `protobufjs` snapshot.
- Fresh install выполнял только разрешённые build scripts; Baileys/protobuf в executed list отсутствовали. Последующий frozen install прошёл без конфигурационных предупреждений.
- Async Baileys listeners теперь заканчиваются safe dispatch chain: ошибка исходного handler уходит в `onError`, rejection самого error hook поглощается terminal catch.
- `pnpm build` regenerated `packages/db/ERD.md` whitespace; generated churn was restored before final diff.
