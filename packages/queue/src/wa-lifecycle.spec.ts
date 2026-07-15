import { describe, expect, it } from 'vitest'

import {
  RENEW_WA_INSTANCE_JOB_NAME,
  START_WA_INSTANCE_JOB_NAME,
  STOP_WA_INSTANCE_JOB_NAME,
  WA_LIFECYCLE_OWNER_RESULT_MAX_AGE_SECONDS,
  WA_LIFECYCLE_OWNER_RESULT_MAX_COUNT,
  WA_LIFECYCLE_QUEUE_NAME,
  createWaLifecycleOwnerQueueName,
  createWaLifecycleOwnerJobId,
  createWaLifecycleJobId,
  parseWaLifecycleInstanceJobPayload,
  parseWaLifecycleOwnerCommandJobPayload,
  parseStartWaInstanceJobPayload,
} from './index'

describe('WA lifecycle queue contract', () => {
  it('exports the queue and all lifecycle job names', () => {
    expect(WA_LIFECYCLE_QUEUE_NAME).toBe('wa-lifecycle')
    expect(createWaLifecycleOwnerQueueName(' worker/a ')).toBe('wa-lifecycle-owner.worker%2Fa')
    expect(START_WA_INSTANCE_JOB_NAME).toBe('start-wa-instance')
    expect(STOP_WA_INSTANCE_JOB_NAME).toBe('stop-wa-instance')
    expect(RENEW_WA_INSTANCE_JOB_NAME).toBe('renew-wa-instance')
  })

  it('rejects an empty owner worker id before constructing a directed queue name', () => {
    expect(() => createWaLifecycleOwnerQueueName('   ')).toThrow(
      'workerId must be a non-empty string',
    )
  })

  it('reuses one owner queue across sequential generations of a stable worker slot', () => {
    const sequentialGenerations = Array.from({ length: 10_000 }, () =>
      createWaLifecycleOwnerQueueName('worker-slot-a'),
    )
    const concurrentWorker = createWaLifecycleOwnerQueueName('worker-slot-b')

    expect(new Set(sequentialGenerations)).toEqual(new Set(['wa-lifecycle-owner.worker-slot-a']))
    expect(concurrentWorker).not.toBe(sequentialGenerations[0])
  })

  it('publishes a bounded owner-result retention contract', () => {
    expect(WA_LIFECYCLE_OWNER_RESULT_MAX_AGE_SECONDS).toBe(300)
    expect(WA_LIFECYCLE_OWNER_RESULT_MAX_COUNT).toBe(1_000)
  })

  it('normalizes and fences owner-directed payloads with a serializable epoch', () => {
    const payload = parseWaLifecycleOwnerCommandJobPayload(
      {
        instanceId: ' instance-1 ',
        expectedOwnerWorkerId: ' worker/a ',
        expectedOwnerEpoch: '7',
      },
      STOP_WA_INSTANCE_JOB_NAME,
    )

    expect(payload).toEqual({
      instanceId: 'instance-1',
      expectedOwnerWorkerId: 'worker/a',
      expectedOwnerEpoch: '7',
    })
    expect(createWaLifecycleOwnerJobId(STOP_WA_INSTANCE_JOB_NAME, payload)).toBe(
      'wa-lifecycle-owner.stop-wa-instance.instance-1.worker%2Fa.7',
    )
  })

  it('rejects missing or non-positive owner epochs', () => {
    expect(() =>
      parseWaLifecycleOwnerCommandJobPayload(
        {
          instanceId: 'instance-1',
          expectedOwnerWorkerId: 'worker-a',
          expectedOwnerEpoch: '0',
        },
        RENEW_WA_INSTANCE_JOB_NAME,
      ),
    ).toThrow('positive expectedOwnerEpoch')
    expect(() =>
      parseWaLifecycleOwnerCommandJobPayload(
        {
          instanceId: 'instance-1',
          expectedOwnerWorkerId: 'worker-a',
        },
        RENEW_WA_INSTANCE_JOB_NAME,
      ),
    ).toThrow('positive expectedOwnerEpoch')
  })

  it('keeps dotted owner job-id segments unambiguous', () => {
    const first = createWaLifecycleOwnerJobId(STOP_WA_INSTANCE_JOB_NAME, {
      instanceId: 'a.b',
      expectedOwnerWorkerId: 'c',
      expectedOwnerEpoch: '1',
    })
    const second = createWaLifecycleOwnerJobId(STOP_WA_INSTANCE_JOB_NAME, {
      instanceId: 'a',
      expectedOwnerWorkerId: 'b.c',
      expectedOwnerEpoch: '1',
    })

    expect(first).not.toBe(second)
    expect(first).toContain('a%2Eb')
    expect(second).toContain('b%2Ec')
  })

  it('accepts and normalizes a lifecycle instance payload', () => {
    expect(
      parseWaLifecycleInstanceJobPayload({ instanceId: ' instance-1 ' }, STOP_WA_INSTANCE_JOB_NAME),
    ).toEqual({
      instanceId: 'instance-1',
    })
  })

  it('rejects invalid lifecycle instance payloads with a job-specific error', () => {
    expect(() => parseWaLifecycleInstanceJobPayload(null, RENEW_WA_INSTANCE_JOB_NAME)).toThrow(
      'renew-wa-instance payload.instanceId must be a non-empty string',
    )
    expect(() =>
      parseWaLifecycleInstanceJobPayload({ instanceId: '' }, RENEW_WA_INSTANCE_JOB_NAME),
    ).toThrow('renew-wa-instance payload.instanceId must be a non-empty string')
    expect(() =>
      parseWaLifecycleInstanceJobPayload({ instanceId: 123 }, RENEW_WA_INSTANCE_JOB_NAME),
    ).toThrow('renew-wa-instance payload.instanceId must be a non-empty string')
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
    const startJobId = createWaLifecycleJobId(START_WA_INSTANCE_JOB_NAME, {
      instanceId: 'instance-1',
    })
    const stopJobId = createWaLifecycleJobId(STOP_WA_INSTANCE_JOB_NAME, {
      instanceId: 'instance-1',
    })
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
