import 'reflect-metadata'

import {
  RENEW_WA_INSTANCE_JOB_NAME,
  START_WA_INSTANCE_JOB_NAME,
  STOP_WA_INSTANCE_JOB_NAME,
  WA_LIFECYCLE_QUEUE_NAME,
  createWaLifecycleOwnerQueueName,
} from '@smartmessage/queue'
import { WaOwnershipError, type SessionState } from '@smartmessage/wa'
import { describe, expect, it, vi } from 'vitest'

import { WaLifecycleCommandService } from './wa-lifecycle-command.service'
import {
  WaLifecycleJobProcessor,
  WaLifecycleOwnerUnavailableError,
} from './wa-lifecycle-job.processor'

describe('WaLifecycleJobProcessor', () => {
  it('start job calls command service and returns status', async () => {
    const command = createCommandMock({
      startInstance: vi.fn(async () => createSessionState('instance-1', 'connected')),
    })
    const { processor } = createProcessor(command)

    await expect(
      processor.process({
        name: START_WA_INSTANCE_JOB_NAME,
        data: { instanceId: ' instance-1 ' },
      }),
    ).resolves.toEqual({ instanceId: 'instance-1', status: 'connected' })
    expect(command.startInstance).toHaveBeenCalledWith('instance-1')
  })

  it('stop job calls command service and returns stopped result', async () => {
    const command = createCommandMock({
      stopInstance: vi.fn(async () => true),
    })
    const { processor } = createProcessor(command)

    await expect(
      processor.process({
        name: STOP_WA_INSTANCE_JOB_NAME,
        data: {
          instanceId: ' instance-2 ',
          expectedOwnerWorkerId: 'worker-local',
          expectedOwnerEpoch: '1',
        },
        queueName: createWaLifecycleOwnerQueueName('worker-local'),
      }),
    ).resolves.toEqual({ instanceId: 'instance-2', stopped: true })
    expect(command.stopInstance).toHaveBeenCalledWith('instance-2')
    expect(command.startInstance).not.toHaveBeenCalled()
    expect(command.renewInstance).not.toHaveBeenCalled()
  })

  it('renew job calls command service and returns renewed result', async () => {
    const command = createCommandMock({
      renewInstance: vi.fn(async () => true),
    })
    const { processor } = createProcessor(command)

    await expect(
      processor.process({
        name: RENEW_WA_INSTANCE_JOB_NAME,
        data: {
          instanceId: ' instance-3 ',
          expectedOwnerWorkerId: 'worker-local',
          expectedOwnerEpoch: '1',
        },
        queueName: createWaLifecycleOwnerQueueName('worker-local'),
      }),
    ).resolves.toEqual({ instanceId: 'instance-3', renewed: true })
    expect(command.renewInstance).toHaveBeenCalledWith('instance-3')
    expect(command.startInstance).not.toHaveBeenCalled()
    expect(command.stopInstance).not.toHaveBeenCalled()
  })

  it('invalid payload rejects before command call', async () => {
    const command = createCommandMock()
    const { processor } = createProcessor(command)

    await expect(
      processor.process({
        name: STOP_WA_INSTANCE_JOB_NAME,
        data: { instanceId: '   ' },
      }),
    ).rejects.toThrow('stop-wa-instance payload.instanceId must be a non-empty string')
    expect(command.startInstance).not.toHaveBeenCalled()
    expect(command.stopInstance).not.toHaveBeenCalled()
    expect(command.renewInstance).not.toHaveBeenCalled()
  })

  it('unknown job rejects', async () => {
    const command = createCommandMock()
    const { processor } = createProcessor(command)

    await expect(
      processor.process({
        name: 'delete-wa-instance',
        data: { instanceId: 'instance-1' },
      }),
    ).rejects.toThrow('Unsupported WA lifecycle job: delete-wa-instance')
    expect(command.startInstance).not.toHaveBeenCalled()
    expect(command.stopInstance).not.toHaveBeenCalled()
    expect(command.renewInstance).not.toHaveBeenCalled()
  })

  it('ownership error propagates and rejects the job', async () => {
    const error = new WaOwnershipError('instance-2', 'worker-a', 'worker-b')
    const command = createCommandMock({
      startInstance: vi.fn(async () => Promise.reject(error)),
    })
    const { processor } = createProcessor(command)

    await expect(
      processor.process({
        name: START_WA_INSTANCE_JOB_NAME,
        data: { instanceId: 'instance-2' },
      }),
    ).rejects.toBe(error)
  })

  it('domain errors propagate and reject the job', async () => {
    const error = new Error('cannot stop instance outside owner process')
    const command = createCommandMock({
      stopInstance: vi.fn(async () => Promise.reject(error)),
    })
    const { processor } = createProcessor(command)

    await expect(
      processor.process({
        name: STOP_WA_INSTANCE_JOB_NAME,
        data: {
          instanceId: 'instance-4',
          expectedOwnerWorkerId: 'worker-local',
          expectedOwnerEpoch: '1',
        },
        queueName: createWaLifecycleOwnerQueueName('worker-local'),
      }),
    ).rejects.toBe(error)
  })

  it('reroutes stop to the current owner without calling the local lifecycle', async () => {
    const command = createCommandMock()
    const { processor, queueService } = createProcessor(command, {
      owner: 'worker-owner',
      workerId: 'worker-other',
    })

    await expect(
      processor.process({
        name: STOP_WA_INSTANCE_JOB_NAME,
        data: { instanceId: 'instance-owned' },
      }),
    ).resolves.toEqual({ instanceId: 'instance-owned', stopped: true })

    expect(queueService.enqueueStop).toHaveBeenCalledWith('instance-owned', {
      owner: 'worker-owner',
      epoch: 1n,
    })
    expect(command.stopInstance).not.toHaveBeenCalled()
  })

  it('reroutes renew to the current owner without calling the local lifecycle', async () => {
    const command = createCommandMock()
    const { processor, queueService } = createProcessor(command, {
      owner: 'worker-owner',
      workerId: 'worker-other',
    })

    await expect(
      processor.process({
        name: RENEW_WA_INSTANCE_JOB_NAME,
        data: { instanceId: 'instance-owned' },
      }),
    ).resolves.toEqual({ instanceId: 'instance-owned', renewed: true })

    expect(queueService.enqueueRenew).toHaveBeenCalledWith('instance-owned', {
      owner: 'worker-owner',
      epoch: 1n,
    })
    expect(command.renewInstance).not.toHaveBeenCalled()
  })

  it('retries a stale ack and routes the next generic attempt to the fresh epoch', async () => {
    const command = createCommandMock()
    const { processor, ownerRegistry, queueService } = createProcessor(command)
    ownerRegistry.getOwnership
      .mockResolvedValueOnce({ owner: 'worker-old', epoch: 1n })
      .mockResolvedValueOnce({ owner: 'worker-next', epoch: 2n })
    queueService.enqueueStop
      .mockResolvedValueOnce({
        instanceId: 'instance-migrating',
        stopped: false,
        ownershipStale: true,
      })
      .mockResolvedValueOnce({ instanceId: 'instance-migrating', stopped: true })

    const job = {
      name: STOP_WA_INSTANCE_JOB_NAME,
      data: { instanceId: 'instance-migrating' },
      queueName: WA_LIFECYCLE_QUEUE_NAME,
    }
    await expect(processor.process(job)).rejects.toBeInstanceOf(WaLifecycleOwnerUnavailableError)
    await expect(processor.process(job)).resolves.toEqual({
      instanceId: 'instance-migrating',
      stopped: true,
    })

    expect(command.stopInstance).not.toHaveBeenCalled()
    expect(queueService.enqueueStop).toHaveBeenNthCalledWith(1, 'instance-migrating', {
      owner: 'worker-old',
      epoch: 1n,
    })
    expect(queueService.enqueueStop).toHaveBeenNthCalledWith(2, 'instance-migrating', {
      owner: 'worker-next',
      epoch: 2n,
    })
  })

  it('retries an inconsistent local false while ownership still points to this worker', async () => {
    const command = createCommandMock({
      renewInstance: vi.fn(async () => false),
    })
    const { processor } = createProcessor(command)

    await expect(
      processor.process({
        name: RENEW_WA_INSTANCE_JOB_NAME,
        data: {
          instanceId: 'instance-inconsistent',
          expectedOwnerWorkerId: 'worker-local',
          expectedOwnerEpoch: '1',
        },
        queueName: createWaLifecycleOwnerQueueName('worker-local'),
      }),
    ).rejects.toBeInstanceOf(WaLifecycleOwnerUnavailableError)
  })

  it('keeps the generic job retryable when the target worker dies before ack', async () => {
    const command = createCommandMock()
    const { processor, ownerRegistry, queueService } = createProcessor(command, {
      workerId: 'worker-old',
    })
    const timeout = new Error('owner ack timeout')
    ownerRegistry.getOwnership
      .mockResolvedValueOnce({ owner: 'worker-dead', epoch: 4n })
      .mockResolvedValueOnce({ owner: 'worker-next', epoch: 5n })
    queueService.enqueueStop
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ instanceId: 'instance-crash', stopped: true })
    const job = {
      name: STOP_WA_INSTANCE_JOB_NAME,
      data: { instanceId: 'instance-crash' },
      queueName: WA_LIFECYCLE_QUEUE_NAME,
    }

    await expect(processor.process(job)).rejects.toBe(timeout)
    await expect(processor.process(job)).resolves.toEqual({
      instanceId: 'instance-crash',
      stopped: true,
    })

    expect(queueService.enqueueStop).toHaveBeenNthCalledWith(1, 'instance-crash', {
      owner: 'worker-dead',
      epoch: 4n,
    })
    expect(queueService.enqueueStop).toHaveBeenNthCalledWith(2, 'instance-crash', {
      owner: 'worker-next',
      epoch: 5n,
    })
  })

  it('does not reroute a directed renew after ownership migrated', async () => {
    const command = createCommandMock()
    const { processor, queueService } = createProcessor(command, {
      owner: 'worker-next',
      workerId: 'worker-old',
    })

    await expect(
      processor.process({
        name: RENEW_WA_INSTANCE_JOB_NAME,
        data: {
          instanceId: 'instance-migrated',
          expectedOwnerWorkerId: 'worker-old',
          expectedOwnerEpoch: '1',
        },
        queueName: createWaLifecycleOwnerQueueName('worker-old'),
      }),
    ).resolves.toEqual({
      instanceId: 'instance-migrated',
      renewed: false,
      ownershipStale: true,
    })

    expect(queueService.enqueueRenew).not.toHaveBeenCalled()
    expect(command.renewInstance).not.toHaveBeenCalled()
  })

  it('turns an orphaned directed stop from an old epoch into a no-op ack', async () => {
    const command = createCommandMock()
    const { processor, queueService } = createProcessor(command, {
      owner: 'worker-new',
      epoch: 2n,
      workerId: 'worker-old',
    })

    await expect(
      processor.process({
        name: STOP_WA_INSTANCE_JOB_NAME,
        data: {
          instanceId: 'instance-restarted',
          expectedOwnerWorkerId: 'worker-old',
          expectedOwnerEpoch: '1',
        },
        queueName: createWaLifecycleOwnerQueueName('worker-old'),
      }),
    ).resolves.toEqual({
      instanceId: 'instance-restarted',
      stopped: false,
      ownershipStale: true,
    })

    expect(command.stopInstance).not.toHaveBeenCalled()
    expect(queueService.enqueueStop).not.toHaveBeenCalled()
  })

  it('reuses a stable worker queue after crash while fencing the prior generation epoch', async () => {
    const command = createCommandMock({
      stopInstance: vi.fn(async () => true),
    })
    const { processor, ownerRegistry } = createProcessor(command, {
      owner: 'worker-stable-slot',
      epoch: 2n,
      workerId: 'worker-stable-slot',
    })
    const queueName = createWaLifecycleOwnerQueueName('worker-stable-slot')

    await expect(
      processor.process({
        name: STOP_WA_INSTANCE_JOB_NAME,
        data: {
          instanceId: 'instance-after-crash',
          expectedOwnerWorkerId: 'worker-stable-slot',
          expectedOwnerEpoch: '1',
        },
        queueName,
      }),
    ).resolves.toEqual({
      instanceId: 'instance-after-crash',
      stopped: false,
      ownershipStale: true,
    })

    await expect(
      processor.process({
        name: STOP_WA_INSTANCE_JOB_NAME,
        data: {
          instanceId: 'instance-after-crash',
          expectedOwnerWorkerId: 'worker-stable-slot',
          expectedOwnerEpoch: '2',
        },
        queueName,
      }),
    ).resolves.toEqual({
      instanceId: 'instance-after-crash',
      stopped: true,
    })

    expect(ownerRegistry.getOwnership).toHaveBeenCalledTimes(2)
    expect(command.stopInstance).toHaveBeenCalledTimes(1)
  })

  it('cannot let a timed-out old stop affect a session started under a new epoch', async () => {
    const command = createCommandMock()
    const { processor, ownerRegistry, queueService } = createProcessor(command, {
      workerId: 'worker-old',
    })
    const timeout = new Error('owner ack timeout')
    ownerRegistry.getOwnership
      .mockResolvedValueOnce({ owner: 'worker-old', epoch: 1n })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ owner: 'worker-new', epoch: 2n })
    queueService.enqueueStop.mockRejectedValueOnce(timeout)
    const genericJob = {
      name: STOP_WA_INSTANCE_JOB_NAME,
      data: { instanceId: 'instance-causal' },
      queueName: WA_LIFECYCLE_QUEUE_NAME,
    }

    await expect(processor.process(genericJob)).rejects.toBe(timeout)
    await expect(processor.process(genericJob)).resolves.toEqual({
      instanceId: 'instance-causal',
      stopped: false,
    })
    await expect(
      processor.process({
        name: STOP_WA_INSTANCE_JOB_NAME,
        data: {
          instanceId: 'instance-causal',
          expectedOwnerWorkerId: 'worker-old',
          expectedOwnerEpoch: '1',
        },
        queueName: createWaLifecycleOwnerQueueName('worker-old'),
      }),
    ).resolves.toEqual({
      instanceId: 'instance-causal',
      stopped: false,
      ownershipStale: true,
    })

    expect(queueService.enqueueStop).toHaveBeenCalledTimes(1)
    expect(queueService.enqueueStop).toHaveBeenCalledWith('instance-causal', {
      owner: 'worker-old',
      epoch: 1n,
    })
    expect(command.stopInstance).not.toHaveBeenCalled()
  })

  it('rejects for BullMQ retry when no owner exists yet', async () => {
    const command = createCommandMock()
    const { processor, queueService } = createProcessor(command, { owner: null })
    queueService.hasPendingStart.mockResolvedValueOnce(true)

    await expect(
      processor.process({
        name: RENEW_WA_INSTANCE_JOB_NAME,
        data: { instanceId: 'instance-pending-start' },
      }),
    ).rejects.toBeInstanceOf(WaLifecycleOwnerUnavailableError)

    expect(command.renewInstance).not.toHaveBeenCalled()
    expect(queueService.enqueueRenew).not.toHaveBeenCalled()
  })

  it('finishes idempotently when neither an owner nor a pending start exists', async () => {
    const command = createCommandMock()
    const { processor, queueService } = createProcessor(command, { owner: null })

    await expect(
      processor.process({
        name: STOP_WA_INSTANCE_JOB_NAME,
        data: { instanceId: 'instance-stopped' },
      }),
    ).resolves.toEqual({ instanceId: 'instance-stopped', stopped: false })

    expect(queueService.hasPendingStart).toHaveBeenCalledWith('instance-stopped')
    expect(command.stopInstance).not.toHaveBeenCalled()
  })
})

