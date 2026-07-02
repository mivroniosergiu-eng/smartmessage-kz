# QA-run: WA lifecycle stop/renew jobs - 2026-07-03

- Executor: Codex task-agent
- Branch: `feat/phase-1-wa-stop-renew-jobs`
- Scope: extend WA lifecycle queue contract and worker router to `stop-wa-instance` and `renew-wa-instance`; no HTTP endpoint, QR flow, Baileys, sockets, sessions, secrets, or real phone numbers.

## Automated Tests

- `pnpm --filter @smartmessage/queue test` - passed, 2 files / 5 tests.
- `pnpm --filter @smartmessage/worker test` - passed, 5 files / 29 tests.
- `pnpm --filter @smartmessage/worker lint` - passed.
- `pnpm typecheck` - passed across workspace.
- `pnpm test` - passed across workspace, 27 files / 130 tests.
- `pnpm build` - passed across workspace.
- `git diff --check` - passed.

## Manual QA

- Not applicable: this task adds queue contracts and worker routing only. There is no UI, HTTP endpoint, QR flow, Baileys socket, or real WA session behavior to verify manually.

## Defects / Decisions

- Added a shared `{ instanceId }` payload parser for WA lifecycle instance jobs to avoid duplicated validation errors.
- Existing BullMQ consumer wiring in `WaModule` already delegates to `WaLifecycleJobProcessor`; tests now verify one worker is created and stop jobs use the same processor path.
