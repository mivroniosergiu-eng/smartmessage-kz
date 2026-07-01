import { normalizePhone } from './phone'

const JID_RE = /^(7\d{10})@s\.whatsapp\.net$/

/** Телефон -> WhatsApp JID. */
export function phoneToJid(phone: string): string {
  return normalizePhone(phone).slice(1) + '@s.whatsapp.net'
}

/** WhatsApp JID -> E.164 телефон. */
export function jidToPhone(jid: string): string {
  const m = JID_RE.exec(jid)
  if (!m) throw new Error(`invalid JID: ${jid}`)
  const digits = m[1]
  if (!digits) throw new Error(`invalid JID: ${jid}`)
  return normalizePhone(digits)
}

export function isJid(value: string): boolean {
  try {
    jidToPhone(value)
    return true
  } catch {
    return false
  }
}
