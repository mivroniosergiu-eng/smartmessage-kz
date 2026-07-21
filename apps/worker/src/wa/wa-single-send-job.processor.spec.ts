import {
  SEND_WA_TEXT_JOB_NAME,
  WA_SINGLE_SEND_QUEUE_NAME,
  createWaSingleSendOwnerQueueName,
} from '@smartmessage/queue'
import { describe, expect, it, vi } from 'vitest'

import {
  WaSingleSendAcceptedPersistenceError,
  WaSingleSendJobProcessor,
} from './wa-single-send-job.processor'

describe('WaSingleSendJobProcessor', () => {
  it('routes a queued log to its exact live owner and persists SENT', async () => {
    const repository = createRepository()
    const queue = {
      enqueueForOwner: vi.fn(async () => ({
        messageLogId: 'log-1',
        status: 'sent',
        providerMessageId: 'wa-1',
      })),
    }
    const processor = new WaSingleSendJobProcessor(
      repository as never,
      queue as never,
      { send: vi.fn() },
      { getOwnership: vi.fn(async () => ({ owner: 'worker-1', epoch: 3n })) },
      { handleDisconnect: vi.fn() },
      'worker-1',
    )

    await expect(processor.process(genericJob())).resolves.toEqual({
      messageLogId: 'log-1',
      status: 'sent',
      providerMessageId: 'wa-1',
    })
    expect(queue.enqueueForOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        messageLogId: 'log-1',
        teamId: 'team-1',
        phone: '+77001234567',
        expectedOwnerWorkerId: 'worker-1',
        expectedOwnerEpoch: '3',
      }),
    )
    expect(repository.markSent).not.toHaveBeenCalled()
  })

  it('does not route or send an already terminal idempotency key', async () => {
    const repository = createRepository()
    repository.prepare.mockResolvedValueOnce({
      ...(await repository.prepare()),
      terminalStatus: 'sent',
      providerMessageId: 'wa-existing',
    })
    const queue = { enqueueForOwner: vi.fn() }
    const processor = new WaSingleSendJobProcessor(
      repository as never,
      queue as never,
      { send: vi.fn() },
      { getOwnership: vi.fn() },
      { handleDisconnect: vi.fn() },
      'worker-1',
    )

    await expect(processor.process(genericJob())).resolves.toMatchObject({
      messageLogId: 'log-1',
      status: 'sent',
      terminalSkipped: true,
    })
    expect(queue.enqueueForOwner).not.toHaveBeenCalled()
  })

  it('owner worker fences ownership before one active-socket send and accepts its result', async () => {
    const repository = createRepository()
    const sender = { send: vi.fn(async () => ({ messageId: 'wa-1', status: 'accepted' as const })) }
    const registry = { getOwnership: vi.fn(async () => ({ owner: 'worker-1', epoch: 3n })) }
    const processor = new WaSingleSendJobProcessor(
      repository as never,
      { enqueueForOwner: vi.fn() } as never,
      sender,
      registry,
      { handleDisconnect: vi.fn() },
      'worker-1',
    )

    await expect(
      processor.process({
        name: SEND_WA_TEXT_JOB_NAME,
        queueName: createWaSingleSendOwnerQueueName('worker-1'),
        data: ownerPayload(),
      }),
    ).resolves.toEqual({ messageLogId: 'log-1', status: 'sent', providerMessageId: 'wa-1' })
    expect(repository.assertOwnerTarget).toHaveBeenCalledOnce()
    expect(repository.claimDispatch).toHaveBeenCalledWith('log-1')
    expect(repository.markSent).toHaveBeenCalledWith('log-1', 'wa-1')
    expect(registry.getOwnership).toHaveBeenCalledOnce()
    expect(sender.send).toHaveBeenCalledWith({
      instanceId: 'instance-1',
      recipientPhone: '+77001234567',
      kind: 'text',
      text: 'hello',
      idempotencyKey: 'request-1',
    })
  })

  it('does not send after a crash left a durable pre-provider dispatch fence', async () => {
    const repository = createRepository()
    repository.claimDispatch.mockResolvedValueOnce(false)
    const sender = { send: vi.fn() }
    const processor = new WaSingleSendJobProcessor(
      repository as never,
      { enqueueForOwner: vi.fn() } as never,
      sender,
      { getOwnership: vi.fn(async () => ({ owner: 'worker-1', epoch: 3n })) },
      { handleDisconnect: vi.fn() },
      'worker-1',
    )

    await expect(
      processor.process({
        name: SEND_WA_TEXT_JOB_NAME,
        queueName: createWaSingleSendOwnerQueueName('worker-1'),
        data: ownerPayload(),
      }),
    ).resolves.toEqual({ messageLogId: 'log-1', status: 'delivery_ambiguous' })
    expect(sender.send).not.toHaveBeenCalled()
    expect(repository.markSent).not.toHaveBeenCalled()
  })

  it('does not route again after provider ack when owner-side SENT persistence crashed', async () => {
    const repository = createRepository()
    repository.prepare.mockResolvedValueOnce({
      ...(await repository.prepare()),
      deliveryAmbiguous: true,
    })
    const queue = { enqueueForOwner: vi.fn() }
    const processor = new WaSingleSendJobProcessor(
      repository as never,
      queue as never,
      { send: vi.fn() },
      { getOwnership: vi.fn() },
      { handleDisconnect: vi.fn() },
      'worker-1',
    )

    await expect(processor.process(genericJob())).resolves.toEqual({
      messageLogId: 'log-1',
      status: 'delivery_ambiguous',
      terminalSkipped: true,
    })
    expect(queue.enqueueForOwner).not.toHaveBeenCalled()
  })

  it('reconciles a final or stalled BullMQ failure to FAILED without a send', async () => {
    const repository = createRepository()
    const sender = { send: vi.fn() }
    const processor = new WaSingleSendJobProcessor(
      repository as never,
      { enqueueForOwner: vi.fn() } as never,
      sender,
      { getOwnership: vi.fn() },
      { handleDisconnect: vi.fn() },
      'worker-1',
    )
    const finalJob = { ...genericJob(), attemptsMade: 4, opts: { attempts: 5 }, remove: vi.fn() }
    await processor.handleFailed(finalJob, new Error('terminal failure'))
    await processor.handleFailed(
      { ...genericJob(), attemptsMade: 0, opts: { attempts: 5 } },
      new Error('job stalled more than allowable limit'),
    )
    expect(repository.markRequestFailed).toHaveBeenCalledTimes(2)
    expect(finalJob.remove).toHaveBeenCalledOnce()
    expect(repository.markRequestFailed).toHaveBeenLastCalledWith(genericJob().data)
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('never downgrades or re-sends when owner-side SENT persistence fails after provider ack', async () => {
    const repository = createRepository()
    repository.markSent.mockRejectedValueOnce(new Error('database unavailable'))
    const sender = { send: vi.fn(async () => ({ messageId: 'wa-1', status: 'accepted' as const })) }
    const processor = new WaSingleSendJobProcessor(
      repository as never,
      { enqueueForOwner: vi.fn() } as never,
      sender,
      { getOwnership: vi.fn(async () => ({ owner: 'worker-1', epoch: 3n })) },
      { handleDisconnect: vi.fn() },
      'worker-1',
    )

    await expect(
      processor.process({
        name: SEND_WA_TEXT_JOB_NAME,
        queueName: createWaSingleSendOwnerQueueName('worker-1'),
        data: ownerPayload(),
      }),
    ).rejects.toBeInstanceOf(WaSingleSendAcceptedPersistenceError)
    expect(sender.send).toHaveBeenCalledOnce()
    expect(repository.claimDispatch).toHaveBeenCalledOnce()
    expect(repository.markFailed).not.toHaveBeenCalled()

    const failedJob = { ...genericJob(), attemptsMade: 5, remove: vi.fn() }
    await processor.handleFailed(
      failedJob,
      new WaSingleSendAcceptedPersistenceError('log-1', new Error('database unavailable')),
    )
    expect(repository.markRequestFailed).not.toHaveBeenCalled()
    expect(failedJob.remove).not.toHaveBeenCalled()
  })

  it('keeps delivery ambiguous when owner acknowledgement times out after dispatch', async () => {
    const repository = createRepository()
    const ownerAcknowledgementTimeout = new Error('WA single-send owner acknowledgement timed out')
    const processor = new WaSingleSendJobProcessor(
      repository as never,
      {
        enqueueForOwner: vi.fn(async () => Promise.reject(ownerAcknowledgementTimeout)),
      } as never,
      { send: vi.fn() },
      { getOwnership: vi.fn(async () => ({ owner: 'worker-1', epoch: 3n })) },
      { handleDisconnect: vi.fn() },
      'worker-1',
    )
    const finalJob = { ...genericJob(), attemptsMade: 4, remove: vi.fn() }

    await expect(processor.process(finalJob)).rejects.toBe(ownerAcknowledgementTimeout)
    expect(repository.markFailed).not.toHaveBeenCalled()

    await processor.handleFailed(finalJob, ownerAcknowledgementTimeout)
    expect(repository.markRequestFailed).not.toHaveBeenCalled()
    expect(finalJob.remove).not.toHaveBeenCalled()
  })

  it('classifies a banned send as terminal and transitions the owned session', async () => {
    const repository = createRepository()
    const sessionManager = { handleDisconnect: vi.fn(async () => undefined) }
    const processor = new WaSingleSendJobProcessor(
      repository as never,
      { enqueueForOwner: vi.fn() } as never,
      { send: vi.fn(async () => Promise.reject(new Error('account permanently banned'))) },
      { getOwnership: vi.fn(async () => ({ owner: 'worker-1', epoch: 3n })) },
      sessionManager as never,
      'worker-1',
    )

    await expect(
      processor.process({
        name: SEND_WA_TEXT_JOB_NAME,
        queueName: createWaSingleSendOwnerQueueName('worker-1'),
        data: ownerPayload(),
      }),
    ).rejects.toThrow('dispatch is ambiguous and requires reconciliation')
    expect(sessionManager.handleDisconnect).toHaveBeenCalledWith('instance-1', 'banned')
  })

  it('keeps a retained ambiguous failed job QUEUED during durable reconciliation', async () => {
    const repository = createRepository()
    const processor = new WaSingleSendJobProcessor(
      repository as never,
      { enqueueForOwner: vi.fn() } as never,
      { send: vi.fn() },
      { getOwnership: vi.fn() },
      { handleDisconnect: vi.fn() },
      'worker-1',
    )
    const remove = vi.fn()

    await processor.reconcileFailed({
      ...genericJob(),
      failedReason: 'WA single-send dispatch is ambiguous and requires reconciliation: log-1',
      remove,
    })

    expect(repository.markRequestFailed).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('discards generic retries and marks FAILED for a terminal classified error', async () => {
    const repository = createRepository()
    const discard = vi.fn()
    const processor = new WaSingleSendJobProcessor(
      repository as never,
      {
        enqueueForOwner: vi.fn(async () => Promise.reject(new Error('account permanently banned'))),
      } as never,
      { send: vi.fn() },
      { getOwnership: vi.fn(async () => ({ owner: 'worker-1', epoch: 3n })) },
      { handleDisconnect: vi.fn() },
      'worker-1',
    )

    await expect(processor.process({ ...genericJob(), discard })).rejects.toThrow(
      'account permanently banned',
    )
    expect(discard).toHaveBeenCalledOnce()
    expect(repository.markFailed).toHaveBeenCalledWith('log-1')
  })
})

function createRepository() {
  return {
    prepare: vi.fn(async () => ({
      messageLogId: 'log-1',
      teamId: 'team-1',
      instanceId: 'instance-1',
      contactId: 'contact-1',
      phone: '+77001234567',
      text: 'hello',
      idempotencyKey: 'request-1',
      ownerWorkerId: 'worker-1',
      ownershipEpoch: 3n,
    })),
    assertOwnerTarget: vi.fn(async () => undefined),
    claimDispatch: vi.fn(async () => true),
    markSent: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    markRequestFailed: vi.fn(async () => undefined),
  }
}
function genericJob() {
  return {
    name: SEND_WA_TEXT_JOB_NAME,
    queueName: WA_SINGLE_SEND_QUEUE_NAME,
    data: {
      instanceId: 'instance-1',
      contactId: 'contact-1',
      text: 'hello',
      idempotencyKey: 'request-1',
    },
    attemptsMade: 0,
    opts: { attempts: 5 },
  }
}
function ownerPayload() {
  return {
    ...genericJob().data,
    messageLogId: 'log-1',
    teamId: 'team-1',
    phone: '+77001234567',
    expectedOwnerWorkerId: 'worker-1',
    expectedOwnerEpoch: '3',
  }
}
