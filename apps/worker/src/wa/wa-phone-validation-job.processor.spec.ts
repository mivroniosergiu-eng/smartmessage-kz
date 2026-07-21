import 'reflect-metadata'

import {
  VALIDATE_WA_PHONE_JOB_NAME,
  WA_PHONE_VALIDATION_QUEUE_NAME,
  createWaPhoneValidationOwnerQueueName,
} from '@smartmessage/queue'
import { describe, expect, it, vi } from 'vitest'

import {
  WaPhoneValidationJobProcessor,
  WaPhoneValidationOwnerUnavailableError,
  WaPhoneValidationTimeoutError,
} from './wa-phone-validation-job.processor'

describe('WaPhoneValidationJobProcessor', () => {
  it('skips external work for a terminal contact', async () => {
    const fixture = createProcessor()
    fixture.repository.prepare.mockResolvedValue({
      contactId: 'contact-1',
      teamId: 'team-1',
      phone: '+77001234567',
      validationRunId: 'validation-job-1@1000',
      terminalStatus: 'confirmed',
    })

    await expect(fixture.processor.process(genericJob())).resolves.toEqual({
      contactId: 'contact-1',
      status: 'confirmed',
      terminalSkipped: true,
    })
    expect(fixture.selector.select).not.toHaveBeenCalled()
    expect(fixture.queueService.enqueueForOwner).not.toHaveBeenCalled()
  })

  it('routes to the selected exact owner and persists its terminal result', async () => {
    const fixture = createProcessor()
    fixture.repository.prepare.mockResolvedValue({
      contactId: 'contact-1',
      teamId: 'team-1',
      phone: '+77001234567',
      validationRunId: 'validation-job-1@1000',
    })
    fixture.selector.select.mockResolvedValue({
      instanceId: 'instance-1',
      ownership: { owner: 'worker-1', epoch: 4n },
    })
    fixture.queueService.enqueueForOwner.mockResolvedValue({
      contactId: 'contact-1',
      instanceId: 'instance-1',
      phone: '+77001234567',
      validationRunId: 'validation-job-1@1000',
      status: 'not_on_whatsapp',
    })

    await expect(fixture.processor.process(genericJob())).resolves.toEqual({
      contactId: 'contact-1',
      instanceId: 'instance-1',
      phone: '+77001234567',
      status: 'not_on_whatsapp',
    })
    expect(fixture.queueService.enqueueForOwner).toHaveBeenCalledWith({
      contactId: 'contact-1',
      teamId: 'team-1',
      validationRunId: 'validation-job-1@1000',
      instanceId: 'instance-1',
      phone: '+77001234567',
      expectedOwnerWorkerId: 'worker-1',
      expectedOwnerEpoch: '4',
    })
    expect(fixture.repository.complete).toHaveBeenCalledWith(
      'contact-1',
      'team-1',
      '+77001234567',
      'validation-job-1@1000',
      'not_on_whatsapp',
    )
  })

  it('marks the contact error only after the final retry is exhausted', async () => {
    const fixture = createProcessor()
    fixture.repository.prepare.mockResolvedValue({
      contactId: 'contact-1',
      teamId: 'team-1',
      phone: '+77001234567',
      validationRunId: 'validation-job-1@1000',
    })
    fixture.selector.select.mockRejectedValue(new Error('temporarily unavailable'))

    await expect(fixture.processor.process(genericJob({ attemptsMade: 6 }))).rejects.toThrow(
      'temporarily unavailable',
    )
    expect(fixture.repository.markError).not.toHaveBeenCalled()

    await expect(fixture.processor.process(genericJob({ attemptsMade: 7 }))).rejects.toThrow(
      'temporarily unavailable',
    )
    expect(fixture.repository.markError).toHaveBeenCalledWith(
      'contact-1',
      'team-1',
      '+77001234567',
      'validation-job-1@1000',
    )
  })

  it('validates on the exact live owner and rejects a stale generation without a side effect', async () => {
    const fixture = createProcessor()
    fixture.ownerRegistry.getOwnership
      .mockResolvedValueOnce({ owner: 'worker-1', epoch: 5n })
      .mockResolvedValueOnce({ owner: 'worker-1', epoch: 5n })
    fixture.validator.validate.mockResolvedValue({
      instanceId: 'instance-1',
      phone: '+77001234567',
      status: 'confirmed',
    })
    const ownerJob = directedJob('5')

    await expect(fixture.processor.process(ownerJob)).resolves.toEqual({
      contactId: 'contact-1',
      instanceId: 'instance-1',
      phone: '+77001234567',
      validationRunId: 'validation-job-1@1000',
      status: 'confirmed',
    })
    expect(fixture.repository.assertOwnerTarget).toHaveBeenCalledTimes(2)
    expect(fixture.validator.validate).toHaveBeenCalledWith({
      instanceId: 'instance-1',
      phone: '+77001234567',
    })

    fixture.ownerRegistry.getOwnership.mockResolvedValueOnce({ owner: 'worker-1', epoch: 6n })
    await expect(fixture.processor.process(ownerJob)).resolves.toEqual({
      contactId: 'contact-1',
      instanceId: 'instance-1',
      phone: '+77001234567',
      validationRunId: 'validation-job-1@1000',
      ownershipStale: true,
    })
    expect(fixture.validator.validate).toHaveBeenCalledOnce()
  })

  it('retries when the directed owner reports stale ownership', async () => {
    const fixture = createProcessor()
    fixture.repository.prepare.mockResolvedValue({
      contactId: 'contact-1',
      teamId: 'team-1',
      phone: '+77001234567',
      validationRunId: 'validation-job-1@1000',
    })
    fixture.selector.select.mockResolvedValue({
      instanceId: 'instance-1',
      ownership: { owner: 'worker-1', epoch: 5n },
    })
    fixture.queueService.enqueueForOwner.mockResolvedValue({
      contactId: 'contact-1',
      instanceId: 'instance-1',
      phone: '+77001234567',
      validationRunId: 'validation-job-1@1000',
      ownershipStale: true,
    })

    await expect(fixture.processor.process(genericJob())).rejects.toBeInstanceOf(
      WaPhoneValidationOwnerUnavailableError,
    )
    expect(fixture.repository.complete).not.toHaveBeenCalled()
  })

  it('bounds a hanging onWhatsApp call so BullMQ can retry it', async () => {
    vi.useFakeTimers()
    try {
      const fixture = createProcessor()
      fixture.ownerRegistry.getOwnership.mockResolvedValue({ owner: 'worker-1', epoch: 5n })
      fixture.validator.validate.mockReturnValue(new Promise(() => undefined))

      const validation = fixture.processor.process(directedJob('5'))
      const rejected = expect(validation).rejects.toBeInstanceOf(WaPhoneValidationTimeoutError)
      await vi.advanceTimersByTimeAsync(10_000)

      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it('discards the transport result when ownership changes during onWhatsApp', async () => {
    const fixture = createProcessor()
    fixture.ownerRegistry.getOwnership
      .mockResolvedValueOnce({ owner: 'worker-1', epoch: 5n })
      .mockResolvedValueOnce({ owner: 'worker-2', epoch: 6n })
    fixture.validator.validate.mockResolvedValue({
      instanceId: 'instance-1',
      phone: '+77001234567',
      status: 'confirmed',
    })

    await expect(fixture.processor.process(directedJob('5'))).resolves.toMatchObject({
      ownershipStale: true,
      phone: '+77001234567',
      validationRunId: 'validation-job-1@1000',
    })
    expect(fixture.repository.assertOwnerTarget).toHaveBeenCalledOnce()
  })

  it('reconciles a BullMQ terminal or stalled failure against the exact persisted run', async () => {
    const fixture = createProcessor()

    const finalJob = { ...genericJob({ attemptsMade: 8 }), attemptsMade: 8, remove: vi.fn() }
    await fixture.processor.handleFailed(finalJob, new Error('attempts exhausted'))
    await fixture.processor.handleFailed(genericJob({ attemptsMade: 1 }), new Error('job stalled'))
    await fixture.processor.handleFailed(
      genericJob({ attemptsMade: 7 }),
      new Error('retry remains'),
    )

    expect(fixture.repository.markRunError).toHaveBeenCalledTimes(2)
    expect(fixture.repository.markRunError).toHaveBeenCalledWith(
      'contact-1',
      'team-1',
      'validation-job-1@1000',
    )
    expect(finalJob.remove).toHaveBeenCalledOnce()
  })
})

function createProcessor() {
  const repository = {
    prepare: vi.fn(),
    complete: vi.fn(),
    markError: vi.fn(),
    markRunError: vi.fn(),
    assertOwnerTarget: vi.fn(),
  }
  const selector = { select: vi.fn() }
  const queueService = { enqueueForOwner: vi.fn() }
  const validator = { validate: vi.fn() }
  const ownerRegistry = { getOwnership: vi.fn() }
  return {
    repository,
    selector,
    queueService,
    validator,
    ownerRegistry,
    processor: new WaPhoneValidationJobProcessor(
      repository as never,
      selector as never,
      queueService as never,
      validator,
      ownerRegistry,
      'worker-1',
    ),
  }
}

function genericJob(overrides: { attemptsMade?: number } = {}) {
  return {
    name: VALIDATE_WA_PHONE_JOB_NAME,
    queueName: WA_PHONE_VALIDATION_QUEUE_NAME,
    data: { contactId: 'contact-1', teamId: 'team-1' },
    id: 'validation-job-1',
    timestamp: 1000,
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: 8 },
  }
}

function directedJob(epoch: string) {
  return {
    name: VALIDATE_WA_PHONE_JOB_NAME,
    queueName: createWaPhoneValidationOwnerQueueName('worker-1'),
    data: {
      contactId: 'contact-1',
      teamId: 'team-1',
      instanceId: 'instance-1',
      validationRunId: 'validation-job-1@1000',
      phone: '+77001234567',
      expectedOwnerWorkerId: 'worker-1',
      expectedOwnerEpoch: epoch,
    },
  }
}
