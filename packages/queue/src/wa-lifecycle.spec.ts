import { describe, expect, it } from 'vitest'

import {
  RENEW_WA_INSTANCE_JOB_NAME,
  START_WA_INSTANCE_JOB_NAME,
  STOP_WA_INSTANCE_JOB_NAME,
  WA_LIFECYCLE_QUEUE_NAME,
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
})
