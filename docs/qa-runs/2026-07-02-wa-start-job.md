# QA-run: WA start job - 2026-07-02

- Executor: Codex task-agent
- Branch: `feat/phase-1-wa-start-job`
- Scope: internal BullMQ job contract and worker-side processor for `start-wa-instance`, without HTTP endpoints, Baileys sockets, or real WA sessions.

## Automated Checks

- `pnpm --filter @smartmessage/queue test`
  - Result: passed, 2 files / 4 tests.
- `pnpm --filter @smartmessage/worker test`
  - Result: passed, 5 files / 25 tests.
- `pnpm --filter @smartmessage/worker lint`
  - Result: passed.
- `pnpm typecheck`
  - Result: passed across workspace.
- `pnpm test`
  - Result: passed across workspace.
- `pnpm build`
  - Result: passed across workspace.

## Coverage Notes

- Queue contract exports `wa-lifecycle` queue name and `start-wa-instance` job name.
- Queue contract validates payload shape `{ instanceId: string }`, trims `instanceId`, and rejects invalid payloads.
- Worker processor validates payload before calling `WaLifecycleCommandService.startInstance`.
- `WaModule` starts a BullMQ consumer for the `wa-lifecycle` queue and delegates jobs to the processor.
- Valid job returns minimal `{ instanceId, status }`.
- Ownership errors from the command service propagate and reject the job.
- `WaModule` closes the WA lifecycle BullMQ worker on application shutdown.
- Baileys adapter, QR flow, HTTP endpoint, real WA sockets, real sessions, secrets, and real phone numbers were not added.

## Manual QA

- Not applicable: this is an internal worker job processor path covered by automated tests.

## Open Validation

- None.
