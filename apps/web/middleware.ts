import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getSessionSecret } from './app/lib/session-secret'
import { parseActiveSession } from './app/lib/session'

const INVALID_SESSION_PARAM = 'invalidSession'

export async function middleware(request: NextRequest) {
  const session = request.cookies.get('session')?.value
  const { pathname } = request.nextUrl
  const isSessionValid = session ? await isValidSessionToken(session) : false

  if (pathname.startsWith('/dashboard') && !isSessionValid) {
    const loginUrl = new URL('/login', request.url)
    if (session) loginUrl.searchParams.set(INVALID_SESSION_PARAM, '1')
    const response = NextResponse.redirect(loginUrl)
    if (session) response.cookies.delete('session')
    return response
  }

  if (pathname.startsWith('/login') || pathname.startsWith('/register')) {
    if (request.nextUrl.searchParams.has(INVALID_SESSION_PARAM) || (session && !isSessionValid)) {
      const response = NextResponse.next()
      response.cookies.delete('session')
      return response
    }

    if (isSessionValid) {
      return NextResponse.redirect(new URL('/dashboard', request.url))
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/dashboard/:path*', '/login', '/register'],
}

async function isValidSessionToken(token: string): Promise<boolean> {
  try {
    const parts = token.split('.')
    if (parts.length !== 2) return false

    const [dataBase64, hmac] = parts
    const dataBytes = Uint8Array.from(atob(dataBase64), (character) => character.charCodeAt(0))
    const data = new TextDecoder('utf-8', { fatal: true }).decode(dataBytes)
    const checkHmac = await signSessionData(data)
    if (!constantTimeHexEqual(checkHmac, hmac)) return false
    return parseActiveSession(JSON.parse(data)) !== null
  } catch {
    return false
  }
}

function constantTimeHexEqual(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) return false
  let difference = 0
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index)
  }
  return difference === 0
}

async function signSessionData(data: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(getSessionSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data))
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}
