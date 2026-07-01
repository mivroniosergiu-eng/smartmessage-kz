import crypto from 'crypto'
import { cookies } from 'next/headers'
import { getSessionSecret } from './session-secret'

const PASSWORD_ALGORITHM = 'pbkdf2'
const PASSWORD_DIGEST = 'sha512'
const PASSWORD_ITERATIONS = 210000
const PASSWORD_KEY_LENGTH = 64
const LEGACY_PASSWORD_ITERATIONS = 1000

/**
 * Хеширует пароль с солью с использованием PBKDF2.
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto
    .pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, PASSWORD_KEY_LENGTH, PASSWORD_DIGEST)
    .toString('hex')
  return `${PASSWORD_ALGORITHM}:${PASSWORD_DIGEST}:${PASSWORD_ITERATIONS}:${salt}:${hash}`
}

/**
 * Проверяет соответствие пароля ранее сохраненному хешу.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':')
  if (parts.length === 5) {
    const [algorithm, digest, iterationsValue, salt, hash] = parts
    const iterations = Number(iterationsValue)
    if (algorithm !== PASSWORD_ALGORITHM || digest !== PASSWORD_DIGEST || !Number.isInteger(iterations)) return false
    return verifyDerivedKey(password, salt, iterations, PASSWORD_KEY_LENGTH, digest, hash)
  }

  if (parts.length === 2) {
    const [salt, hash] = parts
    return verifyDerivedKey(password, salt, LEGACY_PASSWORD_ITERATIONS, PASSWORD_KEY_LENGTH, PASSWORD_DIGEST, hash)
  }

  return false
}

/**
 * Кодирует и подписывает объект сессии в строку.
 */
export function encryptSession(payload: Record<string, any>): string {
  const data = JSON.stringify(payload)
  const hmac = crypto.createHmac('sha256', getSessionSecret()).update(data).digest('hex')
  return Buffer.from(data).toString('base64') + '.' + hmac
}

/**
 * Декодирует строку сессии и проверяет подпись HMAC.
 */
export function decryptSession(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 2) return null
    const [dataBase64, hmac] = parts
    const data = Buffer.from(dataBase64, 'base64').toString('utf-8')
    const checkHmac = crypto.createHmac('sha256', getSessionSecret()).update(data).digest('hex')
    if (checkHmac !== hmac) return null
    return JSON.parse(data)
  } catch {
    return null
  }
}

export interface SessionData {
  userId: string
  email: string
  teamId: string
  role: string
}

/**
 * Возвращает данные текущей сессии из кук.
 */
export async function getSession(): Promise<SessionData | null> {
  const cookieStore = cookies()
  const sessionCookie = cookieStore.get('session')
  if (!sessionCookie) return null
  return decryptSession(sessionCookie.value) as SessionData | null
}

function verifyDerivedKey(
  password: string,
  salt: string,
  iterations: number,
  keyLength: number,
  digest: string,
  expectedHash: string,
): boolean {
  try {
    const verifyHash = crypto.pbkdf2Sync(password, salt, iterations, keyLength, digest).toString('hex')
    const expected = Buffer.from(expectedHash, 'hex')
    const actual = Buffer.from(verifyHash, 'hex')
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}
