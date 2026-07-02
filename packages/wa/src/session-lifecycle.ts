import type { OwnerRegistry } from './owner-registry'
import { OwnedSessionManager, WaOwnershipError } from './owned-session-manager'
import type { SessionManager, SessionState } from './session'

const CONNECT_ATTEMPTS = 3
const CONNECT_BACKOFF_MS = 10
const timerRuntime = globalThis as unknown as TimerRuntime

interface TimerRuntime {
  setInterval(handler: () => void, timeoutMs: number): unknown
  clearInterval(handle: unknown): void
  setTimeout(handler: () => void, timeoutMs: number): unknown
}

export class WaSessionLifecycleService {
  private readonly workerId: string
  private readonly ttlMs: number
  private readonly ownedSessions: SessionManager

  constructor(
    workerId: string,
    private readonly ownerRegistry: OwnerRegistry,
    sessionManager: SessionManager,
    ttlMs: number,
  ) {
    this.workerId = normalizeWorkerId(workerId)
    this.ttlMs = normalizeTtl(ttlMs)
    this.ownedSessions = new OwnedSessionManager(sessionManager, ownerRegistry, this.workerId)
  }

  async start(instanceId: string): Promise<SessionState> {
    const claim = await this.ownerRegistry.claim(instanceId, this.workerId, this.ttlMs)
    if (!claim.claimed) {
      throw new WaOwnershipError(instanceId, this.workerId, claim.owner)
    }

    const renewal = this.startRenewalLoop(instanceId)
    try {
      const state = await this.connectWithRetry(instanceId)
      await this.assertLeaseStillOwned(instanceId)
      return state
    } catch (error) {
      await this.ownerRegistry.release(instanceId, this.workerId)
      throw error
    } finally {
      renewal.stop()
    }
  }

  renew(instanceId: string): Promise<boolean> {
    return this.ownerRegistry.renew(instanceId, this.workerId, this.ttlMs)
  }

  async stop(instanceId: string): Promise<boolean> {
    const owner = await this.ownerRegistry.getOwner(instanceId)
    if (owner !== this.workerId) return false

    await this.ownedSessions.closeTransport(instanceId)

    return this.ownerRegistry.release(instanceId, this.workerId)
  }

  private async connectWithRetry(instanceId: string): Promise<SessionState> {
    let lastError: unknown

    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
      try {
        return await this.ownedSessions.connect(instanceId)
      } catch (error) {
        lastError = error
        if (error instanceof WaOwnershipError || attempt === CONNECT_ATTEMPTS) {
          throw error
        }

        await delay(CONNECT_BACKOFF_MS)
      }
    }

    throw lastError
  }

  private startRenewalLoop(instanceId: string): { stop: () => void } {
    const intervalMs = Math.max(1, Math.floor(this.ttlMs / 2))
    const timer = timerRuntime.setInterval(() => {
      void this.ownerRegistry.renew(instanceId, this.workerId, this.ttlMs)
    }, intervalMs)

    return {
      stop: () => timerRuntime.clearInterval(timer),
    }
  }

  private async assertLeaseStillOwned(instanceId: string): Promise<void> {
    const renewed = await this.ownerRegistry.renew(instanceId, this.workerId, this.ttlMs)
    if (renewed) return

    const owner = await this.ownerRegistry.getOwner(instanceId)
    throw new WaOwnershipError(instanceId, this.workerId, owner)
  }
}

function normalizeWorkerId(workerId: string): string {
  const normalizedWorkerId = workerId.trim()
  if (normalizedWorkerId.length === 0) {
    throw new TypeError('workerId must be a non-empty string')
  }

  return normalizedWorkerId
}

function normalizeTtl(ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError('ttlMs must be a positive safe integer')
  }

  return ttlMs
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    timerRuntime.setTimeout(resolve, ms)
  })
}
