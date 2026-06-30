import crypto from 'crypto'
import { cookies } from 'next/headers'

const SECRET = process.env.SESSION_SECRET || 'dev-session-secret-at-least-32-chars-long'

/**
 * Хеширует пароль с солью с использованием PBKDF2.
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex')
  return `${salt}:${hash}`
}

/**
 * Проверяет соответствие пароля ранее сохраненному хешу.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':')
  if (parts.length !== 2) return false
  const [salt, hash] = parts
  const verifyHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex')
  return hash === verifyHash
}

/**
 * Кодирует и подписывает объект сессии в строку.
 */
export function encryptSession(payload: Record<string, any>): string {
  const data = JSON.stringify(payload)
  const hmac = crypto.createHmac('sha256', SECRET).update(data).digest('hex')
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
    const checkHmac = crypto.createHmac('sha256', SECRET).update(data).digest('hex')
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
