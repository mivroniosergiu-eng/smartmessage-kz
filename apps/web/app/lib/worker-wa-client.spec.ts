import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { workerWaRequest } from './worker-wa-client'

const responseSchema = z.object({ queued: z.literal(true) })

describe('workerWaRequest', () => {
  beforeEach(() => {
    vi.stubEnv('WORKER_INTERNAL_API_URL', 'http://worker.test:3001')
    vi.stubEnv('WORKER_INTERNAL_API_TOKEN', 'test-worker-token')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('sends the internal authorization header and applies the bounded timeout', async () => {
    const signal = new AbortController().signal
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal)
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify({ queued: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      workerWaRequest('/internal/wa/test', { method: 'POST', body: '{}' }, responseSchema),
    ).resolves.toEqual({ queued: true })

    expect(timeout).toHaveBeenCalledWith(10_000)
    const [, init] = fetchMock.mock.calls[0]
    const headers = new Headers(init?.headers)
    expect(headers.get('x-internal-worker-token')).toBe('test-worker-token')
    expect(headers.get('content-type')).toBe('application/json')
    expect(init?.signal).toBe(signal)
    expect(init?.cache).toBe('no-store')
  })

  it('maps worker authorization failures to a safe client error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 })),
    )

    const request = workerWaRequest('/internal/wa/test', { method: 'GET' }, responseSchema)

    await expect(request).rejects.toMatchObject({
      kind: 'response',
      message: 'WhatsApp worker authorization failed',
    })
  })

  it('rejects a successful response that violates the boundary schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ queued: false }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )

    await expect(
      workerWaRequest('/internal/wa/test', { method: 'GET' }, responseSchema),
    ).rejects.toMatchObject({
      kind: 'response',
      message: 'WhatsApp worker returned an invalid response',
    })
  })
})
