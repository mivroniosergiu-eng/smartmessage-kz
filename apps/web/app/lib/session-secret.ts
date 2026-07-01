const DEV_SESSION_SECRET = 'dev-session-secret-at-least-32-chars-long'

export function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET ?? (process.env.NODE_ENV === 'production' ? undefined : DEV_SESSION_SECRET)

  if (!secret) {
    throw new Error('SESSION_SECRET is required')
  }

  return secret
}
