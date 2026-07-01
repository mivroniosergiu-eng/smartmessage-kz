import { describe, it, expect } from 'vitest'
import { renderTemplate } from './template'

describe('renderTemplate', () => {
  it('подстановка', () => expect(renderTemplate('Привет, {{name}}!', { name: 'Ержан' })).toBe('Привет, Ержан!'))
  it('число', () => expect(renderTemplate('Скидка {{pct}}%', { pct: 20 })).toBe('Скидка 20%'))
  it('отсутствует', () => expect(() => renderTemplate('{{missing}}', {})).toThrow(/missing template/))
})
