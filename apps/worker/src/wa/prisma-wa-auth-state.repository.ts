import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import { Prisma, prisma, type PrismaClient } from '@smartmessage/db'
import {
  assertWaAuthStatePayload,
  cloneWaAuthStatePayload,
  normalizeWaAuthStateInstanceId,
  type WaAuthStatePayload,
  type WaAuthStateStore,
} from '@smartmessage/wa'

const AUTH_STATE_ENVELOPE_KIND = 'smartmessage.wa-auth-state'
const AUTH_STATE_ENVELOPE_VERSION = 1
const AUTH_STATE_ALGORITHM = 'aes-256-gcm'
const AUTH_STATE_IV_BYTES = 12
const AUTH_STATE_TAG_BYTES = 16

export interface WaAuthStateEncryptionConfig {
  readonly key: Buffer | null
}

interface WaAuthStateEncryptedEnvelope {
  kind: typeof AUTH_STATE_ENVELOPE_KIND
  version: typeof AUTH_STATE_ENVELOPE_VERSION
  algorithm: typeof AUTH_STATE_ALGORITHM
  iv: string
  ciphertext: string
  authTag: string
}

export class WaAuthStateAccountNotFoundError extends Error {
  constructor(readonly instanceId: string) {
    super(`WA auth-state write failed: instanceId ${instanceId} was not found`)
    this.name = 'WaAuthStateAccountNotFoundError'
  }
}

export class WaAuthStateEncryptionConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WaAuthStateEncryptionConfigurationError'
  }
}

export class WaAuthStateDecryptionError extends Error {
  constructor(options?: ErrorOptions) {
    super('WA auth-state decryption failed', options)
    this.name = 'WaAuthStateDecryptionError'
  }
}

export class PrismaWaAuthStateRepository implements WaAuthStateStore {
  constructor(
    private readonly db: PrismaClient = prisma,
    private readonly encryption: WaAuthStateEncryptionConfig = resolveWaAuthStateEncryptionConfig(
      process.env.WA_AUTH_STATE_ENCRYPTION_KEY,
      process.env.WA_SESSION_RUNTIME,
    ),
  ) {}

  async read(instanceId: string): Promise<WaAuthStatePayload | null> {
    const normalizedInstanceId = normalizeWaAuthStateInstanceId(instanceId)
    const row = await this.db.waAuthState.findUnique({
      where: { instanceId: normalizedInstanceId },
      select: { payload: true },
    })

    if (!row) return null

    const key = requireEncryptionKey(this.encryption)
    if (isEncryptedEnvelope(row.payload)) {
      return decryptAuthState(normalizedInstanceId, row.payload, key)
    }

    assertWaAuthStatePayload(row.payload)
    const legacyPayload = cloneWaAuthStatePayload(row.payload)
    const encryptedPayload = encryptAuthState(normalizedInstanceId, legacyPayload, key)
    await this.db.waAuthState.updateMany({
      where: {
        instanceId: normalizedInstanceId,
        payload: { equals: row.payload as Prisma.InputJsonValue },
      },
      data: { payload: toPrismaJsonObject(encryptedPayload) },
    })

    return legacyPayload
  }

  async write(instanceId: string, state: WaAuthStatePayload): Promise<void> {
    const normalizedInstanceId = normalizeWaAuthStateInstanceId(instanceId)
    const key = requireEncryptionKey(this.encryption)
    const payload = toPrismaJsonObject(encryptAuthState(normalizedInstanceId, state, key))
    const account = await this.db.waAccount.findUnique({
      where: { instanceId: normalizedInstanceId },
      select: { id: true },
    })

    if (!account) {
      throw new WaAuthStateAccountNotFoundError(normalizedInstanceId)
    }

    try {
      await this.db.waAuthState.upsert({
        where: { instanceId: normalizedInstanceId },
        create: {
          instanceId: normalizedInstanceId,
          payload,
        },
        update: {
          payload,
        },
      })
    } catch (error) {
      if (isPrismaError(error, 'P2003')) {
        throw new WaAuthStateAccountNotFoundError(normalizedInstanceId)
      }

      throw error
    }
  }

  async clear(instanceId: string): Promise<void> {
    await this.db.waAuthState.deleteMany({
      where: { instanceId: normalizeWaAuthStateInstanceId(instanceId) },
    })
  }

  async has(instanceId: string): Promise<boolean> {
    const count = await this.db.waAuthState.count({
      where: { instanceId: normalizeWaAuthStateInstanceId(instanceId) },
    })

    return count > 0
  }
}

