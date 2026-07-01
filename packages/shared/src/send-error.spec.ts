import { describe, it, expect } from 'vitest'
import { classifySendError, isRetryable } from './send-error'

describe('classifySendError', () => {
  it('rate_limit msg', () => expect(classifySendError('Too many requests')).toBe('rate_limit'))
  it('rate_limit 429', () => expect(classifySendError({ statusCode: 429 })).toBe('rate_limit'))
  it('auth logged out', () => expect(classifySendError(new Error('Connection logged out'))).toBe('auth_terminal'))
  it('auth 401', () => expect(classifySendError({ code: 401 })).toBe('auth_terminal'))
  it('invalid recipient', () => expect(classifySendError('number not registered on whatsapp')).toBe('invalid_recipient'))
  it('transient', () => expect(classifySendError(new Error('Bad MAC, session_error'))).toBe('transient'))
  it('unknown', () => {
    expect(classifySendError(null)).toBe('unknown')
    expect(classifySendError({})).toBe('unknown')
  })
})

describe('isRetryable', () => {
  it('повторяемы', () => {
    expect(isRetryable('transient')).toBe(true)
    expect(isRetryable('rate_limit')).toBe(true)
  })
  it('терминальные нет', () => {
    expect(isRetryable('auth_terminal')).toBe(false)
    expect(isRetryable('invalid_recipient')).toBe(false)
    expect(isRetryable('unknown')).toBe(false)
  })
})
