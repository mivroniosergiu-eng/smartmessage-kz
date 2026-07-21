import { describe, expect, it } from 'vitest'

import { normalizeSingleSearchParam } from './search-param'

describe('normalizeSingleSearchParam', () => {
  it('preserves a scalar query parameter', () => {
    expect(normalizeSingleSearchParam('message')).toBe('message')
  })

  it('rejects repeated query parameters', () => {
    expect(normalizeSingleSearchParam(['first', 'second'])).toBeUndefined()
  })
})
