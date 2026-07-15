import { describe, expect, it } from 'vitest'

import { mapBaileysMessageUpdates, mapBaileysMessagesUpsert } from './receiver'

describe('WA receiver domain mapping', () => {
  it('maps a notify batch to stable typed message snapshots', () => {
    const event = mapBaileysMessagesUpsert(' instance-a ', {
      type: 'notify',
      requestId: 'history-request-must-not-leak',
      messages: [
        {
          key: {
            id: 'message-1',
            remoteJid: '77010000001@s.whatsapp.net',
            participant: '77010000002@s.whatsapp.net',
            fromMe: false,
          },
          messageTimestamp: 1_752_576_000,
          pushName: 'Customer',
          message: { conversation: 'Привет' },
        },
        {
          key: {
            id: 'message-2',
            remoteJid: '77010000003@s.whatsapp.net',
            fromMe: true,
          },
          message: {
            ephemeralMessage: {
              message: { extendedTextMessage: { text: 'Ответ' } },
            },
          },
        },
      ],
    })

    expect(event).toEqual({
      eventType: 'wa.message.upsert',
      instanceId: 'instance-a',
      upsertType: 'notify',
      messages: [
        {
          key: {
            id: 'message-1',
            remoteJid: '77010000001@s.whatsapp.net',
            participantJid: '77010000002@s.whatsapp.net',
            fromMe: false,
          },
          messageTimestampSeconds: 1_752_576_000,
          pushName: 'Customer',
          content: { type: 'conversation', text: 'Привет' },
        },
        {
          key: {
            id: 'message-2',
            remoteJid: '77010000003@s.whatsapp.net',
            fromMe: true,
          },
          content: { type: 'extendedTextMessage', text: 'Ответ' },
        },
      ],
    })
  })

  it('filters malformed records and suppresses an empty upsert batch', () => {
    expect(
      mapBaileysMessagesUpsert('instance-a', {
        type: 'append',
        messages: [
          { key: { remoteJid: '77010000001@s.whatsapp.net' }, message: {} },
          { key: { id: 'message-without-chat' }, message: {} },
          null,
        ],
      }),
    ).toBeUndefined()
  })

  it('maps update batches without leaking Baileys payload objects', () => {
    const event = mapBaileysMessageUpdates('instance-b', [
      {
        key: {
          id: 'message-3',
          remoteJid: '77010000004@s.whatsapp.net',
          fromMe: true,
        },
        update: {
          status: 4,
          messageTimestamp: 1_752_576_100,
          message: { imageMessage: { caption: 'Фото' } },
          pollUpdates: [{ pollUpdateMessageKey: { id: 'raw-must-not-leak' } }],
        },
      },
    ])

    expect(event).toEqual({
      eventType: 'wa.message.update',
      instanceId: 'instance-b',
      updates: [
        {
          key: {
            id: 'message-3',
            remoteJid: '77010000004@s.whatsapp.net',
            fromMe: true,
          },
          status: 4,
          messageTimestampSeconds: 1_752_576_100,
          content: { type: 'imageMessage', text: 'Фото' },
        },
      ],
    })
  })

  it('normalizes optional strings and unsafe timestamps defensively', () => {
    const event = mapBaileysMessagesUpsert('instance-c', {
      type: 'notify',
      messages: [
        {
          key: {
            id: ' message-4 ',
            remoteJid: ' chat@s.whatsapp.net ',
            participant: '   ',
          },
          messageTimestamp: Number.MAX_SAFE_INTEGER + 1,
          pushName: '   ',
          message: { videoMessage: { caption: '' } },
        },
      ],
    })

    expect(event?.messages[0]).toEqual({
      key: { id: 'message-4', remoteJid: 'chat@s.whatsapp.net' },
      content: { type: 'videoMessage' },
    })
  })
})
