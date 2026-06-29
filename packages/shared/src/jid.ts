import { normalizePhone } from './phone'

const JID_RE = /^(\d+)@s\.whatsapp\.net$/

/** Телефон -> WhatsApp JID. */
export function phoneToJid(phone: string): string {
  return normalizePhone(phone).slice(1) + '@s.whatsapp.net'
}

/** WhatsApp JID -> E.164 телефон. */
export function jidToPhone(jid: string): string {
  const m = JID_RE.exec(jid)
  if (!m) throw new Error(`invalid JID: ${jid}`)
  return '+' + m[1]
}

export function isJid(value: string): boolean {
  return JID_RE.test(value)
}
