import { Inject, Injectable } from '@nestjs/common'
import {
  SEND_WA_TEXT_JOB_NAME,
  WA_SINGLE_SEND_OWNER_QUEUE_PREFIX,
  WA_SINGLE_SEND_QUEUE_NAME,
  createWaSingleSendOwnerQueueName,
  parseWaSingleSendJobPayload,
  parseWaSingleSendOwnerJobPayload,
} from '@smartmessage/queue'
import type { Job, WaSingleSendOwnerJobPayload } from '@smartmessage/queue'
import {
  classifySendError,
  createWaRestrictedUntil,
  isRetryable,
  type MessageSender,
  type OwnerRegistry,
  type SessionManager,
  type WaOwnership,
} from '@smartmessage/wa'

import { PrismaWaSingleSendRepository } from './prisma-wa-single-send.repository'
import { WaSingleSendQueueService } from './wa-single-send-queue.service'
import { WA_MESSAGE_SENDER, WA_OWNER_REGISTRY, WA_SESSION_MANAGER, WA_WORKER_ID } from './wa.tokens'

export interface WaSingleSendJobResult {
  messageLogId: string
  status: 'sent' | 'failed' | 'ownership_stale' | 'delivery_ambiguous'
  providerMessageId?: string
  terminalSkipped?: true
}

export class WaSingleSendAcceptedPersistenceError extends Error {
  override readonly cause: unknown

  constructor(
    readonly messageLogId: string,
    cause: unknown,
  ) {
    super(`WA single-send was accepted but SENT persistence failed: ${messageLogId}`)
    this.name = 'WaSingleSendAcceptedPersistenceError'
    this.cause = cause
  }
}

export class WaSingleSendDispatchAmbiguousError extends Error {
  override readonly cause: unknown

  constructor(
    readonly messageLogId: string,
    cause: unknown,
  ) {
    super(`WA single-send dispatch is ambiguous and requires reconciliation: ${messageLogId}`)
    this.name = 'WaSingleSendDispatchAmbiguousError'
    this.cause = cause
  }
}

class WaSingleSendOwnerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WaSingleSendOwnerUnavailableError'
  }
}

@Injectable()
export class WaSingleSendJobProcessor {
  constructor(
    @Inject(PrismaWaSingleSendRepository)
    private readonly repository: PrismaWaSingleSendRepository,
    @Inject(WaSingleSendQueueService)
    private readonly queueService: WaSingleSendQueueService,
    @Inject(WA_MESSAGE_SENDER) private readonly sender: MessageSender,
    @Inject(WA_OWNER_REGISTRY) private readonly registry: Pick<OwnerRegistry, 'getOwnership'>,
    @Inject(WA_SESSION_MANAGER)
    private readonly sessionManager: Pick<SessionManager, 'handleDisconnect'>,
    @Inject(WA_WORKER_ID) private readonly workerId: string,
  ) {}

  async process(
    job: Pick<Job<unknown>, 'name' | 'data'> &
      Partial<Pick<Job<unknown>, 'queueName' | 'attemptsMade' | 'opts' | 'discard'>>,
  ): Promise<WaSingleSendJobResult> {
    if (job.name !== SEND_WA_TEXT_JOB_NAME)
      throw new TypeError(`Unsupported WA single-send job: ${job.name}`)
    const queueName = job.queueName ?? WA_SINGLE_SEND_QUEUE_NAME
    if (queueName === WA_SINGLE_SEND_QUEUE_NAME) return this.processGeneric(job)
    if (!queueName.startsWith(WA_SINGLE_SEND_OWNER_QUEUE_PREFIX))
      throw new TypeError(`Unsupported WA single-send queue: ${queueName}`)
    return this.processOwner(job.data, queueName)
  }

