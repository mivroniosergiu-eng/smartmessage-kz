export interface WaWorkerIdentityIntakePort {
  pause?(doNotWaitActive?: boolean): Promise<void>
  close(force?: boolean): Promise<void>
}

export interface WaWorkerIdentityLifecyclePort {
  shutdownAll(): Promise<void>
}

export type WaWorkerIdentityFatalHandler = (error: Error) => void | Promise<void>
export type WaWorkerIdentityLossHandler = (error: Error) => void | Promise<void>

const IDENTITY_LOSS_LIFECYCLE_GRACE_MS = 5_000
const IDENTITY_LOSS_WORKER_CLOSE_GRACE_MS = 1_000

export class WaWorkerIdentityLossGate {
  private handler?: WaWorkerIdentityLossHandler
  private loss?: Error
  private lossHandling?: Promise<void>

  assertHealthy(): void {
    if (this.loss) throw this.loss
  }

  bind(handler: WaWorkerIdentityLossHandler): Promise<void> {
    this.handler = handler
    return this.dispatch()
  }

  report(error: Error): Promise<void> {
    if (!this.loss) this.loss = error
    return this.dispatch()
  }

  private dispatch(): Promise<void> {
    if (!this.handler || !this.loss) return Promise.resolve()
    if (!this.lossHandling) this.lossHandling = Promise.resolve(this.handler(this.loss))
    return this.lossHandling
  }
}

export class WaWorkerIdentityLossSupervisor {
  private lossShutdown?: Promise<void>

  constructor(
    private readonly lifecycleWorker: WaWorkerIdentityIntakePort,
    private readonly ownerLifecycleWorker: WaWorkerIdentityIntakePort,
    private readonly lifecycle: WaWorkerIdentityLifecyclePort,
    private readonly terminate: WaWorkerIdentityFatalHandler,
  ) {}

  reportLoss(error: Error): Promise<void> {
    if (this.lossShutdown) return this.lossShutdown

    const shutdown = this.failClosed(error)
    this.lossShutdown = shutdown
    return shutdown
  }

  private async failClosed(error: Error): Promise<void> {
    this.pauseWithoutWaiting(this.lifecycleWorker)
    this.pauseWithoutWaiting(this.ownerLifecycleWorker)

    await settleWithin(
      invokeSafely(() => this.lifecycle.shutdownAll()),
      IDENTITY_LOSS_LIFECYCLE_GRACE_MS,
    )
    await settleWithin(
      Promise.allSettled([
        invokeSafely(() => this.lifecycleWorker.close(true)),
        invokeSafely(() => this.ownerLifecycleWorker.close(true)),
      ]).then(() => undefined),
      IDENTITY_LOSS_WORKER_CLOSE_GRACE_MS,
    )
    await this.terminate(error)
  }

  private pauseWithoutWaiting(worker: WaWorkerIdentityIntakePort): void {
    try {
      void worker.pause?.(true).catch(() => undefined)
    } catch {
      // A synchronous pause failure cannot delay physical session shutdown.
    }
  }
}

function invokeSafely(operation: () => Promise<void>): Promise<void> {
  try {
    return operation()
  } catch (error: unknown) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

async function settleWithin(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const boundedOperation = operation.catch(() => undefined)
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, timeoutMs)
    timeout.unref?.()
  })

  await Promise.race([boundedOperation, deadline])
  if (timeout !== undefined) clearTimeout(timeout)
}
