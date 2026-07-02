# QA-run: WA start command - 2026-07-02

- Executor: Codex task-agent
- Branch: `feat/phase-1-wa-start-command`
- Scope: worker-side command service for WA lifecycle start/stop/renew, without Baileys sockets or HTTP endpoints.

## Automated Checks

- `pnpm --filter @smartmessage/worker test`
  - Result: passed, 4 files / 21 tests.
- `pnpm --filter @smartmessage/worker lint`
  - Result: passed.
- `pnpm --filter @smartmessage/worker typecheck`
  - Result: passed.
- `pnpm typecheck`
  - Result: passed across workspace.
- `pnpm test`
  - Result: passed across workspace.
- `pnpm build`
  - Result: passed across workspace.

## Coverage Notes

- `WaLifecycleCommandService.startInstance(instanceId)` validates `instanceId`, delegates to `WaSessionLifecycleService.start`, and returns `SessionState`.
- Invalid `instanceId` is rejected before lifecycle calls.
- `WaOwnershipError` propagates unchanged from lifecycle.
- `stopInstance` and `renewInstance` delegate to lifecycle.
- Service is available from the Nest `WaModule`, and a module test exercises command service through real lifecycle wiring with mock session manager and fake owner/status ports.
- Baileys adapter, QR flow, HTTP endpoint, real WA sockets, real sessions, secrets, and real phone numbers were not added.

## Manual QA

- Not applicable: this is an internal worker command/service path covered by automated Nest/Vitest tests.

## Open Validation

- None.
