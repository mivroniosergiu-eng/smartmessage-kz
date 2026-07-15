# QA-run: WA runtime wiring и owner-directed lifecycle — 2026-07-15

- Исполнитель: Codex task-agent + три implementation/review-субагента
- Ветка: `feat/phase-1-wa-runtime-wiring`
- PR/CI: [PR #26](https://github.com/mivroniosergiu-eng/smartmessage-kz/pull/26); initial `quality-gate` run [29411570078](https://github.com/mivroniosergiu-eng/smartmessage-kz/actions/runs/29411570078) — passed; CodeRabbit — completed, 12 actionable threads обработаны follow-up diff.

## Автотесты

- TDD red: `session-lifecycle.spec.ts` — отсутствовали immediate state drain, QR cleanup, stop/event serialization и `shutdownAll`.
- TDD red: `session-runtime.spec.ts` — отсутствовал inert runtime composition и event wiring.
- TDD red: `wa.module.spec.ts` — worker использовал `MockSessionManager`, runtime aliases и pre-shutdown close отсутствовали.
- TDD red: queue/command tests — producer выбирал owner до постановки job, поэтому stop/renew могли потеряться при миграции owner или незавершённом start.
- TDD red: lifecycle race tests — shutdown не ждал pending start и физическое закрытие после потери ownership; slow state read допускал stale persistence.
- TDD red: module shutdown tests — независимые Nest hooks не гарантировали порядок workers → sessions → queue → Redis → Prisma; fallback `worker-${pid}` не был глобально уникален.
- TDD red: deferred persistence races — старый owner мог завершить status/QR mutation после активации новой сессии; добавлен монотонный ownership epoch и conditional Prisma fence.
- TDD red: owner crash/ack tests — generic job завершалась сразу после enqueue в очередь умершего owner; теперь она ждёт ack, повторно читает ownership после timeout и не применяет orphan directed job к новой epoch.
- Review fix: после сброса Redis новый claim поднимает epoch строго выше сохранённого Prisma fence; decimal-string Lua comparison и `INCR` → `GET` сохраняют точность полного PostgreSQL/Redis `BIGINT` диапазона.
- Review fix: lease проверяется по точным `workerId + epoch` до и после transport connect/close; ABA-сценарий с тем же worker id не может записать status/QR или освободить новый lease.
- Review fix: owner ACK ждёт до 15 секунд (дольше 10-секундного transport close), directed job имеет один attempt, а bounded completed-result retention позволяет generic retry получить поздний результат без второго side effect.
- Review fix: application shutdown ограничивает transport-close тремя попытками по одной секунде, включая never-settling Promise, продолжает независимую очистку и возвращает первую ошибку; failed stop persistence сохраняет ownership и повторно вооружает supervision.
- Review fix: per-instance transport-shutdown barrier не разрешает same-process reclaim, пока retry старой generation не подтвердил close; старый retry не может закрыть новый socket.
- Review fix: Nest сначала вызывает `pause(true)`, немедленно активирует bounded lifecycle shutdown и завершает workers через `close(true)`; never-settling active BullMQ job не блокирует закрытие transports.
- Review fix: production `WA_WORKER_ID` закреплён как стабильный deployment-slot. Exact-token Redis identity lease занимается до runtime/consumers, duplicate startup блокируется, renew-loss one-shot останавливает intake/transports и завершает процесс; owner queues и completed results имеют конечную верхнюю границу.
- Review fix: immediate и periodic identity renew ограничены deadline `ttlMs/3`; never-settling Redis `EVAL` вызывает one-shot loss, поздний ответ fenced, а explicit `stopRenewal()` отменяет deadline без ложного callback.
- Review fix: оба BullMQ consumers создаются с `autorun: false`, loss-supervisor привязывается до `run()`, а per-job identity fence закрывает остаточное окно между loss и остановкой intake.
- Review fix: identity lease удаляется только после успешного physical session shutdown и закрытия обоих consumers. При ошибке renewal останавливается, lease остаётся до TTL, а bounded fatal handler вызывается до потенциально зависшего queue/Redis/Prisma cleanup.
- CodeRabbit fix: один 15-секундный owner-ACK deadline теперь включает QueueEvents readiness, directed enqueue и result wait; timeout выполняет bounded best-effort close producer handles и отдаёт управление generic retry даже при зависшем cleanup.
- CodeRabbit fix: distinct renew commands в одной ownership epoch получают разные command-id, а retry той же generic job переиспользует id. Dynamic job-id segments экранируют точки и не допускают collision.
- CodeRabbit fix: pause, lifecycle shutdown и оба worker close имеют bounded deadlines; зависший critical step не блокирует identity retention и fatal termination до TTL.
- CodeRabbit fix: публичный env-template не содержит usable internal token, а guard отвергает пустое и известное placeholder-значение.
- CodeRabbit fix: in-memory/Prisma QR fences покрывают same-epoch foreign worker, in-memory event id нормализуется, а завершившийся transport close очищает и unref'ит timeout.
- Интеграционный дефект, найденный полным suite: BullMQ отклонил `:` в owner queue name; контракт изменён на допустимый `wa-lifecycle-owner.<encodedWorkerId>`.
- Safety-дефект, найденный полным suite: старый Nest-тест после real wiring открыл transport; тест теперь явно подменяет lifecycle и оба BullMQ workers, сеть не используется.
- `pnpm --filter @smartmessage/wa test` — passed, 208/208.
- `pnpm --filter @smartmessage/wa lint` — passed.
- `pnpm --filter @smartmessage/wa typecheck` — passed.
- `pnpm --filter @smartmessage/queue test` — passed, 15/15.
- `pnpm --filter @smartmessage/queue lint` — passed.
- `pnpm --filter @smartmessage/worker test` — passed, 141/141; `DATABASE_URL` передан только дочернему процессу из ignored env-файла без вывода значения.
- `pnpm --filter @smartmessage/worker lint` — passed.
- `pnpm typecheck` — passed для всех workspace-пакетов.
- `pnpm lint` — passed без warnings.
- `pnpm test` — passed, 421/421 workspace tests.
- `prisma validate` и `prisma migrate deploy` — passed; 7 migrations, pending migrations нет.
- `pnpm build` — passed; generated ERD возвращён к canonical formatting.
- `git diff --check` — passed.
- Anti-weakening и secret/session/forbidden-surface scans — passed.

## Покрытие критических контрактов

- Runtime construction/getState не вызывает transport.
- Explicit start — единственный путь открытия transport.
- QR и status events принимаются только активным owner.
- Status/QR writes условны по `workerId + epoch`; deferred old-owner commits не проходят после нового fence.
- Redis counter reset восстанавливается от Prisma floor; epoch выше `2^53` не округляется Lua runtime.
- Transport connect/close ограждены точным epoch до и после side effect; ABA ownership не проходит.
- Per-instance shutdown barrier не допускает новый claim/connect до полного завершения close старой generation.
- Transient disconnect coalescing не создаёт параллельный socket и не вызывает logout.
- Событие до завершения initial connect не теряется.
- Stale QR не перекрывает connected/terminal state.
- Concurrent connected event + stop заканчивается disconnected.
- Shutdown закрывает все локальные transports и запрещает новые starts.
- Stop/renew сначала принимаются общей очередью, revalidate owner на execution и считаются завершёнными только после owner ack; timeout/crash покрыты retry дольше lease TTL.
- Directed job включает ожидаемую ownership epoch; stale orphan stop/renew становится no-op и не затрагивает новую сессию.
- Directed owner job не имеет собственного retry-слоя; поздний ACK переживает 10-секундный close, а стабильная slot-queue и `count=1000` ограничивают Redis footprint между рестартами.
- Exclusive worker identity lease не допускает двух живых consumers одного slot; первый renew подтверждается до runtime/consumers, workers не переходят из `autorun: false` в `run()` до привязки supervisor, а per-job fence запрещает новый WA side effect после loss.
- Shutdown запрещает новые starts и не ждёт зависший active BullMQ job перед включением lifecycle timeout. После успешного close он освобождает identity lease; при ошибке удерживает lease до TTL и начинает fatal termination до последовательного queue/Redis/Prisma cleanup.

## Ручной QA (QA_CHECKPOINTS.md §3.1)

- [x] Автоматическая часть выполнена без сети и реального WA.
- [ ] Реальный QR/reconnect/restart smoke-test не выполнялся: нужен отдельный OWNER_DECISION и тестовый аккаунт.

## Safety-scope

- Не добавлены send surface, campaign scheduling, массовые рассылки, UI или QR endpoint.
- Не использованы реальные номера, WA session files, секреты или аккаунты.
- `packages/wa` не зависит от Prisma; production adapters остаются в `apps/worker`.
