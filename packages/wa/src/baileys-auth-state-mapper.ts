import {
  assertWaAuthStatePayload,
  cloneWaAuthStatePayload,
  type WaAuthStateJsonValue,
  type WaAuthStatePayload,
  type WaAuthStateStore,
} from './auth-state'

export type BaileysAuthCreds = Record<string, WaAuthStateJsonValue>
export type BaileysAuthKeyBucket = Record<string, WaAuthStateJsonValue>
export type BaileysAuthKeys = Record<string, BaileysAuthKeyBucket>

export interface BaileysAuthState {
  creds: BaileysAuthCreds
  keys: BaileysAuthKeys
}

export class BaileysAuthStateMapperError extends TypeError {
  constructor(
    message = 'Baileys auth-state mapper payload is malformed',
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'BaileysAuthStateMapperError'
  }
}

export async function readBaileysAuthState(
  instanceId: string,
  store: WaAuthStateStore,
): Promise<BaileysAuthState> {
  const payload = await store.read(instanceId)
  if (payload === null) return createEmptyBaileysAuthState()

  return cloneBaileysAuthState(
    payload,
    'Stored Baileys auth-state payload is malformed',
  )
}

export async function writeBaileysAuthState(
  instanceId: string,
  state: BaileysAuthState,
  store: WaAuthStateStore,
): Promise<void> {
  await store.write(
    instanceId,
    toWaAuthStatePayload(state, 'Baileys auth-state write payload is malformed'),
  )
}

export async function clearBaileysAuthState(
  instanceId: string,
  store: WaAuthStateStore,
): Promise<void> {
  await store.clear(instanceId)
}

function createEmptyBaileysAuthState(): BaileysAuthState {
  return {
    creds: {},
    keys: {},
  }
}

function cloneBaileysAuthState(value: unknown, errorMessage: string): BaileysAuthState {
  return toBaileysAuthState(toWaAuthStatePayload(value, errorMessage))
}

function toWaAuthStatePayload(value: unknown, errorMessage: string): WaAuthStatePayload {
  assertBaileysAuthState(value, errorMessage)

  try {
    return cloneWaAuthStatePayload({
      creds: value.creds,
      keys: value.keys,
    })
  } catch (error) {
    throw new BaileysAuthStateMapperError(errorMessage, { cause: error })
  }
}

function toBaileysAuthState(payload: WaAuthStatePayload): BaileysAuthState {
  return {
    creds: payload.creds as BaileysAuthCreds,
    keys: payload.keys as BaileysAuthKeys,
  }
}

function assertBaileysAuthState(
  value: unknown,
  errorMessage: string,
): asserts value is BaileysAuthState {
  if (!isPlainJsonObject(value)) {
    throw new BaileysAuthStateMapperError(errorMessage)
  }

  if (!isPlainJsonObject(value.creds)) {
    throw new BaileysAuthStateMapperError(`${errorMessage}: creds must be a JSON object`)
  }

  if (!isPlainJsonObject(value.keys)) {
    throw new BaileysAuthStateMapperError(`${errorMessage}: keys must be a JSON object`)
  }

  for (const [keyType, keyBucket] of Object.entries(value.keys)) {
    if (!isPlainJsonObject(keyBucket)) {
      throw new BaileysAuthStateMapperError(
        `${errorMessage}: keys.${keyType} must be a JSON object`,
      )
    }
  }

  try {
    assertWaAuthStatePayload({
      creds: value.creds,
      keys: value.keys,
    })
  } catch (error) {
    throw new BaileysAuthStateMapperError(`${errorMessage}: value must be JSON-serializable`, {
      cause: error,
    })
  }
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