  async handleFailed(
    job: Pick<Job<unknown>, 'name' | 'data' | 'attemptsMade' | 'opts'> &
      Partial<Pick<Job<unknown>, 'queueName' | 'remove'>>,
    error: Error,
  ): Promise<void> {
    if (
      job.name !== SEND_WA_TEXT_JOB_NAME ||
      (job.queueName ?? WA_SINGLE_SEND_QUEUE_NAME) !== WA_SINGLE_SEND_QUEUE_NAME ||
      (!isFinalAttempt(job) && !/stalled/i.test(error.message))
    )
      return
    if (isAmbiguousDeliveryError(error)) return
    await this.reconcileFailed({ ...job, failedReason: error.message })
  }

  async reconcileFailed(
    job: Pick<Job<unknown>, 'name' | 'data'> &
      Partial<Pick<Job<unknown>, 'queueName' | 'failedReason' | 'remove'>>,
  ): Promise<void> {
    if (
      job.name !== SEND_WA_TEXT_JOB_NAME ||
      (job.queueName ?? WA_SINGLE_SEND_QUEUE_NAME) !== WA_SINGLE_SEND_QUEUE_NAME ||
      isAmbiguousFailureReason(job.failedReason)
    ) {
      return
    }
    await this.repository.markRequestFailed(parseWaSingleSendJobPayload(job.data))
    await job.remove?.()
  }

  private async processGeneric(
    job: Pick<Job<unknown>, 'data'> &
      Partial<Pick<Job<unknown>, 'attemptsMade' | 'opts' | 'discard'>>,
  ): Promise<WaSingleSendJobResult> {
    const payload = parseWaSingleSendJobPayload(job.data)
    const prepared = await this.repository.prepare(payload)
    if (prepared.terminalStatus) {
      return {
        messageLogId: prepared.messageLogId,
        status: prepared.terminalStatus,
        ...(prepared.providerMessageId ? { providerMessageId: prepared.providerMessageId } : {}),
        terminalSkipped: true,
      }
    }
    if (prepared.deliveryAmbiguous) {
      return {
        messageLogId: prepared.messageLogId,
        status: 'delivery_ambiguous',
        terminalSkipped: true,
      }
    }
    if (!prepared.ownerWorkerId || !prepared.ownershipEpoch) {
      throw new WaSingleSendOwnerUnavailableError('WA single-send owner is unavailable')
    }
    try {
      const ownership = await this.registry.getOwnership(prepared.instanceId)
      if (
        ownership?.owner !== prepared.ownerWorkerId ||
        ownership.epoch !== prepared.ownershipEpoch
      ) {
        throw new WaSingleSendOwnerUnavailableError('WA single-send owner is unavailable')
      }
      const ownerPayload: WaSingleSendOwnerJobPayload = {
        ...payload,
        messageLogId: prepared.messageLogId,
        teamId: prepared.teamId,
        phone: prepared.phone,
        expectedOwnerWorkerId: ownership.owner,
        expectedOwnerEpoch: ownership.epoch.toString(),
      }
      const result = parseOwnerResult(
        prepared.messageLogId,
        await this.queueService.enqueueForOwner(ownerPayload),
      )
      if (result.status === 'ownership_stale') {
        throw new WaSingleSendOwnerUnavailableError('WA single-send owner became stale')
      }
      if (result.status === 'delivery_ambiguous') return result
      return result
    } catch (error) {
      if (isAmbiguousDeliveryError(error)) throw error
      const retryable =
        error instanceof WaSingleSendOwnerUnavailableError || isRetryable(classifySendError(error))
      if (!retryable) {
        job.discard?.()
        await this.repository.markFailed(prepared.messageLogId)
      } else if (isFinalAttempt(job)) {
        await this.repository.markFailed(prepared.messageLogId)
      }
      throw error
    }
  }

