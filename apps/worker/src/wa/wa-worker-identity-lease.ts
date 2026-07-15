import { randomUUID } from 'node:crypto'

export interface WaWorkerIdentityRedisPort {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>
  get(key: string): Promise<string | null>
}

export interface WaWorkerIdentityTimerPort {
  setInterval(handler: () => void, intervalMs: number): unknown
  clearInterval(handle: unknown): void
  setTimeout(handler: () => void, timeoutMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface WaWorkerIdentityLeaseOptions {
  workerId: string
  redis: WaWorkerIdentityRedisPort
  ttlMs: number
  keyPrefix?: string
  tokenFactory?: () => string
  timer?: WaWorkerIdentityTimerPort
}

const DEFAULT_KEY_PREFIX = 'wa:worker-identity:'
const timerRuntime = globalThis as unknown as WaWorkerIdentityTimerPort
const RENEWAL_CANCELLED = Symbol('wa-worker-identity-renewal-cancelled')

const ACQUIRE_SCRIPT = `
if redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2], "NX") then
  return 1
end
return 0
`

const RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("PEXPIRE", KEYS[1], ARGV[2])
  return 1
end
return 0
`

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("DEL", KEYS[1])
  return 1
end
return 0
`

export class WaWorkerIdentityConflictError extends Error {
  constructor(readonly workerId: string) {
    super(`WA worker identity is already leased by another physical process: ${workerId}`)
    this.name = 'WaWorkerIdentityConflictError'
  }
}

export class WaWorkerIdentityLeaseLostError extends Error {
  constructor(readonly workerId: string) {
    super(`WA worker identity lease was lost: ${workerId}`)
    this.name = 'WaWorkerIdentityLeaseLostError'
  }
}

export class WaWorkerIdentityRenewalTimeoutError extends WaWorkerIdentityLeaseLostError {
  constructor(
    workerId: string,
    readonly timeoutMs: number,
  ) {
    super(workerId)
    this.message = `WA worker identity renewal timed out after ${timeoutMs}ms: ${workerId}`
    this.name = 'WaWorkerIdentityRenewalTimeoutError'
  }
}

export class WaWorkerIdentityLease {
  private readonly workerId: string
  private readonly redis: WaWorkerIdentityRedisPort
  private readonly ttlMs: number
  private readonly key: string
  private readonly token: string
  private readonly timer: WaWorkerIdentityTimerPort
  private onLost?: (error: Error) => void | Promise<void>
  private renewalHandle?: unknown
  private renewalDeadline?: { cancel: () => void }
  private renewalGeneration = 0
  private renewalInFlight = false
  private acquired = false
  private lossReported = false

  constructor(options: WaWorkerIdentityLeaseOptions) {
    this.workerId = normalizeNonEmpty(options.workerId, 'workerId')
    this.redis = options.redis
    this.ttlMs = normalizeTtl(options.ttlMs)
    this.key = `${options.keyPrefix ?? DEFAULT_KEY_PREFIX}${encodeURIComponent(this.workerId)}`
    this.token = normalizeNonEmpty((options.tokenFactory ?? randomUUID)(), 'process token')
    this.timer = options.timer ?? timerRuntime
  }

  async acquire(): Promise<void> {
    if (this.acquired) {
      throw new Error(`WA worker identity lease is already acquired: ${this.workerId}`)
    }

    const result = await this.redis.eval(
      ACQUIRE_SCRIPT,
      1,
      this.key,
      this.token,
      String(this.ttlMs),
    )
    if (result !== 1) {
      if (result !== 0) throw new TypeError('Unexpected Redis worker identity acquire result')
      throw new WaWorkerIdentityConflictError(this.workerId)
    }

    this.acquired = true
    this.lossReported = false
  }

  async startRenewal(onLost: (error: Error) => void | Promise<void>): Promise<void> {
    if (!this.acquired) {
      throw new Error(`WA worker identity lease is not acquired: ${this.workerId}`)
    }

    this.stopRenewal()
    this.onLost = onLost
    this.lossReported = false
    const generation = this.renewalGeneration
    try {
      const renewed = await this.renewWithDeadline()
      if (renewed === RENEWAL_CANCELLED) return
      if (!renewed) {
        const error = new WaWorkerIdentityLeaseLostError(this.workerId)
        this.reportLoss(error, generation, false)
        throw error
      }
    } catch (error: unknown) {
      const normalizedError = toError(error)
      this.reportLoss(normalizedError, generation, false)
      throw normalizedError
    }

    if (generation === this.renewalGeneration && this.acquired) this.armRenewal()
  }

  async renew(): Promise<boolean> {
    const result = await this.redis.eval(RENEW_SCRIPT, 1, this.key, this.token, String(this.ttlMs))
    return parseBooleanResult(result, 'renew')
  }

  stopRenewal(): void {
    this.renewalGeneration += 1
    if (this.renewalHandle !== undefined) {
      this.timer.clearInterval(this.renewalHandle)
      this.renewalHandle = undefined
    }
    const renewalDeadline = this.renewalDeadline
    this.renewalDeadline = undefined
    renewalDeadline?.cancel()
    this.onLost = undefined
  }

  async release(): Promise<boolean> {
    this.stopRenewal()
    try {
      const result = await this.redis.eval(RELEASE_SCRIPT, 1, this.key, this.token)
      return parseBooleanResult(result, 'release')
    } finally {
      this.acquired = false
    }
  }

  private armRenewal(): void {
    const generation = this.renewalGeneration
    this.renewalHandle = this.timer.setInterval(
      () => {
        void this.runPeriodicRenewal(generation)
      },
      Math.max(1, Math.floor(this.ttlMs / 3)),
    )
    unrefTimer(this.renewalHandle)
  }

  private async runPeriodicRenewal(generation: number): Promise<void> {
    if (
      generation !== this.renewalGeneration ||
      this.renewalHandle === undefined ||
      !this.acquired ||
      this.renewalInFlight
    ) {
      return
    }

    this.renewalInFlight = true
    try {
      const renewed = await this.renewWithDeadline()
      if (renewed === RENEWAL_CANCELLED) return
      if (!renewed) {
        this.reportLoss(new WaWorkerIdentityLeaseLostError(this.workerId), generation, true)
      }
    } catch (error: unknown) {
      this.reportLoss(toError(error), generation, true)
    } finally {
      this.renewalInFlight = false
    }
  }

  private async renewWithDeadline(): Promise<boolean | typeof RENEWAL_CANCELLED> {
    const timeoutMs = this.ttlMs / 3
    let active = true
    let resolveCancellation!: (result: typeof RENEWAL_CANCELLED) => void
    let rejectTimeout!: (error: Error) => void
    const cancellation = new Promise<typeof RENEWAL_CANCELLED>((resolve) => {
      resolveCancellation = resolve
    })
    const timeout = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject
    })
    const timeoutHandle = this.timer.setTimeout(() => {
      if (!active) return
      active = false
      rejectTimeout(new WaWorkerIdentityRenewalTimeoutError(this.workerId, timeoutMs))
    }, timeoutMs)
    unrefTimer(timeoutHandle)

    const renewalDeadline = {
      cancel: () => {
        if (!active) return
        active = false
        this.timer.clearTimeout(timeoutHandle)
        resolveCancellation(RENEWAL_CANCELLED)
      },
    }
    this.renewalDeadline = renewalDeadline

    try {
      return await Promise.race([this.renew(), timeout, cancellation])
    } finally {
      if (active) {
        active = false
        this.timer.clearTimeout(timeoutHandle)
      }
      if (this.renewalDeadline === renewalDeadline) this.renewalDeadline = undefined
    }
  }

  private reportLoss(error: Error, generation: number, requireArmed: boolean): void {
    if (
      generation !== this.renewalGeneration ||
      (requireArmed && this.renewalHandle === undefined) ||
      !this.acquired ||
      this.lossReported
    ) {
      return
    }

    this.lossReported = true
    this.acquired = false
    const onLost = this.onLost
    this.stopRenewal()
    if (onLost) {
      void Promise.resolve()
        .then(() => onLost(error))
        .catch(() => undefined)
    }
  }
}

function normalizeNonEmpty(value: string, fieldName: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new TypeError(`${fieldName} must be a non-empty string`)
  return normalized
}

function normalizeTtl(ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError('ttlMs must be a positive safe integer')
  }
  return ttlMs
}

function parseBooleanResult(result: unknown, operation: string): boolean {
  if (result === 1) return true
  if (result === 0) return false
  throw new TypeError(`Unexpected Redis worker identity ${operation} result`)
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function unrefTimer(handle: unknown): void {
  if (typeof handle !== 'object' || handle === null || !('unref' in handle)) return
  const unref = (handle as { unref?: unknown }).unref
  if (typeof unref === 'function') unref.call(handle)
}
