import { describe, expect, it } from 'vitest'

import { MockMessageSender } from './sender'
import type { SendMessagePayload } from './sender'

describe('MockMessageSender', () => {
  it('returns stable messageId and accepted status without external send', async () => {
    const sender = new MockMessageSender()
    const payload: SendMessagePayload = {
      instanceId: 'wa-test-1',
      recipientPhone: 'fixture-recipient-alpha',
      kind: 'text',
      text: 'Contract test message',
      idempotencyKey: 'campaign-1:contact-1',
    }

    const first = await sender.send(payload)
    const second = await sender.send(payload)

    expect(first).toEqual(second)
    expect(first.status).toBe('accepted')
    expect(first.messageId).toBe('mock:wa-test-1:fixture-recipient-alpha:campaign-1%3Acontact-1')
    expect(sender.sentPayloads).toEqual([payload, payload])
  })
})
