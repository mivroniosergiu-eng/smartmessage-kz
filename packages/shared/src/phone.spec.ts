import { describe, it, expect } from 'vitest'
import { normalizePhone, isValidPhone } from './phone'

describe('normalizePhone', () => {
  it('формат с 8', () => expect(normalizePhone('8 701 234 5678')).toBe('+77012345678'))
  it('формат с +7', () => expect(normalizePhone('+7 (701) 234-56-78')).toBe('+77012345678'))
  it('11 цифр с 7', () => expect(normalizePhone('77012345678')).toBe('+77012345678'))
  it('10-значный', () => expect(normalizePhone('7012345678')).toBe('+77012345678'))
  it('не-строка', () => expect(() => normalizePhone(123 as unknown as string)).toThrow(TypeError))
  it('короткий', () => expect(() => normalizePhone('12345')).toThrow())
  it('не с 7', () => expect(() => normalizePhone('6012345678')).toThrow())
})

describe('isValidPhone', () => {
  it('валидный', () => expect(isValidPhone('87012345678')).toBe(true))
  it('мусор', () => expect(isValidPhone('abc')).toBe(false))
})
