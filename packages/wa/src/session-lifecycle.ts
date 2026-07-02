import type { OwnerRegistry } from './owner-registry'
import { OwnedSessionManager, WaOwnershipError } from './owned-session-manager'
import type { SessionManager, SessionState } from './session'

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

    try {
      return await this.ownedSessions.connect(instanceId)
    } catch (error) {
      await this.ownerRegistry.release(instanceId, this.workerId)
      throw error
    }
  }

  renew(instanceId: string): Promise<boolean> {
    return this.ownerRegistry.renew(instanceId, this.workerId, this.ttlMs)
  }

  stop(instanceId: string): Promise<boolean> {
    return this.ownerRegistry.release(instanceId, this.workerId)
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
