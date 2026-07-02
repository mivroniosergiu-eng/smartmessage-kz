import 'reflect-metadata'

import { START_WA_INSTANCE_JOB_NAME } from '@smartmessage/queue'
import { WaOwnershipError, type SessionState } from '@smartmessage/wa'
import { describe, expect, it, vi } from 'vitest'

import { WaLifecycleCommandService } from './wa-lifecycle-command.service'
import { WaLifecycleJobProcessor } from './wa-lifecycle-job.processor'

describe('WaLifecycleJobProcessor', () => {
  it('valid job calls command service and returns status', async () => {
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

  it('invalid payload rejects before command call', async () => {
    const command = createCommandMock()
    const processor = new WaLifecycleJobProcessor(command)

    await expect(
      processor.process({
        name: START_WA_INSTANCE_JOB_NAME,
        data: { instanceId: '   ' },
      }),
    ).rejects.toThrow('start-wa-instance payload.instanceId must be a non-empty string')
    expect(command.startInstance).not.toHaveBeenCalled()
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
})

function createCommandMock(overrides: Partial<CommandMock> = {}): CommandMock {
  return {
    startInstance: vi.fn(async () => createSessionState('default-instance', 'connected')),
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

type CommandMock = Pick<WaLifecycleCommandService, 'startInstance'> & {
  startInstance: ReturnType<typeof vi.fn<(instanceId: string) => Promise<SessionState>>>
}
