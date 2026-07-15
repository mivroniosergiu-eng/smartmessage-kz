import type { OwnerRegistry } from './owner-registry'
import type { SessionManager, SessionState, WaDisconnectReason } from './session'

export class WaOwnershipError extends Error {
  readonly instanceId: string
  readonly workerId: string
  readonly owner: string | null

  constructor(instanceId: string, workerId: string, owner: string | null) {
    const ownerLabel = owner ?? 'none'
    super(`Worker ${workerId} does not own WA session ${instanceId}; current owner: ${ownerLabel}`)
    this.name = 'WaOwnershipError'
    this.instanceId = instanceId
    this.workerId = workerId
    this.owner = owner
  }
}

export class OwnedSessionManager implements SessionManager {
  private readonly workerId: string

  constructor(
    private readonly inner: SessionManager,
    private readonly ownerRegistry: OwnerRegistry,
    workerId: string,
  ) {
    this.workerId = normalizeWorkerId(workerId)
  }

  async getState(instanceId: string): Promise<SessionState> {
    return this.inner.getState(instanceId)
  }

  async connect(instanceId: string): Promise<SessionState> {
    await this.assertOwned(instanceId)

    return this.inner.connect(instanceId)
  }

  async closeTransport(instanceId: string): Promise<SessionState> {
    await this.assertOwned(instanceId)

    return this.inner.closeTransport(instanceId)
  }

  async handleDisconnect(
    instanceId: string,
    reason: WaDisconnectReason,
    restrictedUntil?: Date,
  ): Promise<SessionState> {
    await this.assertOwned(instanceId)

    return this.inner.handleDisconnect(instanceId, reason, restrictedUntil)
  }

  async logout(instanceId: string): Promise<SessionState> {
    await this.assertOwned(instanceId)

    return this.inner.logout(instanceId)
  }

  private async assertOwned(instanceId: string): Promise<void> {
    const owner = await this.ownerRegistry.getOwner(instanceId)
    if (owner !== this.workerId) {
      throw new WaOwnershipError(instanceId, this.workerId, owner)
    }
  }
}

function normalizeWorkerId(workerId: string): string {
  const normalizedWorkerId = workerId.trim()
  if (normalizedWorkerId.length === 0) {
    throw new TypeError('workerId must be a non-empty string')
  }

  return normalizedWorkerId
}
