import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { PrismaClient } from '@smartmessage/db'
import { createWaQrPendingEvent } from '@smartmessage/wa'

import {
  PrismaWaQrBootstrapRepository,
  WaQrBootstrapAccountNotFoundError,
} from './prisma-wa-qr-bootstrap.repository'

const prisma = new PrismaClient()
const teamId = 'wa-qr-bootstrap-team'

describe('PrismaWaQrBootstrapRepository', () => {
  const repository = new PrismaWaQrBootstrapRepository(prisma)

  beforeEach(async () => {
    await cleanup()
    await prisma.team.create({
      data: { id: teamId, name: 'WA QR Bootstrap Team' },
    })
  })

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  it('stores and reads the latest QR bootstrap event for an existing WaAccount', async () => {
    await createWaAccount('qr-bootstrap-instance')
    const event = createWaQrPendingEvent({
      instanceId: 'qr-bootstrap-instance',
      qrCode: 'qr-payload',
      createdAt: new Date('2026-07-06T09:00:00.000Z'),
      expiresAt: new Date('2026-07-06T09:01:00.000Z'),
    })
    await repository.activateOwnership('qr-bootstrap-instance', 'worker-a', 1n)

    await repository.store(event, 'worker-a', 1n)

    await expect(repository.getLatest(' qr-bootstrap-instance ')).resolves.toEqual(event)
  })

  it('updates the latest QR bootstrap event for the same instanceId', async () => {
    await createWaAccount('qr-bootstrap-update-instance')
    await repository.activateOwnership('qr-bootstrap-update-instance', 'worker-a', 1n)
    await repository.store(
      createWaQrPendingEvent({
        instanceId: 'qr-bootstrap-update-instance',
        qrCode: 'first-qr-payload',
        createdAt: new Date('2026-07-06T09:00:00.000Z'),
        expiresAt: new Date('2026-07-06T09:01:00.000Z'),
      }),
      'worker-a',
      1n,
    )
    const latest = createWaQrPendingEvent({
      instanceId: 'qr-bootstrap-update-instance',
      qrCode: 'second-qr-payload',
      createdAt: new Date('2026-07-06T09:02:00.000Z'),
      expiresAt: new Date('2026-07-06T09:03:00.000Z'),
    })

    await repository.store(latest, 'worker-a', 1n)

    await expect(repository.getLatest('qr-bootstrap-update-instance')).resolves.toEqual(latest)
    await expect(
      prisma.waQrBootstrapEvent.findMany({ where: { instanceId: 'qr-bootstrap-update-instance' } }),
    ).resolves.toHaveLength(1)
  })

  it('clears a QR bootstrap event without mutating the WaAccount', async () => {
    await createWaAccount('qr-bootstrap-clear-instance')
    await repository.activateOwnership('qr-bootstrap-clear-instance', 'worker-a', 1n)
    await repository.store(
      createWaQrPendingEvent({
        instanceId: 'qr-bootstrap-clear-instance',
        qrCode: 'qr-payload',
        createdAt: new Date('2026-07-06T09:00:00.000Z'),
        expiresAt: new Date('2026-07-06T09:01:00.000Z'),
      }),
      'worker-a',
      1n,
    )

    await repository.clear(' qr-bootstrap-clear-instance ', 'worker-a', 1n)

    await expect(repository.getLatest('qr-bootstrap-clear-instance')).resolves.toBeNull()
    await expect(
      prisma.waAccount.findUnique({ where: { instanceId: 'qr-bootstrap-clear-instance' } }),
    ).resolves.toMatchObject({ instanceId: 'qr-bootstrap-clear-instance' })
  })

  it('maps missing WaAccount on store to an explicit domain error and does not create one', async () => {
    await expect(
      repository.store(
        createWaQrPendingEvent({
          instanceId: 'missing-qr-bootstrap-instance',
          qrCode: 'qr-payload',
          createdAt: new Date('2026-07-06T09:00:00.000Z'),
          expiresAt: new Date('2026-07-06T09:01:00.000Z'),
        }),
        'worker-a',
        1n,
      ),
    ).rejects.toBeInstanceOf(WaQrBootstrapAccountNotFoundError)

    await expect(
      prisma.waAccount.findMany({ where: { instanceId: 'missing-qr-bootstrap-instance' } }),
    ).resolves.toHaveLength(0)
    await expect(
      prisma.waQrBootstrapEvent.findMany({
        where: { instanceId: 'missing-qr-bootstrap-instance' },
      }),
    ).resolves.toHaveLength(0)
  })

  it('keeps the newer QR when a stale epoch attempts store and clear', async () => {
    await createWaAccount('qr-bootstrap-fenced')
    await repository.activateOwnership('qr-bootstrap-fenced', 'worker-old', 1n)
    await repository.activateOwnership('qr-bootstrap-fenced', 'worker-new', 2n)
    const fresh = createWaQrPendingEvent({
      instanceId: 'qr-bootstrap-fenced',
      qrCode: 'fresh-qr',
      expiresAt: new Date('2999-07-15T12:00:00.000Z'),
    })
    const stale = createWaQrPendingEvent({
      instanceId: 'qr-bootstrap-fenced',
      qrCode: 'stale-qr',
      expiresAt: new Date('2999-07-15T12:00:00.000Z'),
    })
    await repository.store(fresh, 'worker-new', 2n)

    await expect(repository.store(stale, 'worker-old', 1n)).resolves.toBe(false)
    await expect(repository.clear('qr-bootstrap-fenced', 'worker-old', 1n)).resolves.toBe(false)
    await expect(repository.getLatest('qr-bootstrap-fenced')).resolves.toMatchObject({
      qrCode: 'fresh-qr',
    })
  })
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
