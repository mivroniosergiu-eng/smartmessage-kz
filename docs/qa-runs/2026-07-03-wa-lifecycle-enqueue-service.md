# QA-run: WA lifecycle enqueue service - 2026-07-03

- Executor: Codex task-agent
- Branch: `feat/phase-1-wa-lifecycle-enqueue-service`
- Scope: add an internal BullMQ producer service for WA lifecycle `start/stop/renew` jobs with deterministic job ids, validation, and queue shutdown. No HTTP endpoint, QR flow, Baileys, sockets, sessions, secrets, or real phone numbers.

## Automated Tests

- `pnpm --filter @smartmessage/queue test` - passed, 2 files / 9 tests.
- `pnpm --filter @smartmessage/worker test` - passed, 6 files / 35 tests.
- `pnpm --filter @smartmessage/worker lint` - passed.
- `pnpm typecheck` - passed across workspace.
- `pnpm test` - passed across workspace, 28 files / 140 tests.
- `pnpm build` - passed across workspace.
- `git diff --check` - passed.
- Anti-weakening `rg` check for `.skip` / `.only` / `xit` - passed.

## Manual QA

- Not applicable: this task adds an internal queue producer only. There is no UI, HTTP endpoint, QR flow, Baileys socket, or real WA session behavior to verify manually.

## Defects / Decisions

- Added a shared deterministic WA lifecycle job id helper in `@smartmessage/queue`; it normalizes via the lifecycle parser and percent-encodes unsafe instance-id characters.
- Added `WaLifecycleQueueService` as the internal producer path. It enqueues start/stop/renew jobs with normalized payloads and deterministic BullMQ `jobId` values.
- Added one `WA_LIFECYCLE_QUEUE` provider and shutdown hook in `WaModule`, separate from the existing lifecycle worker provider.
