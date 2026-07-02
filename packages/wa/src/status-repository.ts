export type WaAccountRuntimeStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'logged_out'
  | 'restricted'
  | 'banned'

export interface WaAccountStatusRecord {
  instanceId: string
  workerId: string
  status: WaAccountRuntimeStatus
  recordedAt: Date
  reason?: string
  restrictedUntil?: Date
}

export interface WaAccountStatusRepository {
  markConnecting(instanceId: string, workerId: string): Promise<void>
  markConnected(instanceId: string, workerId: string): Promise<void>
  markDisconnected(instanceId: string, workerId: string, reason?: string): Promise<void>
  markLoggedOut(instanceId: string, workerId: string): Promise<void>
  markRestricted(instanceId: string, workerId: string, restrictedUntil: Date): Promise<void>
  markBanned(instanceId: string, workerId: string, reason?: string): Promise<void>
}

export class InMemoryWaAccountStatusRepository implements WaAccountStatusRepository {
  private readonly latest = new Map<string, WaAccountStatusRecord>()
  private readonly entries: WaAccountStatusRecord[] = []

  async markConnecting(instanceId: string, workerId: string): Promise<void> {
    this.record({ instanceId, workerId, status: 'connecting' })
  }

  async markConnected(instanceId: string, workerId: string): Promise<void> {
    this.record({ instanceId, workerId, status: 'connected' })
  }

  async markDisconnected(instanceId: string, workerId: string, reason?: string): Promise<void> {
    this.record({ instanceId, workerId, status: 'disconnected', reason })
  }

  async markLoggedOut(instanceId: string, workerId: string): Promise<void> {
    this.record({ instanceId, workerId, status: 'logged_out' })
  }

  async markRestricted(instanceId: string, workerId: string, restrictedUntil: Date): Promise<void> {
    this.record({ instanceId, workerId, status: 'restricted', restrictedUntil })
  }

  async markBanned(instanceId: string, workerId: string, reason?: string): Promise<void> {
    this.record({ instanceId, workerId, status: 'banned', reason })
  }

  getLast(instanceId: string): WaAccountStatusRecord | undefined {
    const entry = this.latest.get(instanceId)

    return entry ? cloneRecord(entry) : undefined
  }

  getHistory(instanceId?: string): WaAccountStatusRecord[] {
    const entries = instanceId ? this.entries.filter((entry) => entry.instanceId === instanceId) : this.entries

    return entries.map(cloneRecord)
  }

  clear(): void {
    this.latest.clear()
    this.entries.splice(0)
  }

  private record(input: Omit<WaAccountStatusRecord, 'recordedAt'>): void {
    const entry = cloneRecord({
      ...input,
      recordedAt: new Date(),
    })

    this.latest.set(entry.instanceId, entry)
    this.entries.push(entry)
  }
}

function cloneRecord(record: WaAccountStatusRecord): WaAccountStatusRecord {
  return {
    ...record,
    recordedAt: new Date(record.recordedAt),
    restrictedUntil: record.restrictedUntil ? new Date(record.restrictedUntil) : undefined,
  }
}
