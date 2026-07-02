import 'reflect-metadata'

import {
  RENEW_WA_INSTANCE_JOB_NAME,
  START_WA_INSTANCE_JOB_NAME,
  STOP_WA_INSTANCE_JOB_NAME,
} from '@smartmessage/queue'
import { WaOwnershipError, type SessionState } from '@smartmessage/wa'
import { describe, expect, it, vi } from 'vitest'

import { WaLifecycleCommandService } from './wa-lifecycle-command.service'
import { WaLifecycleJobProcessor } from './wa-lifecycle-job.processor'

describe('WaLifecycleJobProcessor', () => {
  it('start job calls command service and returns status', async () => {
    const command = createCommandMock({
      startInstance: vi.fn(async () => createSessionState('instance-1', 'connected')),
    })
    const processor = new WaLifecycleJobProcessor(command)

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
    const processor = new WaLifecycleJobProcessor(command)

    await expect(
      processor.process({
        name: STOP_WA_INSTANCE_JOB_NAME,
        data: { instanceId: ' instance-2 ' },
      }),
    ).resolves.toEqual({ instanceId: 'instance-2', stopped: true })
    expect(command.stopInstance).toHaveBeenCalledWith('instance-2')
    expect(command.startInstance).not.toHaveBeenCalled()
    expect(command.renewInstance).not.toHaveBeenCalled()
  })

  it('renew job calls command service and returns renewed result', async () => {
    const command = createCommandMock({
      renewInstance: vi.fn(async () => false),
    })
    const processor = new WaLifecycleJobProcessor(command)

    await expect(
      processor.process({
        name: RENEW_WA_INSTANCE_JOB_NAME,
        data: { instanceId: ' instance-3 ' },
      }),
    ).resolves.toEqual({ instanceId: 'instance-3', renewed: false })
    expect(command.renewInstance).toHaveBeenCalledWith('instance-3')
    expect(command.startInstance).not.toHaveBeenCalled()
    expect(command.stopInstance).not.toHaveBeenCalled()
  })

  it('invalid payload rejects before command call', async () => {
    const command = createCommandMock()
    const processor = new WaLifecycleJobProcessor(command)

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
    const processor = new WaLifecycleJobProcessor(command)

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
    const processor = new WaLifecycleJobProcessor(command)

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
    const processor = new WaLifecycleJobProcessor(command)

    await expect(
      processor.process({
        name: STOP_WA_INSTANCE_JOB_NAME,
        data: { instanceId: 'instance-4' },
      }),
    ).rejects.toBe(error)
  })
})

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

type CommandMock = Pick<WaLifecycleCommandService, 'startInstance' | 'stopInstance' | 'renewInstance'> & {
  startInstance: ReturnType<typeof vi.fn<(instanceId: string) => Promise<SessionState>>>
  stopInstance: ReturnType<typeof vi.fn<(instanceId: string) => Promise<boolean>>>
  renewInstance: ReturnType<typeof vi.fn<(instanceId: string) => Promise<boolean>>>
}
