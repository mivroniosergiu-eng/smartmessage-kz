import { BadRequestException, ConflictException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'

import {
  WaSingleSendContactNotConfirmedError,
  WaSingleSendIdempotencyConflictError,
} from './prisma-wa-single-send.repository'
import { WaOperationsController } from './wa-operations.controller'

describe('WaOperationsController', () => {
  it('derives validation team server-side and never accepts it from the body', async () => {
    const phoneRepository = { getTeamId: vi.fn(async () => 'team-db') }
    const phoneQueue = { enqueue: vi.fn(async () => undefined) }
    const controller = createController(phoneRepository, phoneQueue)

    await expect(controller.validatePhone({ contactId: ' contact-1 ' })).resolves.toEqual({
      contactId: 'contact-1',
      queued: true,
    })
    expect(phoneQueue.enqueue).toHaveBeenCalledWith('contact-1', 'team-db')
  })

  it('checks account/contact tenancy before enqueueing single send', async () => {
    const sendRepository = { assertRequestTarget: vi.fn(async () => undefined) }
    const sendQueue = { enqueue: vi.fn(async () => undefined) }
    const controller = createController(undefined, undefined, sendRepository, sendQueue)

    await expect(
      controller.sendText(' instance-1 ', {
        contactId: ' contact-1 ',
        text: ' hello ',
        idempotencyKey: ' request-1 ',
        teamId: 'forged',
      }),
    ).resolves.toEqual({ instanceId: 'instance-1', command: 'send-text', queued: true })
    expect(sendRepository.assertRequestTarget).toHaveBeenCalledWith({
      instanceId: 'instance-1',
      contactId: 'contact-1',
      text: 'hello',
      idempotencyKey: 'request-1',
    })
    expect(sendQueue.enqueue).toHaveBeenCalledWith({
      instanceId: 'instance-1',
      contactId: 'contact-1',
      text: 'hello',
      idempotencyKey: 'request-1',
    })
  })

  it('rejects malformed text request before persistence or queue use', async () => {
    const sendRepository = { assertRequestTarget: vi.fn() }
    const sendQueue = { enqueue: vi.fn() }
    const controller = createController(undefined, undefined, sendRepository, sendQueue)
    await expect(
      controller.sendText('instance-1', {
        contactId: 'contact-1',
        text: ' ',
        idempotencyKey: 'request-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(sendRepository.assertRequestTarget).not.toHaveBeenCalled()
  })

  it('returns conflict without enqueueing when the idempotency key belongs to another payload', async () => {
    const sendRepository = {
      assertRequestTarget: vi.fn(async () => {
        throw new WaSingleSendIdempotencyConflictError('request-1')
      }),
    }
    const sendQueue = { enqueue: vi.fn() }
    const controller = createController(undefined, undefined, sendRepository, sendQueue)

    await expect(
      controller.sendText('instance-1', {
        contactId: 'contact-1',
        text: 'different',
        idempotencyKey: 'request-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(sendQueue.enqueue).not.toHaveBeenCalled()
  })

  it('returns conflict without enqueueing when the contact is not confirmed', async () => {
    const sendRepository = {
      assertRequestTarget: vi.fn(async () => {
        throw new WaSingleSendContactNotConfirmedError('contact-1')
      }),
    }
    const sendQueue = { enqueue: vi.fn() }
    const controller = createController(undefined, undefined, sendRepository, sendQueue)

    await expect(
      controller.sendText('instance-1', {
        contactId: 'contact-1',
        text: 'hello',
        idempotencyKey: 'request-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(sendQueue.enqueue).not.toHaveBeenCalled()
  })

  it.each([
    ['text', { contactId: 'contact-1', text: 'x'.repeat(4_001), idempotencyKey: 'request-1' }],
    ['idempotency key', { contactId: 'contact-1', text: 'hello', idempotencyKey: 'short' }],
    ['contact id', { contactId: 'x'.repeat(121), text: 'hello', idempotencyKey: 'request-1' }],
  ])('rejects an out-of-contract %s at the worker boundary', async (_name, body) => {
    const sendRepository = { assertRequestTarget: vi.fn() }
    const sendQueue = { enqueue: vi.fn() }
    const controller = createController(undefined, undefined, sendRepository, sendQueue)
    await expect(controller.sendText('instance-1', body)).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(sendRepository.assertRequestTarget).not.toHaveBeenCalled()
    expect(sendQueue.enqueue).not.toHaveBeenCalled()
  })
})

function createController(
  phoneRepository = { getTeamId: vi.fn(async () => 'team-1') },
  phoneQueue = { enqueue: vi.fn(async () => undefined) },
  sendRepository = { assertRequestTarget: vi.fn(async () => undefined) },
  sendQueue = { enqueue: vi.fn(async () => undefined) },
) {
  return new WaOperationsController(
    phoneRepository as never,
    phoneQueue as never,
    sendRepository as never,
    sendQueue as never,
  )
}
