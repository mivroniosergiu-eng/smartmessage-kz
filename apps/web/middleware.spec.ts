import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { encryptSession } from './app/lib/auth'
import { middleware } from './middleware'

function request(path: string, session?: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: session ? { cookie: `session=${session}` } : undefined,
  })
}

describe('middleware session guard', () => {
  it('redirects dashboard requests without a session to login', async () => {
    const response = await middleware(request('/dashboard'))

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost/login')
  })

  it('does not redirect auth pages for malformed session cookies', async () => {
    const response = await middleware(request('/login', 'not-a-valid-session'))

    expect(response.headers.get('location')).toBeNull()
    expect(response.cookies.get('session')?.value).toBe('')
  })

  it('redirects auth pages only when the session cookie is valid', async () => {
    const token = encryptSession({
      userId: 'user-1',
      email: 'owner@example.com',
      teamId: 'team-1',
      role: 'OWNER',
    })

    const response = await middleware(request('/login', token))

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost/dashboard')
  })
})
