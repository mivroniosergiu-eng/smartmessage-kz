import { describe, expect, it } from 'vitest'

import {
  RENEW_WA_INSTANCE_JOB_NAME,
  START_WA_INSTANCE_JOB_NAME,
  STOP_WA_INSTANCE_JOB_NAME,
  WA_LIFECYCLE_QUEUE_NAME,
  createWaLifecycleJobId,
  parseWaLifecycleInstanceJobPayload,
  parseStartWaInstanceJobPayload,
} from './index'

describe('WA lifecycle queue contract', () => {
  it('exports the queue and all lifecycle job names', () => {
    expect(WA_LIFECYCLE_QUEUE_NAME).toBe('wa-lifecycle')
    expect(START_WA_INSTANCE_JOB_NAME).toBe('start-wa-instance')
    expect(STOP_WA_INSTANCE_JOB_NAME).toBe('stop-wa-instance')
    expect(RENEW_WA_INSTANCE_JOB_NAME).toBe('renew-wa-instance')
  })

  it('accepts and normalizes a lifecycle instance payload', () => {
    expect(parseWaLifecycleInstanceJobPayload({ instanceId: ' instance-1 ' }, STOP_WA_INSTANCE_JOB_NAME)).toEqual({
      instanceId: 'instance-1',
    })
  })

  it('rejects invalid lifecycle instance payloads with a job-specific error', () => {
    expect(() => parseWaLifecycleInstanceJobPayload(null, RENEW_WA_INSTANCE_JOB_NAME)).toThrow(
      'renew-wa-instance payload.instanceId must be a non-empty string',
    )
    expect(() => parseWaLifecycleInstanceJobPayload({ instanceId: '' }, RENEW_WA_INSTANCE_JOB_NAME)).toThrow(
      'renew-wa-instance payload.instanceId must be a non-empty string',
    )
    expect(() => parseWaLifecycleInstanceJobPayload({ instanceId: 123 }, RENEW_WA_INSTANCE_JOB_NAME)).toThrow(
      'renew-wa-instance payload.instanceId must be a non-empty string',
    )
  })

  it('keeps the start parser as a compatibility wrapper', () => {
    expect(parseStartWaInstanceJobPayload({ instanceId: ' instance-2 ' })).toEqual({
      instanceId: 'instance-2',
    })
    expect(() => parseStartWaInstanceJobPayload({ instanceId: ' ' })).toThrow(
      'start-wa-instance payload.instanceId must be a non-empty string',
    )
  })

  it('creates deterministic job ids from normalized lifecycle payloads', () => {
    expect(createWaLifecycleJobId(START_WA_INSTANCE_JOB_NAME, { instanceId: ' instance-1 ' })).toBe(
      createWaLifecycleJobId(START_WA_INSTANCE_JOB_NAME, { instanceId: 'instance-1' }),
    )
  })

  it('encodes lifecycle job ids so unsafe separators cannot leak from instance ids', () => {
    const jobId = createWaLifecycleJobId(STOP_WA_INSTANCE_JOB_NAME, {
      instanceId: ' tenant 1/wa:primary ',
    })

    expect(jobId).toBe('wa-lifecycle.stop-wa-instance.tenant%201%2Fwa%3Aprimary')
    expect(jobId).not.toContain(' ')
    expect(jobId).not.toContain('/')
    expect(jobId).not.toContain(':')
  })

  it('keeps lifecycle job ids distinct by job name and instance id', () => {
    const startJobId = createWaLifecycleJobId(START_WA_INSTANCE_JOB_NAME, { instanceId: 'instance-1' })
    const stopJobId = createWaLifecycleJobId(STOP_WA_INSTANCE_JOB_NAME, { instanceId: 'instance-1' })
    const anotherInstanceJobId = createWaLifecycleJobId(START_WA_INSTANCE_JOB_NAME, {
      instanceId: 'instance-2',
    })

    expect(new Set([startJobId, stopJobId, anotherInstanceJobId])).toHaveLength(3)
  })

  it('rejects invalid lifecycle job id payloads before creating an id', () => {
    expect(() => createWaLifecycleJobId(RENEW_WA_INSTANCE_JOB_NAME, { instanceId: ' ' })).toThrow(
      'renew-wa-instance payload.instanceId must be a non-empty string',
    )
  })
})
