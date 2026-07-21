import { describe, expect, it, vi } from 'vitest'

import {
  WaWorkerIdentityLossGate,
  WaWorkerIdentityLossSupervisor,
} from './wa-worker-identity-supervisor'

describe('WaWorkerIdentityLossGate', () => {
  it('fails construction closed when identity was lost before the supervisor binds', async () => {
    const gate = new WaWorkerIdentityLossGate()
    const loss = new Error('identity lost during startup')

    await gate.report(loss)

    expect(() => gate.assertHealthy()).toThrow(loss)
    const handler = vi.fn(async () => undefined)
    await gate.bind(handler)
    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(loss)
  })

  it('reports only the first identity loss to a bound supervisor', async () => {
    const gate = new WaWorkerIdentityLossGate()
    const handler = vi.fn(async () => undefined)
    await gate.bind(handler)

    const first = new Error('first')
    await gate.report(first)
    await gate.report(new Error('duplicate'))

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(first)
    expect(() => gate.assertHealthy()).toThrow(first)
  })
})

describe('WaWorkerIdentityLossSupervisor', () => {
  it('fails closed once in intake → sessions → workers → terminate order', async () => {
    const events: string[] = []
    const sharedWorker = createWorker('shared', events)
    const ownerWorker = createWorker('owner', events)
    const lifecycle = {
      shutdownAll: vi.fn(async () => {
        events.push('sessions')
      }),
    }
    const terminate = vi.fn((error: Error) => {
      events.push(`terminate:${error.message}`)
    })
    const supervisor = new WaWorkerIdentityLossSupervisor(
      sharedWorker,
      ownerWorker,
      lifecycle,
      terminate,
    )
    const loss = new Error('identity lost')

    const first = supervisor.reportLoss(loss)
    const second = supervisor.reportLoss(new Error('duplicate'))
    await Promise.all([first, second])

    expect(events).toEqual([
      'pause:shared:true',
      'pause:owner:true',
      'sessions',
      'close:shared:true',
      'close:owner:true',
      'terminate:identity lost',
    ])
    expect(lifecycle.shutdownAll).toHaveBeenCalledOnce()
    expect(terminate).toHaveBeenCalledOnce()
    expect(terminate).toHaveBeenCalledWith(loss)
  })

  it('also stops registered command consumers before terminating', async () => {
    const events: string[] = []
    const sharedWorker = createWorker('shared', events)
    const ownerWorker = createWorker('owner', events)
    const validationWorker = createWorker('validation', events)
    const lifecycle = { shutdownAll: vi.fn(async () => events.push('sessions')) }
    const supervisor = new WaWorkerIdentityLossSupervisor(
      sharedWorker,
      ownerWorker,
      lifecycle,
      vi.fn(() => events.push('terminate')),
    ).addIntakeWorkers(validationWorker)

    await supervisor.reportLoss(new Error('identity lost'))

    expect(events).toEqual([
      'pause:shared:true',
      'pause:owner:true',
      'pause:validation:true',
      'sessions',
      'close:shared:true',
      'close:owner:true',
      'close:validation:true',
      'terminate',
    ])
  })

  it('does not let a never-settling pause delay session shutdown or forced worker close', async () => {
    const events: string[] = []
    const never = new Promise<void>(() => undefined)
    const sharedWorker = createWorker('shared', events)
    const ownerWorker = createWorker('owner', events)
    sharedWorker.pause.mockImplementation(() => {
      events.push('pause:shared:true')
      return never
    })
    ownerWorker.pause.mockImplementation(() => {
      events.push('pause:owner:true')
      return never
    })
    const lifecycle = {
      shutdownAll: vi.fn(async () => {
        events.push('sessions')
      }),
    }
    const terminate = vi.fn(() => {
      events.push('terminate')
    })
    const supervisor = new WaWorkerIdentityLossSupervisor(
      sharedWorker,
      ownerWorker,
      lifecycle,
      terminate,
    )
    await supervisor.reportLoss(new Error('redis unavailable'))

    expect(events).toEqual([
      'pause:shared:true',
      'pause:owner:true',
      'sessions',
      'close:shared:true',
      'close:owner:true',
      'terminate',
    ])
  })

  it('terminates after bounded grace even when lifecycle and forced worker close never settle', async () => {
    vi.useFakeTimers()
    try {
      const events: string[] = []
      const never = new Promise<void>(() => undefined)
      const sharedWorker = createWorker('shared', events)
      const ownerWorker = createWorker('owner', events)
      sharedWorker.close.mockImplementation(() => never)
      ownerWorker.close.mockImplementation(() => never)
      const lifecycle = { shutdownAll: vi.fn(() => never) }
      const terminate = vi.fn(() => {
        events.push('terminate')
      })
      const supervisor = new WaWorkerIdentityLossSupervisor(
        sharedWorker,
        ownerWorker,
        lifecycle,
        terminate,
      )
      const loss = supervisor.reportLoss(new Error('redis unavailable'))
      await vi.advanceTimersByTimeAsync(6_000)
      await loss

      expect(lifecycle.shutdownAll).toHaveBeenCalledOnce()
      expect(sharedWorker.close).toHaveBeenCalledWith(true)
      expect(ownerWorker.close).toHaveBeenCalledWith(true)
      expect(terminate).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})

function createWorker(name: string, events: string[]) {
  return {
    pause: vi.fn(async (doNotWaitActive?: boolean) => {
      events.push(`pause:${name}:${String(doNotWaitActive)}`)
    }),
    close: vi.fn(async (force?: boolean) => {
      events.push(`close:${name}:${String(force)}`)
    }),
  }
}