function createProcessor(
  command: CommandMock,
  options: { owner?: string | null; epoch?: bigint; workerId?: string } = {},
) {
  const ownerRegistry = {
    getOwner: vi.fn(async () => (options.owner === undefined ? 'worker-local' : options.owner)),
    getOwnership: vi.fn(async () => {
      const owner = options.owner === undefined ? 'worker-local' : options.owner
      return owner ? { owner, epoch: options.epoch ?? 1n } : null
    }),
  }
  const queueService = {
    enqueueStop: vi.fn(async (instanceId: string) => ({ instanceId, stopped: true })),
    enqueueRenew: vi.fn(async (instanceId: string) => ({ instanceId, renewed: true })),
    hasPendingStart: vi.fn(async () => false),
  }

  return {
    ownerRegistry,
    queueService,
    processor: new WaLifecycleJobProcessor(
      command,
      ownerRegistry as never,
      options.workerId ?? 'worker-local',
      queueService as never,
    ),
  }
}

function createCommandMock(overrides: Partial<CommandMock> = {}): CommandMock {
  return {
    startInstance: vi.fn(async () => createSessionState('default-instance', 'connected')),
    stopInstance: vi.fn(async () => false),
    renewInstance: vi.fn(async () => false),
    ...overrides,
  }
}

function createSessionState(instanceId: string, status: SessionState['status']): SessionState {
  return {
    instanceId,
    status,
    hasAuthState: true,
    logoutCount: 0,
  }
}

type CommandMock = Pick<
  WaLifecycleCommandService,
  'startInstance' | 'stopInstance' | 'renewInstance'
> & {
  startInstance: ReturnType<typeof vi.fn<(instanceId: string) => Promise<SessionState>>>
  stopInstance: ReturnType<typeof vi.fn<(instanceId: string) => Promise<boolean>>>
  renewInstance: ReturnType<typeof vi.fn<(instanceId: string) => Promise<boolean>>>
}
