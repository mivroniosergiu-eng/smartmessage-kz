import { describe, expect, it } from 'vitest'

import {
  SEND_WA_TEXT_JOB_NAME,
  WA_SINGLE_SEND_QUEUE_NAME,
  createWaSingleSendJobId,
  createWaSingleSendOwnerJobId,
  createWaSingleSendOwnerQueueName,
  parseWaSingleSendJobPayload,
  parseWaSingleSendOwnerJobPayload,
} from './index'

describe('WA single-send queue contract', () => {
  const generic = {
    instanceId: ' instance-1 ',
    contactId: ' contact-1 ',
    text: ' Hello ',
    idempotencyKey: ' request.1 ',
  }

  it('normalizes a generic payload and produces a stable job id', () => {
    expect(WA_SINGLE_SEND_QUEUE_NAME).toBe('wa-single-send')
    expect(SEND_WA_TEXT_JOB_NAME).toBe('send-wa-text')
    const parsed = parseWaSingleSendJobPayload(generic)
    expect(parsed).toEqual({
      instanceId: 'instance-1',
      contactId: 'contact-1',
      text: 'Hello',
      idempotencyKey: 'request.1',
    })
    expect(createWaSingleSendJobId(parsed)).toBe(
      'wa-single-send.send-wa-text.instance-1.contact-1.request%2E1.185f8db32271fe25',
    )

    expect(createWaSingleSendJobId({ ...parsed, text: 'Different' })).not.toBe(
      createWaSingleSendJobId(parsed),
    )
  })

  it('requires exact owner identity and epoch in owner payload', () => {
    const parsed = parseWaSingleSendOwnerJobPayload({
      ...generic,
      messageLogId: ' log-1 ',
      teamId: ' team-1 ',
      phone: ' +77012345678 ',
      expectedOwnerWorkerId: ' worker/a ',
      expectedOwnerEpoch: '2',
    })
    expect(createWaSingleSendOwnerQueueName(' worker/a ')).toBe('wa-single-send-owner.worker%2Fa')
    expect(createWaSingleSendOwnerJobId(parsed)).toBe(
      'wa-single-send-owner.send-wa-text.log-1.worker%2Fa.2',
    )
  })

  it('rejects malformed generic and owner payloads', () => {
    expect(() => parseWaSingleSendJobPayload({ ...generic, text: ' ' })).toThrow(TypeError)
    expect(() =>
      parseWaSingleSendOwnerJobPayload({
        ...generic,
        messageLogId: 'log-1',
        teamId: 'team-1',
        phone: '+77012345678',
        expectedOwnerWorkerId: 'worker-1',
        expectedOwnerEpoch: '0',
      }),
    ).toThrow(TypeError)
  })

  it('rejects oversized fields before they can enter Redis or a job id', () => {
    expect(() =>
      parseWaSingleSendJobPayload({
        ...generic,
        text: 'x'.repeat(4_001),
      }),
    ).toThrow(TypeError)
    expect(() =>
      parseWaSingleSendJobPayload({
        ...generic,
        idempotencyKey: 'x'.repeat(201),
      }),
    ).toThrow(TypeError)
  })
})
