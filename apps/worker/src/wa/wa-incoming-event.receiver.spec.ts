import { Logger } from '@nestjs/common'
import type { WaMessageUpdateEvent, WaMessageUpsertEvent } from '@smartmessage/wa'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WaIncomingEventReceiver } from './wa-incoming-event.receiver'

describe('WaIncomingEventReceiver', () => {
  afterEach(() => vi.restoreAllMocks())

  it('accepts domain events while keeping message content and JIDs out of logs', async () => {
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined)
    const receiver = new WaIncomingEventReceiver()
    const upsert: WaMessageUpsertEvent = {
      eventType: 'wa.message.upsert',
      instanceId: 'private-instance',
      upsertType: 'notify',
      messages: [
        {
          key: {
            id: 'private-message-id',
            remoteJid: '77010000001@s.whatsapp.net',
            fromMe: false,
          },
          content: { type: 'conversation', text: 'private message text' },
        },
      ],
    }
    const update: WaMessageUpdateEvent = {
      eventType: 'wa.message.update',
      instanceId: 'private-instance',
      updates: [
        {
          key: { id: 'private-message-id', remoteJid: '77010000001@s.whatsapp.net' },
          status: 3,
        },
      ],
    }

    await receiver.onMessageUpsert(upsert)
    await receiver.onMessageUpdate(update)

    expect(debug).toHaveBeenNthCalledWith(1, 'WA incoming upsert accepted (1 message)')
    expect(debug).toHaveBeenNthCalledWith(2, 'WA incoming update accepted (1 update)')
    const serializedCalls = JSON.stringify(debug.mock.calls)
    expect(serializedCalls).not.toContain('private-instance')
    expect(serializedCalls).not.toContain('private-message-id')
    expect(serializedCalls).not.toContain('77010000001')
    expect(serializedCalls).not.toContain('private message text')
  })
})
