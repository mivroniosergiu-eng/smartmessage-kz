# QA-run: WA account command guard - 2026-07-03

- Executor: Codex task-agent
- Branch: `feat/phase-1-wa-account-command-guard`
- Scope: add a worker-side Prisma-backed guard before WA lifecycle command enqueue. The low-level queue producer remains unchanged and internal. No HTTP endpoint, Server Action, UI, QR flow, Baileys runtime/import, real sockets, real WA session files, secrets, or real phone numbers.

## Automated Tests

- `pnpm --filter @smartmessage/worker test` - passed, 8 files / 43 tests.
- `pnpm --filter @smartmessage/worker lint` - passed.
- `pnpm typecheck` - passed across workspace.
- `pnpm test` - passed across workspace, 30 files / 148 tests.
- `pnpm build` - passed across workspace.
- `git diff --check` - passed.
- Anti-weakening `rg` check for `.skip` / `.only` / `xit` - passed.

## Manual QA

- Not applicable: this task adds worker-side command authorization before internal queue enqueue only. There is no UI, HTTP endpoint, QR flow, Baileys socket, or real WA session behavior to verify manually.

## Defects / Decisions

- Added `PrismaWaAccountCommandGuard` to validate/normalize the command target and reject missing `WaAccount.instanceId` with `WaAccountCommandTargetNotFoundError`.
- Added `WaLifecycleCommandQueueService` as the guarded facade for start/stop/renew lifecycle enqueue calls.
- Kept `WaLifecycleQueueService` as the low-level BullMQ producer without DB knowledge.
