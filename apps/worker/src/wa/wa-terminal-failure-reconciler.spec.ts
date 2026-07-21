import { describe, expect, it, vi } from 'vitest'

import { WaTerminalFailureReconciler } from './wa-terminal-failure-reconciler'

describe('WaTerminalFailureReconciler', () => {
  it('keeps retained failed jobs and retries their DB reconciliation after a transient outage', async () => {
    const phoneJob = { id: 'phone-failed' }
    const sendJob = { id: 'send-failed' }
    const phoneQueue = { getJobs: vi.fn(async () => [phoneJob]) }
    const sendQueue = { getJobs: vi.fn(async () => [sendJob]) }
    const phoneProcessor = {
      reconcileFailed: vi
        .fn()
        .mockRejectedValueOnce(new Error('database unavailable'))
        .mockResolvedValueOnce(undefined),
    }
    const sendProcessor = { reconcileFailed: vi.fn(async () => undefined) }
    const reconciler = new WaTerminalFailureReconciler(
      phoneQueue as never,
      sendQueue as never,
      phoneProcessor as never,
      sendProcessor as never,
    )

    await expect(reconciler.reconcile()).rejects.toThrow('database unavailable')
    await expect(reconciler.reconcile()).resolves.toBeUndefined()

    expect(phoneQueue.getJobs).toHaveBeenCalledTimes(2)
    expect(sendQueue.getJobs).toHaveBeenCalledTimes(2)
    expect(phoneProcessor.reconcileFailed).toHaveBeenCalledTimes(2)
    expect(sendProcessor.reconcileFailed).toHaveBeenCalledTimes(2)
  })

  it('serializes overlapping periodic sweeps', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const phoneQueue = { getJobs: vi.fn(async () => [{ id: 'phone-failed' }]) }
    const sendQueue = { getJobs: vi.fn(async () => []) }
    const phoneProcessor = { reconcileFailed: vi.fn(async () => blocked) }
    const sendProcessor = { reconcileFailed: vi.fn() }
    const reconciler = new WaTerminalFailureReconciler(
      phoneQueue as never,
      sendQueue as never,
      phoneProcessor as never,
      sendProcessor as never,
    )

    const first = reconciler.reconcile()
    const second = reconciler.reconcile()
    expect(second).toBe(first)
    release()
    await first
    expect(phoneQueue.getJobs).toHaveBeenCalledOnce()
  })
})
