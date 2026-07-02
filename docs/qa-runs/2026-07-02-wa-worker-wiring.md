# QA-run: WA worker lifecycle wiring - 2026-07-02

- Executor: Codex task-agent
- Branch: `feat/phase-1-wa-worker-wiring`
- Scope: NestJS DI wiring for future WA owner process, without Baileys sockets.

## Automated Checks

- Local services:
  - PostgreSQL `localhost:5433`: available via `docker compose` service `postgres` (`sm-postgres`, healthy).
  - Redis `localhost:6380`: available via `docker compose` service `redis` (`sm-redis`, healthy).
- `pnpm --filter @smartmessage/worker test`
  - Result: passed, 3 files / 16 tests.
- `pnpm --filter @smartmessage/worker exec vitest run src/wa/wa.module.spec.ts src/app.spec.ts`
  - Result: passed, 2 files / 8 tests.
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

- `WaModule` assembles the worker DI contour for `RedisOwnerRegistry`, `PrismaWaAccountStatusRepository`, `MockSessionManager`, and `WaSessionLifecycleService`.
- `AppModule` imports `WaModule`, and the lifecycle provider is available from the worker module graph.
- `WA_WORKER_ID` uses env value or deterministic fallback `worker-${process.pid}`.
- `WA_OWNER_TTL_MS` defaults to `30000` and fails fast unless it is a positive safe integer.
- Redis connection uses the existing BullMQ-compatible helper from `@smartmessage/queue`, preserving `maxRetriesPerRequest: null`.
- Baileys adapter, QR flow, real WA sockets, real sessions, secrets, and real phone numbers were not added.

## Manual QA

- Not applicable: this task is DI wiring only and is covered by Nest testing module assembly plus static no-Baileys assertions.

## Open Validation

- None.
