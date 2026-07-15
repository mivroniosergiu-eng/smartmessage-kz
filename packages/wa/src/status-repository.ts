export type WaAccountRuntimeStatus =
  'connecting' | 'connected' | 'disconnected' | 'logged_out' | 'restricted' | 'banned'

export interface WaAccountStatusRecord {
  instanceId: string
  workerId: string
  epoch: bigint
  status: WaAccountRuntimeStatus
  recordedAt: Date
  reason?: string
  restrictedUntil?: Date
}

export interface WaAccountStatusRepository {
  getOwnershipEpoch(instanceId: string): Promise<bigint>
  activateOwnership(instanceId: string, workerId: string, epoch: bigint): Promise<boolean>
  markConnecting(instanceId: string, workerId: string, epoch: bigint): Promise<boolean>
  markConnected(instanceId: string, workerId: string, epoch: bigint): Promise<boolean>
  markDisconnected(
    instanceId: string,
    workerId: string,
    reason: string | undefined,
    epoch: bigint,
  ): Promise<boolean>
  markLoggedOut(instanceId: string, workerId: string, epoch: bigint): Promise<boolean>
  markRestricted(
    instanceId: string,
    workerId: string,
    restrictedUntil: Date,
    epoch: bigint,
  ): Promise<boolean>
  markBanned(
    instanceId: string,
    workerId: string,
    reason: string | undefined,
    epoch: bigint,
  ): Promise<boolean>
}

export class InMemoryWaAccountStatusRepository implements WaAccountStatusRepository {
  private readonly latest = new Map<string, WaAccountStatusRecord>()
  private readonly entries: WaAccountStatusRecord[] = []
  private readonly fences = new Map<string, { workerId: string; epoch: bigint }>()

  async getOwnershipEpoch(instanceId: string): Promise<bigint> {
    return this.fences.get(instanceId)?.epoch ?? 0n
  }

  async activateOwnership(instanceId: string, workerId: string, epoch: bigint): Promise<boolean> {
    const current = this.fences.get(instanceId)
    if (
      current &&
      (current.epoch > epoch || (current.epoch === epoch && current.workerId !== workerId))
    ) {
      return false
    }
    this.fences.set(instanceId, { workerId, epoch })
    return true
  }

  async markConnecting(instanceId: string, workerId: string, epoch: bigint): Promise<boolean> {
    return this.record({ instanceId, workerId, epoch, status: 'connecting' })
  }

  async markConnected(instanceId: string, workerId: string, epoch: bigint): Promise<boolean> {
    return this.record({ instanceId, workerId, epoch, status: 'connected' })
  }

  async markDisconnected(
    instanceId: string,
    workerId: string,
    reason: string | undefined,
    epoch: bigint,
  ): Promise<boolean> {
    return this.record({ instanceId, workerId, epoch, status: 'disconnected', reason })
  }

  async markLoggedOut(instanceId: string, workerId: string, epoch: bigint): Promise<boolean> {
    return this.record({ instanceId, workerId, epoch, status: 'logged_out' })
  }

  async markRestricted(
    instanceId: string,
    workerId: string,
    restrictedUntil: Date,
    epoch: bigint,
  ): Promise<boolean> {
    return this.record({ instanceId, workerId, epoch, status: 'restricted', restrictedUntil })
  }

  async markBanned(
    instanceId: string,
    workerId: string,
    reason: string | undefined,
    epoch: bigint,
  ): Promise<boolean> {
    return this.record({ instanceId, workerId, epoch, status: 'banned', reason })
  }

  getLast(instanceId: string): WaAccountStatusRecord | undefined {
    const entry = this.latest.get(instanceId)

    return entry ? cloneRecord(entry) : undefined
  }

  getHistory(instanceId?: string): WaAccountStatusRecord[] {
    const entries = instanceId
      ? this.entries.filter((entry) => entry.instanceId === instanceId)
      : this.entries

    return entries.map(cloneRecord)
  }

  clear(): void {
    this.latest.clear()
    this.entries.splice(0)
  }

  private record(input: Omit<WaAccountStatusRecord, 'recordedAt'>): boolean {
    const fence = this.fences.get(input.instanceId)
    if (!fence || fence.workerId !== input.workerId || fence.epoch !== input.epoch) return false
    const current = this.latest.get(input.instanceId)
    if (current?.status === 'banned') return true
    if (
      current?.status === 'restricted' &&
      input.status === 'restricted' &&
      current.restrictedUntil &&
      input.restrictedUntil &&
      current.restrictedUntil >= input.restrictedUntil
    ) {
      return true
    }
    const entry = cloneRecord({
      ...input,
      recordedAt: new Date(),
    })

    this.latest.set(entry.instanceId, entry)
    this.entries.push(entry)
    return true
  }
}

function cloneRecord(record: WaAccountStatusRecord): WaAccountStatusRecord {
  return {
    ...record,
    recordedAt: new Date(record.recordedAt),
    restrictedUntil: record.restrictedUntil ? new Date(record.restrictedUntil) : undefined,
  }
}
