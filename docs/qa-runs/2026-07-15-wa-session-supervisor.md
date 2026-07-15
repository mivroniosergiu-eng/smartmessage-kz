# QA-run: WA session supervisor и ownership heartbeat — 2026-07-15

- Исполнитель (агент/человек): Codex task-agent + независимый review-субагент
- Ветка: `feat/phase-1-wa-session-supervisor`
- PR: [#25](https://github.com/mivroniosergiu-eng/smartmessage-kz/pull/25)

## Автотесты

- TDD red: `pnpm --filter @smartmessage/wa test -- session-lifecycle.spec.ts` — 6/18 ожидаемых failures: heartbeat завершался вместе со start, connecting ошибочно объявлялся connected, повторный start открывал новый transport, transient reconnect и terminal supervision отсутствовали, ownership loss не закрывал local transport.
- Race/safety TDD red: тот же suite последовательно подтвердил отсутствие start/stop serialization, lease renew во время slow close/reconciliation/rollback/status persistence, fail-closed shutdown на renew exception, бесконечного bounded-backoff cleanup, защиты shared status от stale owner и physical close перед banned release.
- Manager terminal TDD red: `pnpm --filter @smartmessage/wa test -- baileys-session-manager.spec.ts` — legacy-banned state возвращался без подтверждённого transport close.
- TDD green: оба целевых suite — passed, 70/70 (`session-lifecycle` 31/31, `baileys-session-manager` 39/39).
- `pnpm --filter @smartmessage/wa test` — passed, 169/169.
- `pnpm --filter @smartmessage/wa lint` — passed.
- `pnpm --filter @smartmessage/wa typecheck` — passed.
- `pnpm --filter @smartmessage/worker test` — passed, 86/86; локальный `DATABASE_URL` передан только дочернему процессу из ignored env-файла без вывода значения.
- `pnpm --filter @smartmessage/worker lint` — passed.
- `pnpm typecheck` — passed для всех workspace-пакетов.
- `pnpm lint` — passed для всего workspace без warnings.
- `pnpm test` — passed, 321/321 workspace tests.
- `pnpm build` — passed для всех workspace-пакетов; generated-only whitespace в `packages/db/ERD.md` отформатирован обратно, Prisma schema не менялась.
- `git diff --check` — passed.
- GitHub Actions `quality-gate` — passed для code head `aa5fa32` ([run](https://github.com/mivroniosergiu-eng/smartmessage-kz/actions/runs/29402818020/job/87311173377)).
- CodeRabbit status context — success, но содержательный review не начался из-за внешнего review rate-limit (следующий слот через 12 минут). Компенсирующий независимый трёхпроходный review-субагент: финальный verdict P0/P1 не обнаружено. Thread-aware GraphQL audit: unresolved review threads `0`.

## Покрытие критических контрактов

- Lease heartbeat живёт независимо от медленного state reconciliation/reconnect и продолжается во время start rollback, slow transport close и status persistence вплоть до release.
- `renew=false` и исключение Redis renew переводят процесс в единый fail-closed shutdown; transport закрывается с бесконечным exponential backoff, не остаётся брошенным после фиксированного числа попыток.
- Reconciliation и reconnect сериализованы отдельно от heartbeat; параллельные watchdog ticks не открывают второй socket.
- `start → stop`, `stop → start`, concurrent start и concurrent stop сериализованы per `instanceId`; повторный start идемпотентен.
- После подтверждённой ownership loss старый worker не пишет shared status и не освобождает lease нового owner.
- `connecting` не объявляется `connected` до фактического open-state; terminal `logged_out`/`banned` останавливают supervisor и освобождают ownership.
- `banned` подтверждает physical transport close до release и сохраняет terminal manager-state/auth-state.
- Ошибка status persistence не превращается в ложный transport disconnect; visibility повторяется следующим reconciliation tick.
- Transient/restart/connection-closed с сохранённым auth-state запускают сериализованный reconnect с retry/backoff; terminal states не reconnect-ятся.

## Ручной QA (QA_CHECKPOINTS.md §3.1)

- [x] Контракт watchdog/ownership проверен детерминированными unit/race-тестами без сети и real socket.
- [x] Worker default не менялся и остаётся `MockSessionManager`; real Baileys wiring не включён.
- [ ] Реальный QR/reconnect/restart smoke-test не выполнялся: требует отдельного OWNER_DECISION и тестового WA-аккаунта, не является разрешённой частью этой задачи.

## Найденные дефекты / решения

- Один общий `inFlight` блокировал lease renew на время slow DB/transport работы; heartbeat и reconciliation разделены.
- Ошибка Redis renew раньше только писала disconnected и оставляла uncertain socket; теперь всегда выполняется fail-closed close.
- Ограниченные три close-attempt могли бросить orphan socket; cleanup повторяется до подтверждённого close с capped exponential backoff.
- Старый owner мог затереть статус нового; post-loss shared status write удалён.
- Start/stop гонялись друг с другом; команды получили per-instance promise serialization.
- Terminal banned освобождал ownership без явного physical-close barrier; manager и supervisor теперь подтверждают close до release.
- Start rollback после ошибки close мог оставить broken transport под обычной supervision; rollback теперь повторяет close до подтверждения и только затем освобождает ownership и возвращает исходную start error.
- Status visibility failure объявлялась transport failure; transport state и persistence error разведены.
- Независимый review-субагент выполнил три blocker-pass; найденные P0/P1 закрыты TDD, финальный verdict — P0/P1 не обнаружено.
