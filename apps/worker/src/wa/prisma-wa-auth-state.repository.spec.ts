import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { PrismaClient } from '@smartmessage/db'
import type { WaAuthStatePayload } from '@smartmessage/wa'

import {
  PrismaWaAuthStateRepository,
  WaAuthStateAccountNotFoundError,
  WaAuthStateDecryptionError,
  WaAuthStateEncryptionConfigurationError,
  resolveWaAuthStateEncryptionConfig,
} from './prisma-wa-auth-state.repository'

const prisma = new PrismaClient()
const teamId = 'wa-auth-state-team'
const encryptionKey = Buffer.alloc(32, 7).toString('base64')
const differentEncryptionKey = Buffer.alloc(32, 8).toString('base64')

describe('PrismaWaAuthStateRepository', () => {
  const repository = createRepository(encryptionKey)

  beforeEach(async () => {
    await cleanup()
    await prisma.team.create({
      data: { id: teamId, name: 'WA Auth State Team' },
    })
  })

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  it('reads missing auth-state as null and reports has=false', async () => {
    await createWaAccount('auth-state-missing')

    await expect(repository.read('auth-state-missing')).resolves.toBeNull()
    await expect(repository.has('auth-state-missing')).resolves.toBe(false)
  })

  it('writes only a versioned encrypted envelope and decrypts it on read', async () => {
    await createWaAccount('auth-state-instance')
    const payload: WaAuthStatePayload = {
      provider: 'future-connector',
      version: 1,
      credentials: {
        opaque: true,
        keys: ['identity', 'pre-key'],
      },
    }

    await repository.write(' auth-state-instance ', payload)

    await expect(repository.has('auth-state-instance')).resolves.toBe(true)
    await expect(repository.read('auth-state-instance')).resolves.toEqual(payload)

    const stored = await prisma.waAuthState.findUniqueOrThrow({
      where: { instanceId: 'auth-state-instance' },
      select: { payload: true },
    })
    expect(stored.payload).toMatchObject({
      kind: 'smartmessage.wa-auth-state',
      version: 1,
      algorithm: 'aes-256-gcm',
    })
    expect(JSON.stringify(stored.payload)).not.toContain('future-connector')
    expect(JSON.stringify(stored.payload)).not.toContain('identity')
  })

  it('fails closed with the wrong key without exposing decrypted auth-state', async () => {
    await createWaAccount('auth-state-wrong-key')
    await repository.write('auth-state-wrong-key', {
      creds: { privateMaterial: 'must-not-leak' },
      keys: {},
    })

    const wrongKeyRepository = createRepository(differentEncryptionKey)
    const error = await wrongKeyRepository.read('auth-state-wrong-key').catch((caught) => caught)

    expect(error).toBeInstanceOf(WaAuthStateDecryptionError)
    expect(String(error)).not.toContain('must-not-leak')
    expect(String(error)).not.toContain(encryptionKey)
  })

  it('binds the encrypted envelope to instanceId so rows cannot be swapped', async () => {
    await createWaAccount('auth-state-aad-source')
    await createWaAccount('auth-state-aad-target')
    await repository.write('auth-state-aad-source', { creds: { registered: true }, keys: {} })
    const source = await prisma.waAuthState.findUniqueOrThrow({
      where: { instanceId: 'auth-state-aad-source' },
      select: { payload: true },
    })
    await prisma.waAuthState.create({
      data: { instanceId: 'auth-state-aad-target', payload: source.payload },
    })

    await expect(repository.read('auth-state-aad-target')).rejects.toBeInstanceOf(
      WaAuthStateDecryptionError,
    )
  })

  it('rejects an unsupported envelope version instead of downgrading it to legacy plaintext', async () => {
    await createWaAccount('auth-state-unsupported-envelope')
    await prisma.waAuthState.create({
      data: {
        instanceId: 'auth-state-unsupported-envelope',
        payload: {
          kind: 'smartmessage.wa-auth-state',
          version: 2,
          algorithm: 'aes-256-gcm',
          iv: Buffer.alloc(12).toString('base64'),
          ciphertext: Buffer.from('{}').toString('base64'),
          authTag: Buffer.alloc(16).toString('base64'),
        },
      },
    })

    await expect(repository.read('auth-state-unsupported-envelope')).rejects.toBeInstanceOf(
      WaAuthStateDecryptionError,
    )
    await expect(
      prisma.waAuthState.findUniqueOrThrow({
        where: { instanceId: 'auth-state-unsupported-envelope' },
        select: { payload: true },
      }),
    ).resolves.toMatchObject({ payload: { version: 2 } })
  })

  it('reads a legacy plaintext row once and atomically rewrites it as an encrypted envelope', async () => {
    await createWaAccount('auth-state-legacy')
    const legacyPayload: WaAuthStatePayload = {
      creds: { registered: true, privateMaterial: 'legacy-must-disappear' },
      keys: {},
    }
    await prisma.waAuthState.create({
      data: { instanceId: 'auth-state-legacy', payload: legacyPayload },
    })

    await expect(repository.read('auth-state-legacy')).resolves.toEqual(legacyPayload)

    const migrated = await prisma.waAuthState.findUniqueOrThrow({
      where: { instanceId: 'auth-state-legacy' },
      select: { payload: true },
    })
    expect(migrated.payload).toMatchObject({
      kind: 'smartmessage.wa-auth-state',
      version: 1,
      algorithm: 'aes-256-gcm',
    })
    expect(JSON.stringify(migrated.payload)).not.toContain('legacy-must-disappear')
    await expect(repository.read('auth-state-legacy')).resolves.toEqual(legacyPayload)
  })

  it('updates the same instanceId without creating duplicate auth-state rows', async () => {
    await createWaAccount('auth-state-update')
    await repository.write('auth-state-update', { version: 1, token: 'first' })
    const latest: WaAuthStatePayload = { version: 2, token: 'second' }

    await repository.write('auth-state-update', latest)

    await expect(repository.read('auth-state-update')).resolves.toEqual(latest)
    await expect(
      prisma.waAuthState.findMany({ where: { instanceId: 'auth-state-update' } }),
    ).resolves.toHaveLength(1)
  })

  it('maps missing WaAccount on write to an explicit domain error and does not create an account', async () => {
    await expect(
      repository.write('auth-state-missing-account', { version: 1 }),
    ).rejects.toBeInstanceOf(WaAuthStateAccountNotFoundError)

    await expect(
      prisma.waAccount.findMany({ where: { instanceId: 'auth-state-missing-account' } }),
    ).resolves.toHaveLength(0)
    await expect(
      prisma.waAuthState.findMany({ where: { instanceId: 'auth-state-missing-account' } }),
    ).resolves.toHaveLength(0)
  })

  it('clears auth-state without deleting the WaAccount', async () => {
    await createWaAccount('auth-state-clear')
    await repository.write('auth-state-clear', { version: 1 })

    await repository.clear(' auth-state-clear ')

    await expect(repository.read('auth-state-clear')).resolves.toBeNull()
    await expect(repository.has('auth-state-clear')).resolves.toBe(false)
    await expect(
      prisma.waAccount.findUnique({ where: { instanceId: 'auth-state-clear' } }),
    ).resolves.toMatchObject({ instanceId: 'auth-state-clear' })
  })

  it('never falls back to plaintext writes when encryption is not configured', async () => {
    await createWaAccount('auth-state-no-key')
    const repositoryWithoutKey = new PrismaWaAuthStateRepository(
      prisma,
      resolveWaAuthStateEncryptionConfig(undefined, 'mock'),
    )

    await expect(
      repositoryWithoutKey.write('auth-state-no-key', { token: 'secret' }),
    ).rejects.toBeInstanceOf(WaAuthStateEncryptionConfigurationError)
    await expect(
      prisma.waAuthState.findUnique({ where: { instanceId: 'auth-state-no-key' } }),
    ).resolves.toBeNull()
  })
})

describe('resolveWaAuthStateEncryptionConfig', () => {
  it('requires encryption for the real Baileys runtime', () => {
    expect(() => resolveWaAuthStateEncryptionConfig(undefined, 'baileys')).toThrow(
      WaAuthStateEncryptionConfigurationError,
    )
  })

  it.each(['not-base64', Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64')])(
    'rejects a malformed AES-256 key without echoing it: %s',
    (value) => {
      const error = (() => {
        try {
          resolveWaAuthStateEncryptionConfig(value, 'mock')
        } catch (caught) {
          return caught
        }
      })()

      expect(error).toBeInstanceOf(WaAuthStateEncryptionConfigurationError)
      expect(String(error)).not.toContain(value)
    },
  )
})

async function createWaAccount(instanceId: string): Promise<void> {
  await prisma.waAccount.create({
    data: {
      teamId,
      instanceId,
    },
  })
}

async function cleanup(): Promise<void> {
  await prisma.team.deleteMany({ where: { id: teamId } })
}

function createRepository(encodedKey: string): PrismaWaAuthStateRepository {
  return new PrismaWaAuthStateRepository(
    prisma,
    resolveWaAuthStateEncryptionConfig(encodedKey, 'mock'),
  )
}
