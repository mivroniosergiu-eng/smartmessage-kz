# QA-run: WA Baileys auth-state mapper — 2026-07-06

- Исполнитель (агент/человек): Codex task-agent
- Коммит/ветка: `feat/phase-1-wa-auth-state-mapper`

## Автотесты
- Команда прогона:
  - `pnpm --filter @smartmessage/wa test` — passed, 68 tests.
  - `pnpm --filter @smartmessage/wa lint` — passed.
  - `pnpm --filter @smartmessage/worker test` — passed, 86 tests.
  - `pnpm --filter @smartmessage/worker lint` — passed.
  - `pnpm typecheck` — passed.
  - `pnpm test` — passed.
  - `pnpm build` — passed.
  - `git diff --check` — passed.
  - Anti-weakening scan — passed, no matches.
  - Baileys/socket/session-file pattern search — passed, no matches.
- Результат CI (ссылка на GitHub Actions run): not run yet; local validation only
- Покрытие критичных зон (рассылки/биллинг/auth/интеграции/ИИ): WA auth-state mapper boundary only; covered by mapper contract tests, existing no-network production-source test, worker tests/lint, workspace typecheck/test/build, and explicit safety scans.

## Ручной QA (из QA_CHECKPOINTS.md, раздел: WA auth-state persistence boundary)
- [x] Empty neutral store maps to explicit `{ creds: {}, keys: {} }`.
- [x] Mapper writes and reads provider-shaped auth-state through `WaAuthStateStore`.
- [x] Malformed stored payload raises `BaileysAuthStateMapperError`.
- [x] No Baileys import/runtime, socket connect, filesystem path, session-file storage, worker production wiring, or WaAccount creation.

## Найденные дефекты / решения
- Mapper added only in `packages/wa`; worker production wiring remains unchanged.
- Mapper uses local minimal structural types instead of Baileys public types.
- ERD whitespace churn from build was removed from final diff.
