export type WaConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'logged_out'
  | 'banned'
  | 'restricted'

export type WaDisconnectReason =
  | 'transient'
  | 'restart_required'
  | 'connection_closed'
  | 'logged_out'
  | 'banned'
  | 'restricted'

export interface SessionState {
  instanceId: string
  status: WaConnectionStatus
  hasAuthState: boolean
  logoutCount: number
  lastDisconnectReason?: WaDisconnectReason
}

export interface SessionManager {
  getState(instanceId: string): Promise<SessionState>
  connect(instanceId: string): Promise<SessionState>
  handleDisconnect(instanceId: string, reason: WaDisconnectReason): Promise<SessionState>
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

  async handleDisconnect(instanceId: string, reason: WaDisconnectReason): Promise<SessionState> {
    if (reason === 'logged_out') return this.logout(instanceId)

    const state = this.ensureSession(instanceId)
    const next: SessionState = {
      ...state,
      status: statusFromDisconnect(reason),
      hasAuthState: true,
      lastDisconnectReason: reason,
    }
    this.sessions.set(instanceId, next)
    return this.clone(next)
  }

  async logout(instanceId: string): Promise<SessionState> {
    const state = this.ensureSession(instanceId)
    const next: SessionState = {
      ...state,
      status: 'logged_out',
      hasAuthState: false,
      logoutCount: state.logoutCount + 1,
      lastDisconnectReason: 'logged_out',
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
    return { ...state }
  }
}

function statusFromDisconnect(reason: Exclude<WaDisconnectReason, 'logged_out'>): WaConnectionStatus {
  if (reason === 'banned') return 'banned'
  if (reason === 'restricted') return 'restricted'
  return 'disconnected'
}
