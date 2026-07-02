import { describe, expect, it } from 'vitest'

import {
  START_WA_INSTANCE_JOB_NAME,
  WA_LIFECYCLE_QUEUE_NAME,
  parseStartWaInstanceJobPayload,
} from './index'

describe('WA lifecycle queue contract', () => {
  it('exports the queue and start job names', () => {
    expect(WA_LIFECYCLE_QUEUE_NAME).toBe('wa-lifecycle')
    expect(START_WA_INSTANCE_JOB_NAME).toBe('start-wa-instance')
  })

  it('accepts and normalizes a start-wa-instance payload', () => {
    expect(parseStartWaInstanceJobPayload({ instanceId: ' instance-1 ' })).toEqual({
      instanceId: 'instance-1',
    })
  })

  it('rejects invalid start-wa-instance payloads', () => {
    expect(() => parseStartWaInstanceJobPayload(null)).toThrow(
      'start-wa-instance payload.instanceId must be a non-empty string',
    )
    expect(() => parseStartWaInstanceJobPayload({ instanceId: '' })).toThrow(
      'start-wa-instance payload.instanceId must be a non-empty string',
    )
    expect(() => parseStartWaInstanceJobPayload({ instanceId: 123 })).toThrow(
      'start-wa-instance payload.instanceId must be a non-empty string',
    )
  })
})
