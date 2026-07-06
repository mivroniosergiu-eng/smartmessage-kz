export type WaAuthStateJsonPrimitive = string | number | boolean | null

export type WaAuthStateJsonValue =
  | WaAuthStateJsonPrimitive
  | WaAuthStatePayload
  | WaAuthStateJsonValue[]

export interface WaAuthStatePayload {
  [key: string]: WaAuthStateJsonValue
}

export interface WaAuthStateStore {
  read(instanceId: string): Promise<WaAuthStatePayload | null>
  write(instanceId: string, state: WaAuthStatePayload): Promise<void>
  clear(instanceId: string): Promise<void>
  has(instanceId: string): Promise<boolean>
}

export class WaAuthStatePayloadError extends TypeError {
  constructor(message = 'WA auth-state payload must be a JSON-serializable object') {
    super(message)
    this.name = 'WaAuthStatePayloadError'
  }
}

export class InMemoryWaAuthStateStore implements WaAuthStateStore {
  private readonly states = new Map<string, WaAuthStatePayload>()

  async read(instanceId: string): Promise<WaAuthStatePayload | null> {
    const state = this.states.get(normalizeWaAuthStateInstanceId(instanceId))
    return state ? cloneWaAuthStatePayload(state) : null
  }

  async write(instanceId: string, state: WaAuthStatePayload): Promise<void> {
    this.states.set(
      normalizeWaAuthStateInstanceId(instanceId),
      cloneWaAuthStatePayload(state),
    )
  }

  async clear(instanceId: string): Promise<void> {
    this.states.delete(normalizeWaAuthStateInstanceId(instanceId))
  }

  async has(instanceId: string): Promise<boolean> {
    return this.states.has(normalizeWaAuthStateInstanceId(instanceId))
  }
}

export function normalizeWaAuthStateInstanceId(instanceId: string): string {
  const normalized = instanceId.trim()
  if (normalized.length === 0) {
    throw new TypeError('instanceId must be a non-empty string')
  }

  return normalized
}

export function cloneWaAuthStatePayload(state: WaAuthStatePayload): WaAuthStatePayload {
  assertWaAuthStatePayload(state)
  return JSON.parse(JSON.stringify(state)) as WaAuthStatePayload
}

export function assertWaAuthStatePayload(value: unknown): asserts value is WaAuthStatePayload {
  if (!isPlainJsonObject(value)) {
    throw new WaAuthStatePayloadError()
  }

  assertJsonValue(value)
}

function assertJsonValue(value: unknown): void {
  if (value === null) return

  if (typeof value === 'string' || typeof value === 'boolean') return

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new WaAuthStatePayloadError('WA auth-state payload numbers must be finite')
    }
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item)
    return
  }

  if (isPlainJsonObject(value)) {
    for (const item of Object.values(value)) assertJsonValue(item)
    return
  }

  throw new WaAuthStatePayloadError()
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