  private async processOwner(raw: unknown, queueName: string): Promise<WaSingleSendJobResult> {
    const payload = parseWaSingleSendOwnerJobPayload(raw)
    if (
      queueName !== createWaSingleSendOwnerQueueName(payload.expectedOwnerWorkerId) ||
      this.workerId !== payload.expectedOwnerWorkerId
    ) {
      throw new TypeError(`WA single-send owner job is on the wrong queue: ${queueName}`)
    }
    const expected = {
      owner: payload.expectedOwnerWorkerId,
      epoch: BigInt(payload.expectedOwnerEpoch),
    }
    if (!sameOwnership(await this.registry.getOwnership(payload.instanceId), expected))
      return stale(payload.messageLogId)
    await this.repository.assertOwnerTarget(payload)
    if (!(await this.repository.claimDispatch(payload.messageLogId))) {
      return ambiguous(payload.messageLogId)
    }
    let result: Awaited<ReturnType<MessageSender['send']>>
    try {
      result = await this.sender.send({
        instanceId: payload.instanceId,
        recipientPhone: payload.phone,
        kind: 'text',
        text: payload.text,
        idempotencyKey: payload.idempotencyKey,
      })
    } catch (error) {
      const classification = classifySendError(error)
      if (classification === 'banned') {
        await this.sessionManager.handleDisconnect(payload.instanceId, 'banned')
      } else if (classification === 'restricted') {
        await this.sessionManager.handleDisconnect(
          payload.instanceId,
          'restricted',
          createWaRestrictedUntil(new Date()),
        )
      } else if (classification === 'auth_terminal') {
        await this.sessionManager.handleDisconnect(payload.instanceId, 'logged_out')
      }
      throw new WaSingleSendDispatchAmbiguousError(payload.messageLogId, error)
    }
    if (result.status !== 'accepted' || !result.messageId.trim()) {
      throw new WaSingleSendDispatchAmbiguousError(
        payload.messageLogId,
        new TypeError('Invalid WA sender result'),
      )
    }
    try {
      await this.repository.markSent(payload.messageLogId, result.messageId)
    } catch (error) {
      throw new WaSingleSendAcceptedPersistenceError(payload.messageLogId, error)
    }
    return {
      messageLogId: payload.messageLogId,
      status: 'sent',
      providerMessageId: result.messageId,
    }
  }
}

function stale(messageLogId: string): WaSingleSendJobResult {
  return { messageLogId, status: 'ownership_stale' }
}
function ambiguous(messageLogId: string): WaSingleSendJobResult {
  return { messageLogId, status: 'delivery_ambiguous' }
}
function sameOwnership(actual: WaOwnership | null, expected: WaOwnership): boolean {
  return actual?.owner === expected.owner && actual.epoch === expected.epoch
}
function parseOwnerResult(
  messageLogId: string,
  value: unknown,
): WaSingleSendJobResult & { providerMessageId: string } {
  if (
    !isRecord(value) ||
    value.messageLogId !== messageLogId ||
    value.status !== 'sent' ||
    typeof value.providerMessageId !== 'string' ||
    !value.providerMessageId.trim()
  ) {
    if (
      isRecord(value) &&
      value.messageLogId === messageLogId &&
      (value.status === 'ownership_stale' || value.status === 'delivery_ambiguous')
    )
      return value as never
    throw new TypeError(`Invalid WA single-send owner result: ${messageLogId}`)
  }
  return { messageLogId, status: 'sent', providerMessageId: value.providerMessageId }
}
function isFinalAttempt(job: Partial<Pick<Job<unknown>, 'attemptsMade' | 'opts'>>): boolean {
  return (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1)
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAmbiguousDeliveryError(error: unknown): boolean {
  return (
    error instanceof WaSingleSendAcceptedPersistenceError ||
    error instanceof WaSingleSendDispatchAmbiguousError ||
    (error instanceof Error && isAmbiguousFailureReason(error.message))
  )
}

function isAmbiguousFailureReason(reason: unknown): boolean {
  return (
    typeof reason === 'string' &&
    /owner acknowledgement timed out|dispatch is ambiguous|was accepted but SENT persistence failed/i.test(
      reason,
    )
  )
}
