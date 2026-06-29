import { describe, it, expect } from 'vitest'
import { spin } from './spintax'

describe('spin', () => {
  it('первый при rng=0', () => expect(spin('{привет|здравствуйте}, мир', () => 0)).toBe('привет, мир'))
  it('последний при rng->1', () => expect(spin('{a|b|c}', () => 0.99)).toBe('c'))
  it('вложенность', () => expect(spin('{a{1|1}|b}', () => 0)).toBe('a1'))
  it('без spintax', () => expect(spin('просто текст', () => 0)).toBe('просто текст'))
  it('пустые скобки', () => expect(spin('{}', () => 0)).toBe(''))
})
