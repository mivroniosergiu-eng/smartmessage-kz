import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MockMessageSender } from './sender'
import { MockPhoneValidator } from './phone-validator'
import { MockSessionManager } from './session'

describe('wa mocks', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('do not make external network calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const sender = new MockMessageSender()
    const sessions = new MockSessionManager()
    const validator = new MockPhoneValidator()

    await sender.send({
      instanceId: 'instance-1',
      recipientPhone: 'fixture-recipient-alpha',
      kind: 'text',
      text: 'No network',
      idempotencyKey: 'no-network-1',
    })
    await sessions.connect('instance-1')
    await sessions.handleDisconnect('instance-1', 'transient')
    await validator.validate({ phone: 'fixture-recipient-alpha' })

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
