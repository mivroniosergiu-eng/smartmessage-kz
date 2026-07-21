export type SendMessageKind = 'text'

export interface SendMessagePayload {
  instanceId: string
  recipientPhone: string
  kind: SendMessageKind
  text: string
  idempotencyKey: string
}

export type SendMessageStatus = 'accepted' | 'failed'

export interface SendMessageResult {
  messageId: string
  status: SendMessageStatus
}

export interface MessageSender {
  send(payload: SendMessagePayload): Promise<SendMessageResult>
}

export class WaMessageSenderUnavailableError extends Error {
  constructor() {
    super('WA message sender is unavailable for the configured transport')
    this.name = 'WaMessageSenderUnavailableError'
  }
}

export class UnavailableMessageSender implements MessageSender {
  async send(_payload: SendMessagePayload): Promise<SendMessageResult> {
    throw new WaMessageSenderUnavailableError()
  }
}

export class MockMessageSender implements MessageSender {
  readonly sentPayloads: SendMessagePayload[] = []

  async send(payload: SendMessagePayload): Promise<SendMessageResult> {
    this.sentPayloads.push(payload)

    return {
      messageId: stableMockMessageId(payload),
      status: 'accepted',
    }
  }
}

export function stableMockMessageId(payload: SendMessagePayload): string {
  return `mock:${encodePart(payload.instanceId)}:${encodePart(payload.recipientPhone)}:${encodePart(
    payload.idempotencyKey,
  )}`
}

function encodePart(value: string): string {
  return encodeURIComponent(value.trim().toLowerCase())
}
