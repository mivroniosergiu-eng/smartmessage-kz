import { describe, it, expect } from 'vitest'
import { GET } from './route'

describe('GET /health', () => {
  it('возвращает status ok', async () => {
    const res = GET()
    const body = await res.json()
    expect(body).toEqual({ status: 'ok', service: 'web' })
  })
})
