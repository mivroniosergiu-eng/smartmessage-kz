import { Inject, Injectable } from '@nestjs/common'
import type { Job } from '@smartmessage/queue'

import { WA_PHONE_VALIDATION_QUEUE, WA_SINGLE_SEND_QUEUE } from './wa.tokens'
import { WaPhoneValidationJobProcessor } from './wa-phone-validation-job.processor'
import { WaSingleSendJobProcessor } from './wa-single-send-job.processor'

const FAILED_JOB_SCAN_LIMIT = 1_000
const RECONCILIATION_INTERVAL_MS = 30_000

interface RetainedFailedQueue {
  getJobs(types: ['failed'], start: number, end: number, asc: boolean): Promise<Job<unknown>[]>
}

@Injectable()
export class WaTerminalFailureReconciler {
  private active?: Promise<void>
  private interval?: ReturnType<typeof setInterval>

  constructor(
    @Inject(WA_PHONE_VALIDATION_QUEUE) private readonly phoneQueue: RetainedFailedQueue,
    @Inject(WA_SINGLE_SEND_QUEUE) private readonly sendQueue: RetainedFailedQueue,
    @Inject(WaPhoneValidationJobProcessor)
    private readonly phoneProcessor: Pick<WaPhoneValidationJobProcessor, 'reconcileFailed'>,
    @Inject(WaSingleSendJobProcessor)
    private readonly sendProcessor: Pick<WaSingleSendJobProcessor, 'reconcileFailed'>,
  ) {}

  reconcile(): Promise<void> {
    if (this.active) return this.active
    const wrapped = this.run().finally(() => {
      if (this.active === wrapped) this.active = undefined
    })
    this.active = wrapped
    return wrapped
  }

  start(): void {
    if (this.interval) return
    this.interval = setInterval(() => {
      void this.reconcile().catch(() => {
        console.error('WA terminal failure reconciliation failed')
      })
    }, RECONCILIATION_INTERVAL_MS)
    this.interval.unref?.()
  }

  stop(): void {
    if (!this.interval) return
    clearInterval(this.interval)
    this.interval = undefined
  }

  private async run(): Promise<void> {
    const [phoneJobs, sendJobs] = await Promise.all([
      this.phoneQueue.getJobs(['failed'], 0, FAILED_JOB_SCAN_LIMIT - 1, true),
      this.sendQueue.getJobs(['failed'], 0, FAILED_JOB_SCAN_LIMIT - 1, true),
    ])
    const outcomes = await Promise.allSettled([
      ...phoneJobs.map((job) => this.phoneProcessor.reconcileFailed(job)),
      ...sendJobs.map((job) => this.sendProcessor.reconcileFailed(job)),
    ])
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    )
    if (rejected) throw rejected.reason
  }
}
