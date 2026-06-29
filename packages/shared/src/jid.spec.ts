import { describe, it, expect } from 'vitest'
import { phoneToJid, jidToPhone, isJid } from './jid'

describe('jid', () => {
  it('phoneToJid', () => expect(phoneToJid('+77012345678')).toBe('77012345678@s.whatsapp.net'))
  it('jidToPhone', () => expect(jidToPhone('77012345678@s.whatsapp.net')).toBe('+77012345678'))
  it('jidToPhone мусор', () => expect(() => jidToPhone('nope')).toThrow())
  it('isJid', () => {
    expect(isJid('77012345678@s.whatsapp.net')).toBe(true)
    expect(isJid('+77012345678')).toBe(false)
  })
})
