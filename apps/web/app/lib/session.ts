export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7

export interface SessionData {
  userId: string
  email: string
  teamId: string
  role: 'OWNER' | 'ADMIN' | 'MEMBER'
}

export interface SessionCodecOptions {
  nowMs?: number
  ttlSeconds?: number
}

interface SessionClaims extends SessionData {
  iat: number
  exp: number
}

export function createSessionClaims(
  payload: SessionData,
  options: SessionCodecOptions = {},
): SessionClaims {
  const issuedAt = toEpochSeconds(options.nowMs ?? Date.now())
  const ttlSeconds = options.ttlSeconds ?? SESSION_TTL_SECONDS
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new RangeError('Session TTL must be a positive safe integer')
  }

  return { ...payload, iat: issuedAt, exp: issuedAt + ttlSeconds }
}

export function parseActiveSession(value: unknown, nowMs = Date.now()): SessionData | null {
  if (!isRecord(value)) return null
  const { userId, email, teamId, role, iat, exp } = value
  if (
    !isNonEmptyString(userId) ||
    !isNonEmptyString(email) ||
    !isNonEmptyString(teamId) ||
    !isSessionRole(role) ||
    !Number.isSafeInteger(iat) ||
    !Number.isSafeInteger(exp) ||
    (exp as number) <= (iat as number) ||
    toEpochSeconds(nowMs) >= (exp as number)
  ) {
    return null
  }

  return { userId, email, teamId, role }
}

function toEpochSeconds(nowMs: number): number {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new RangeError('Invalid session clock')
  return Math.floor(nowMs / 1_000)
}

function isSessionRole(value: unknown): value is SessionData['role'] {
  return value === 'OWNER' || value === 'ADMIN' || value === 'MEMBER'
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
