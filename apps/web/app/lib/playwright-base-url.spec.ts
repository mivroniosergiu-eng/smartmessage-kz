import { describe, expect, it } from 'vitest'

import { resolvePlaywrightWebServerPort } from './playwright-base-url'

describe('resolvePlaywrightWebServerPort', () => {
  it('returns an explicit HTTP port', () => {
    expect(resolvePlaywrightWebServerPort('http://127.0.0.1:3191')).toBe('3191')
  })

  it.each([
    'https://127.0.0.1:3191',
    'http://127.0.0.1',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
  ])('rejects an unsupported base URL: %s', (baseURL) => {
    expect(() => resolvePlaywrightWebServerPort(baseURL)).toThrow(
      'PLAYWRIGHT_BASE_URL must use http with an explicit port from 1 to 65535',
    )
  })
})
