type MaybePromise<T> = Promise<T> | T

export interface WaMessagesUpsertInput {
  type: 'append' | 'notify'
  messages: readonly unknown[]
}

export interface WaMessageKeySnapshot {
  id: string
  remoteJid: string
  participantJid?: string
  fromMe?: boolean
}

export interface WaMessageContentSnapshot {
  type: string
  text?: string
}

export interface WaMessageSnapshot {
  key: WaMessageKeySnapshot
  messageTimestampSeconds?: number
  pushName?: string
  content?: WaMessageContentSnapshot
}

export interface WaMessageUpdateSnapshot {
  key: WaMessageKeySnapshot
  status?: number
  messageTimestampSeconds?: number
  content?: WaMessageContentSnapshot
}

export interface WaMessageUpsertEvent {
  eventType: 'wa.message.upsert'
  instanceId: string
  upsertType: 'append' | 'notify'
  messages: WaMessageSnapshot[]
}

export interface WaMessageUpdateEvent {
  eventType: 'wa.message.update'
  instanceId: string
  updates: WaMessageUpdateSnapshot[]
}

export interface WaReceiver {
  onMessageUpsert(event: WaMessageUpsertEvent): MaybePromise<void>
  onMessageUpdate(event: WaMessageUpdateEvent): MaybePromise<void>
}

export function mapBaileysMessagesUpsert(
  instanceId: string,
  input: WaMessagesUpsertInput,
): WaMessageUpsertEvent | undefined {
  const normalizedInstanceId = normalizeRequiredString(instanceId, 'instanceId')
  const messages = Array.isArray(input.messages)
    ? input.messages.map(mapMessageSnapshot).filter(isDefined)
    : []
  if (messages.length === 0) return undefined

  return {
    eventType: 'wa.message.upsert',
    instanceId: normalizedInstanceId,
    upsertType: input.type,
    messages,
  }
}

export function mapBaileysMessageUpdates(
  instanceId: string,
  input: readonly unknown[],
): WaMessageUpdateEvent | undefined {
  const normalizedInstanceId = normalizeRequiredString(instanceId, 'instanceId')
  const updates = Array.isArray(input) ? input.map(mapMessageUpdate).filter(isDefined) : []
  if (updates.length === 0) return undefined

  return {
    eventType: 'wa.message.update',
    instanceId: normalizedInstanceId,
    updates,
  }
}

function mapMessageSnapshot(value: unknown): WaMessageSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const key = mapMessageKey(value.key)
  if (!key) return undefined

  const messageTimestampSeconds = normalizeTimestamp(value.messageTimestamp)
  const pushName = normalizeOptionalString(value.pushName)
  const content = mapMessageContent(value.message)

  return {
    key,
    ...(messageTimestampSeconds === undefined ? {} : { messageTimestampSeconds }),
    ...(pushName ? { pushName } : {}),
    ...(content ? { content } : {}),
  }
}

function mapMessageUpdate(value: unknown): WaMessageUpdateSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const key = mapMessageKey(value.key)
  if (!key) return undefined

  const update = isRecord(value.update) ? value.update : undefined
  const status = normalizeStatus(update?.status)
  const messageTimestampSeconds = normalizeTimestamp(update?.messageTimestamp)
  const content = mapMessageContent(update?.message)

  return {
    key,
    ...(status === undefined ? {} : { status }),
    ...(messageTimestampSeconds === undefined ? {} : { messageTimestampSeconds }),
    ...(content ? { content } : {}),
  }
}

function mapMessageKey(value: unknown): WaMessageKeySnapshot | undefined {
  if (!isRecord(value)) return undefined
  const id = normalizeOptionalString(value.id)
  const remoteJid = normalizeOptionalString(value.remoteJid)
  if (!id || !remoteJid) return undefined

  const participantJid = normalizeOptionalString(value.participant)
  return {
    id,
    remoteJid,
    ...(participantJid ? { participantJid } : {}),
    ...(typeof value.fromMe === 'boolean' ? { fromMe: value.fromMe } : {}),
  }
}

function mapMessageContent(value: unknown): WaMessageContentSnapshot | undefined {
  const content = unwrapMessageContent(value)
  if (!content) return undefined

  const conversation = normalizeOptionalText(content.conversation)
  if (typeof content.conversation === 'string') {
    return {
      type: 'conversation',
      ...(conversation === undefined ? {} : { text: conversation }),
    }
  }

  const type = Object.keys(content).find(
    (key) => key !== 'messageContextInfo' && content[key] !== null && content[key] !== undefined,
  )
  if (!type) return undefined

  const payload = content[type]
  const text = extractText(type, payload)
  return {
    type,
    ...(text === undefined ? {} : { text }),
  }
}

function unwrapMessageContent(value: unknown): Record<string, unknown> | undefined {
  let content = isRecord(value) ? value : undefined
  for (let depth = 0; content && depth < 6; depth += 1) {
    const wrapped = WRAPPER_KEYS.map((key) => content?.[key]).find(isRecord)
    if (!wrapped || !isRecord(wrapped.message)) return content
    content = wrapped.message
  }
  return content
}

const WRAPPER_KEYS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
] as const

function extractText(type: string, payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined

  if (type === 'extendedTextMessage') return normalizeOptionalText(payload.text)
  if (type === 'imageMessage' || type === 'videoMessage' || type === 'documentMessage') {
    return normalizeOptionalText(payload.caption)
  }
  if (type === 'buttonsResponseMessage') {
    return (
      normalizeOptionalText(payload.selectedDisplayText) ??
      normalizeOptionalText(payload.selectedButtonId)
    )
  }
  if (type === 'templateButtonReplyMessage') {
    return normalizeOptionalText(payload.selectedDisplayText)
  }
  if (type === 'listResponseMessage') {
    const reply = isRecord(payload.singleSelectReply) ? payload.singleSelectReply : undefined
    return normalizeOptionalText(payload.title) ?? normalizeOptionalText(reply?.selectedRowId)
  }

  return undefined
}

function normalizeStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function normalizeTimestamp(value: unknown): number | undefined {
  let candidate: number
  if (typeof value === 'number') {
    candidate = value
  } else if (typeof value === 'bigint') {
    candidate = Number(value)
  } else if (typeof value === 'string' && /^\d+$/.test(value)) {
    candidate = Number(value)
  } else if (isRecord(value) && typeof value.toString === 'function') {
    try {
      candidate = Number(value.toString())
    } catch {
      return undefined
    }
  } else {
    return undefined
  }

  return Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : undefined
}

function normalizeRequiredString(value: string, fieldName: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new TypeError(`${fieldName} must be a non-empty string`)
  return normalized
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
