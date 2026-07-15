export type WaConnectionStatus =
  'idle' | 'connecting' | 'connected' | 'disconnected' | 'logged_out' | 'banned' | 'restricted'

export type WaDisconnectReason =
  'transient' | 'restart_required' | 'connection_closed' | 'logged_out' | 'banned' | 'restricted'

export interface SessionState {
  instanceId: string
  status: WaConnectionStatus
  hasAuthState: boolean
  logoutCount: number
  lastDisconnectReason?: WaDisconnectReason
  restrictedUntil?: Date
}

export interface SessionManager {
  getState(instanceId: string): Promise<SessionState>
  connect(instanceId: string): Promise<SessionState>
  closeTransport(instanceId: string): Promise<SessionState>
  handleDisconnect(
    instanceId: string,
    reason: WaDisconnectReason,
    restrictedUntil?: Date,
  ): Promise<SessionState>
  logout(instanceId: string): Promise<SessionState>
}

export class MockSessionManager implements SessionManager {
  private readonly sessions = new Map<string, SessionState>()

  async getState(instanceId: string): Promise<SessionState> {
    return this.clone(this.ensureSession(instanceId))
  }

  async connect(instanceId: string): Promise<SessionState> {
    const state = this.ensureSession(instanceId)
    const next: SessionState = {
      ...state,
      status: 'connected',
      hasAuthState: true,
      lastDisconnectReason: undefined,
    }
    this.sessions.set(instanceId, next)
    return this.clone(next)
  }

  async closeTransport(instanceId: string): Promise<SessionState> {
    const state = this.ensureSession(instanceId)
    if (state.status === 'banned' || state.status === 'restricted') {
      return this.clone(state)
    }
    const next: SessionState = {
      ...state,
      status: 'disconnected',
      hasAuthState: state.hasAuthState,
      lastDisconnectReason: 'connection_closed',
    }
    this.sessions.set(instanceId, next)
    return this.clone(next)
  }

  async handleDisconnect(
    instanceId: string,
    reason: WaDisconnectReason,
    restrictedUntil?: Date,
  ): Promise<SessionState> {
    if (reason === 'logged_out') return this.logout(instanceId)

    const state = this.ensureSession(instanceId)
    const next: SessionState = {
      ...state,
      status: statusFromDisconnect(reason),
      hasAuthState: true,
      lastDisconnectReason: reason,
      restrictedUntil:
        reason === 'restricted' ? normalizeRestrictedUntil(restrictedUntil) : undefined,
    }
    this.sessions.set(instanceId, next)
    return this.clone(next)
  }

  async logout(instanceId: string): Promise<SessionState> {
    const state = this.ensureSession(instanceId)
    if (state.status === 'banned') {
      const banned = {
        ...state,
        hasAuthState: false,
        logoutCount: state.logoutCount + 1,
      }
      this.sessions.set(instanceId, banned)
      return this.clone(banned)
    }
    const next: SessionState = {
      ...state,
      status: 'logged_out',
      hasAuthState: false,
      logoutCount: state.logoutCount + 1,
      lastDisconnectReason: 'logged_out',
      restrictedUntil: undefined,
    }
    this.sessions.set(instanceId, next)
    return this.clone(next)
  }

  seed(state: SessionState): void {
    this.sessions.set(state.instanceId, this.clone(state))
  }

  private ensureSession(instanceId: string): SessionState {
    const existing = this.sessions.get(instanceId)
    if (existing) return existing

    const created: SessionState = {
      instanceId,
      status: 'idle',
      hasAuthState: false,
      logoutCount: 0,
    }
    this.sessions.set(instanceId, created)
    return created
  }

  private clone(state: SessionState): SessionState {
    return {
      ...state,
      restrictedUntil: state.restrictedUntil ? new Date(state.restrictedUntil) : undefined,
    }
  }
}

export const DEFAULT_WA_RESTRICTION_MS = 60 * 60 * 1_000
export const MIN_WA_RESTRICTION_MS = 60 * 1_000
export const MAX_WA_RESTRICTION_MS = 7 * 24 * 60 * 60 * 1_000

export function createWaRestrictedUntil(now: Date, retryAfterMs?: number): Date {
  const nowMs = normalizeDate(now, 'now').getTime()
  const durationMs =
    retryAfterMs === undefined
      ? DEFAULT_WA_RESTRICTION_MS
      : Math.min(
          MAX_WA_RESTRICTION_MS,
          Math.max(MIN_WA_RESTRICTION_MS, normalizeDuration(retryAfterMs)),
        )
  return new Date(nowMs + durationMs)
}

function normalizeRestrictedUntil(value: Date | undefined): Date {
  return value ? normalizeDate(value, 'restrictedUntil') : createWaRestrictedUntil(new Date())
}

function normalizeDate(value: Date, fieldName: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${fieldName} must be a valid Date`)
  }
  return new Date(value)
}

function normalizeDuration(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError('retryAfterMs must be positive')
  }
  return Math.round(value)
}

function statusFromDisconnect(
  reason: Exclude<WaDisconnectReason, 'logged_out'>,
): WaConnectionStatus {
  if (reason === 'banned') return 'banned'
  if (reason === 'restricted') return 'restricted'
  return 'disconnected'
}
