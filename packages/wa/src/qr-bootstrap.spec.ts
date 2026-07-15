import { describe, expect, it } from 'vitest'

import {
  InMemoryWaQrBootstrapRepository,
  WaQrCode,
  createWaQrPendingEvent,
  resolveWaQrBootstrapState,
} from './qr-bootstrap'

describe('WaQrCode', () => {
  it('normalizes QR payload and exposes expiry semantics', () => {
    const createdAt = new Date('2026-07-03T10:00:00.000Z')
    const expiresAt = new Date('2026-07-03T10:01:00.000Z')
    const qrCode = WaQrCode.create({
      value: '  qr-payload  ',
      createdAt,
      expiresAt,
    })

    expect(qrCode.value).toBe('qr-payload')
    expect(qrCode.createdAt).toEqual(createdAt)
    expect(qrCode.expiresAt).toEqual(expiresAt)
    expect(qrCode.isExpiredAt(new Date('2026-07-03T10:00:59.999Z'))).toBe(false)
    expect(qrCode.isExpiredAt(expiresAt)).toBe(true)
  })

  it('rejects empty payload and non-future expiry', () => {
    const createdAt = new Date('2026-07-03T10:00:00.000Z')

    expect(() =>
      WaQrCode.create({
        value: '   ',
        createdAt,
        expiresAt: new Date('2026-07-03T10:01:00.000Z'),
      }),
    ).toThrow('QR code value must be a non-empty string')
    expect(() =>
      WaQrCode.create({
        value: 'qr-payload',
        createdAt,
        expiresAt: createdAt,
      }),
    ).toThrow('QR code expiresAt must be after createdAt')
  })
})

describe('WA QR bootstrap contract', () => {
  it('models the connecting to qr_pending flow without sockets', () => {
    const event = createWaQrPendingEvent({
      instanceId: ' instance-1 ',
      qrCode: ' qr-payload ',
      createdAt: new Date('2026-07-03T10:00:00.000Z'),
      expiresAt: new Date('2026-07-03T10:01:00.000Z'),
    })

    expect(event).toEqual({
      type: 'qr_pending',
      instanceId: 'instance-1',
      qrCode: 'qr-payload',
      createdAt: new Date('2026-07-03T10:00:00.000Z'),
      expiresAt: new Date('2026-07-03T10:01:00.000Z'),
    })
    expect(
      resolveWaQrBootstrapState({
        instanceId: 'instance-1',
        accountStatus: 'connecting',
        qrEvent: event,
        now: new Date('2026-07-03T10:00:30.000Z'),
      }),
    ).toEqual({
      instanceId: 'instance-1',
      status: 'qr_pending',
      qrCode: 'qr-payload',
      expiresAt: '2026-07-03T10:01:00.000Z',
    })
  })

  it('falls back to account status when QR is missing or expired', () => {
    const expiredEvent = createWaQrPendingEvent({
      instanceId: 'instance-1',
      qrCode: 'qr-payload',
      createdAt: new Date('2026-07-03T10:00:00.000Z'),
      expiresAt: new Date('2026-07-03T10:01:00.000Z'),
    })

    expect(
      resolveWaQrBootstrapState({
        instanceId: 'instance-1',
        accountStatus: 'connecting',
        now: new Date('2026-07-03T10:00:30.000Z'),
      }),
    ).toEqual({ instanceId: 'instance-1', status: 'connecting' })
    expect(
      resolveWaQrBootstrapState({
        instanceId: 'instance-1',
        accountStatus: 'connected',
        qrEvent: expiredEvent,
        now: new Date('2026-07-03T10:01:00.000Z'),
      }),
    ).toEqual({ instanceId: 'instance-1', status: 'connected' })
  })

  it('never lets an unexpired stale QR override a settled account status', () => {
    const staleEvent = createWaQrPendingEvent({
      instanceId: 'instance-1',
      qrCode: 'stale-qr',
      createdAt: new Date('2026-07-03T10:00:00.000Z'),
      expiresAt: new Date('2026-07-03T10:01:00.000Z'),
    })

    expect(
      resolveWaQrBootstrapState({
        instanceId: 'instance-1',
        accountStatus: 'connected',
        qrEvent: staleEvent,
        now: new Date('2026-07-03T10:00:30.000Z'),
      }),
    ).toEqual({ instanceId: 'instance-1', status: 'connected' })
  })

  it.each(['restricted', 'banned'] as const)(
    'preserves terminal and limited account status %s',
    (accountStatus) => {
      expect(
        resolveWaQrBootstrapState({
          instanceId: 'instance-1',
          accountStatus,
          now: new Date('2026-07-03T10:00:30.000Z'),
        }),
      ).toEqual({ instanceId: 'instance-1', status: accountStatus })
    },
  )
})

describe('InMemoryWaQrBootstrapRepository', () => {
  it('stores, reads as clones, and clears the latest QR event per instance', async () => {
    const repository = new InMemoryWaQrBootstrapRepository()
    const event = createWaQrPendingEvent({
      instanceId: 'instance-1',
      qrCode: 'qr-payload',
      createdAt: new Date('2026-07-03T10:00:00.000Z'),
      expiresAt: new Date('2026-07-03T10:01:00.000Z'),
    })

    await repository.activateOwnership('instance-1', 'worker-a', 1n)
    await repository.store(event, 'worker-a', 1n)
    const stored = await repository.getLatest('instance-1')
    expect(stored).toEqual(event)
    expect(stored).not.toBe(event)

    await repository.clear('instance-1', 'worker-a', 1n)
    await expect(repository.getLatest('instance-1')).resolves.toBeNull()
  })

  it('does not let a stale owner store or clear after a newer epoch wins', async () => {
    const repository = new InMemoryWaQrBootstrapRepository()
    const oldEvent = createWaQrPendingEvent({
      instanceId: 'instance-fenced',
      qrCode: 'old-qr',
      expiresAt: new Date('2999-01-01T00:01:00.000Z'),
    })
    const newEvent = createWaQrPendingEvent({
      instanceId: 'instance-fenced',
      qrCode: 'new-qr',
      expiresAt: new Date('2999-01-01T00:01:00.000Z'),
    })
    await repository.activateOwnership('instance-fenced', 'worker-a', 1n)
    await repository.activateOwnership('instance-fenced', 'worker-b', 2n)
    await repository.store(newEvent, 'worker-b', 2n)

    await expect(repository.store(oldEvent, 'worker-a', 1n)).resolves.toBe(false)
    await expect(repository.clear('instance-fenced', 'worker-a', 1n)).resolves.toBe(false)
    await expect(repository.getLatest('instance-fenced')).resolves.toMatchObject({
      qrCode: 'new-qr',
    })
  })
})