export function resolveWaAuthStateEncryptionConfig(
  encodedKey: string | undefined,
  runtimeMode: string | undefined,
): WaAuthStateEncryptionConfig {
  const normalizedKey = encodedKey?.trim()
  if (!normalizedKey) {
    if (runtimeMode?.trim().toLowerCase() === 'baileys') {
      throw new WaAuthStateEncryptionConfigurationError(
        'WA_AUTH_STATE_ENCRYPTION_KEY is required when WA_SESSION_RUNTIME=baileys',
      )
    }

    return { key: null }
  }

  if (!/^[A-Za-z0-9+/]{43}=$/.test(normalizedKey)) {
    throw invalidEncryptionKeyError()
  }

  const key = Buffer.from(normalizedKey, 'base64')
  if (key.length !== 32 || key.toString('base64') !== normalizedKey) {
    throw invalidEncryptionKeyError()
  }

  return { key }
}

function encryptAuthState(
  instanceId: string,
  state: WaAuthStatePayload,
  key: Buffer,
): WaAuthStateEncryptedEnvelope {
  const plaintext = Buffer.from(JSON.stringify(cloneWaAuthStatePayload(state)), 'utf8')
  const iv = randomBytes(AUTH_STATE_IV_BYTES)
  const cipher = createCipheriv(AUTH_STATE_ALGORITHM, key, iv, {
    authTagLength: AUTH_STATE_TAG_BYTES,
  })
  cipher.setAAD(createAdditionalAuthenticatedData(instanceId))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])

  return {
    kind: AUTH_STATE_ENVELOPE_KIND,
    version: AUTH_STATE_ENVELOPE_VERSION,
    algorithm: AUTH_STATE_ALGORITHM,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  }
}

function decryptAuthState(
  instanceId: string,
  envelope: WaAuthStateEncryptedEnvelope,
  key: Buffer,
): WaAuthStatePayload {
  try {
    const iv = decodeEnvelopeField(envelope.iv, AUTH_STATE_IV_BYTES)
    const ciphertext = decodeEnvelopeField(envelope.ciphertext)
    const authTag = decodeEnvelopeField(envelope.authTag, AUTH_STATE_TAG_BYTES)
    const decipher = createDecipheriv(AUTH_STATE_ALGORITHM, key, iv, {
      authTagLength: AUTH_STATE_TAG_BYTES,
    })
    decipher.setAAD(createAdditionalAuthenticatedData(instanceId))
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const payload: unknown = JSON.parse(plaintext.toString('utf8'))
    assertWaAuthStatePayload(payload)
    return cloneWaAuthStatePayload(payload)
  } catch (error) {
    throw new WaAuthStateDecryptionError({ cause: error })
  }
}

function createAdditionalAuthenticatedData(instanceId: string): Buffer {
  return Buffer.from(`${AUTH_STATE_ENVELOPE_KIND}:v${AUTH_STATE_ENVELOPE_VERSION}:${instanceId}`)
}

function toPrismaJsonObject(envelope: WaAuthStateEncryptedEnvelope): Prisma.InputJsonObject {
  return { ...envelope }
}

function isEncryptedEnvelope(value: unknown): value is WaAuthStateEncryptedEnvelope {
  if (!isRecord(value) || value.kind !== AUTH_STATE_ENVELOPE_KIND) return false

  if (
    value.version !== AUTH_STATE_ENVELOPE_VERSION ||
    value.algorithm !== AUTH_STATE_ALGORITHM ||
    typeof value.iv !== 'string' ||
    typeof value.ciphertext !== 'string' ||
    typeof value.authTag !== 'string'
  ) {
    throw new WaAuthStateDecryptionError()
  }

  return true
}

function decodeEnvelopeField(value: string, expectedBytes?: number): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError('Invalid encrypted WA auth-state envelope')
  }

  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value || (expectedBytes && decoded.length !== expectedBytes)) {
    throw new TypeError('Invalid encrypted WA auth-state envelope')
  }
  return decoded
}

function requireEncryptionKey(config: WaAuthStateEncryptionConfig): Buffer {
  if (!config.key) {
    throw new WaAuthStateEncryptionConfigurationError('WA auth-state encryption is not configured')
  }
  return config.key
}

function invalidEncryptionKeyError(): WaAuthStateEncryptionConfigurationError {
  return new WaAuthStateEncryptionConfigurationError(
    'WA_AUTH_STATE_ENCRYPTION_KEY must be canonical base64 encoding of exactly 32 bytes',
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPrismaError(
  error: unknown,
  code: string,
): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code
}
