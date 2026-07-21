import { Inject, Injectable } from '@nestjs/common'
import {
  LOGOUT_WA_INSTANCE_JOB_NAME,
  RECOVER_RESTRICTED_WA_INSTANCE_JOB_NAME,
  RENEW_WA_INSTANCE_JOB_NAME,
  START_WA_INSTANCE_JOB_NAME,
  STOP_WA_INSTANCE_JOB_NAME,
  WA_LIFECYCLE_OWNER_QUEUE_PREFIX,
  WA_LIFECYCLE_QUEUE_NAME,
  createWaLifecycleOwnerQueueName,
  parseRecoverRestrictedWaInstanceJobPayload,
  parseWaLifecycleOwnerCommandJobPayload,
  parseWaLifecycleInstanceJobPayload,
} from '@smartmessage/queue'
import type { Job } from '@smartmessage/queue'
import type { OwnerRegistry, SessionState, WaOwnership } from '@smartmessage/wa'

import { WaLifecycleCommandService } from './wa-lifecycle-command.service'
import { WaLifecycleQueueService } from './wa-lifecycle-queue.service'
import { PrismaWaAccountCommandGuard } from './prisma-wa-account-command.guard'
import { PrismaWaRestrictedRecoveryService } from './prisma-wa-restricted-recovery.service'
import { WA_OWNER_REGISTRY, WA_WORKER_ID } from './wa.tokens'

export interface StartWaInstanceJobResult {
  instanceId: string
  status: SessionState['status']
}

export interface StopWaInstanceJobResult {
  instanceId: string
  stopped: boolean
  ownershipStale?: true
}

export interface LogoutWaInstanceJobResult {
  instanceId: string
  loggedOut: boolean
  ownershipStale?: true
}

export interface RenewWaInstanceJobResult {
  instanceId: string
  renewed: boolean
  ownershipStale?: true
}

export interface RecoverRestrictedWaInstanceJobResult {
  instanceId: string
  recovery: 'stale' | 'rescheduled' | 'recovered'
  restrictedUntil?: string
  status?: SessionState['status']
}

export type WaLifecycleJobResult =
  | StartWaInstanceJobResult
  | StopWaInstanceJobResult
  | RenewWaInstanceJobResult
  | LogoutWaInstanceJobResult
  | RecoverRestrictedWaInstanceJobResult

type OwnerLifecycleJobName =
  | typeof STOP_WA_INSTANCE_JOB_NAME
  | typeof LOGOUT_WA_INSTANCE_JOB_NAME
  | typeof RENEW_WA_INSTANCE_JOB_NAME

interface OwnerCommandOutcome {
  completed: boolean
  ownershipStale?: true
}

export class WaLifecycleOwnerUnavailableError extends Error {
  constructor(
    readonly instanceId: string,
    readonly jobName: OwnerLifecycleJobName,
  ) {
    super(`WA lifecycle owner is unavailable for ${jobName}: ${instanceId}`)
    this.name = 'WaLifecycleOwnerUnavailableError'
  }
}

@Injectable()
export class WaLifecycleJobProcessor {
  constructor(
    @Inject(WaLifecycleCommandService)
    private readonly commands: WaLifecycleCommandService,
    @Inject(WA_OWNER_REGISTRY)
    private readonly ownerRegistry: Pick<OwnerRegistry, 'getOwnership'>,
    @Inject(WA_WORKER_ID) private readonly workerId: string,
    @Inject(WaLifecycleQueueService)
    private readonly queueService: WaLifecycleQueueService,
    @Inject(PrismaWaAccountCommandGuard)
    private readonly commandGuard: PrismaWaAccountCommandGuard,
    @Inject(PrismaWaRestrictedRecoveryService)
    private readonly restrictedRecovery: PrismaWaRestrictedRecoveryService,
  ) {}

  async process(
    job: Pick<Job<unknown>, 'name' | 'data'> &
      Partial<Pick<Job<unknown>, 'id' | 'queueName' | 'timestamp'>>,
  ): Promise<WaLifecycleJobResult> {
    const queueName = job.queueName ?? WA_LIFECYCLE_QUEUE_NAME
    assertWaLifecycleQueueName(queueName)

    switch (job.name) {
      case START_WA_INSTANCE_JOB_NAME: {
        if (queueName !== WA_LIFECYCLE_QUEUE_NAME) {
          throw new TypeError(`WA start job cannot run on owner queue: ${queueName}`)
        }
        const payload = parseWaLifecycleInstanceJobPayload(job.data, START_WA_INSTANCE_JOB_NAME)
        await this.commandGuard.assertCommandableInstance(
          payload.instanceId,
          START_WA_INSTANCE_JOB_NAME,
        )
        const state = await this.commands.startInstance(payload.instanceId)

        return {
          instanceId: state.instanceId,
          status: state.status,
        }
      }
      case RECOVER_RESTRICTED_WA_INSTANCE_JOB_NAME: {
        if (queueName !== WA_LIFECYCLE_QUEUE_NAME) {
          throw new TypeError('WA restricted recovery job cannot run on owner queue')
        }
        const payload = parseRecoverRestrictedWaInstanceJobPayload(job.data)
        const decision = await this.restrictedRecovery.resolve(payload)
        if (decision.kind === 'stale') {
          return { instanceId: payload.instanceId, recovery: 'stale' }
        }
        if (decision.kind === 'reschedule') {
          await this.queueService.enqueueRestrictedRecovery(
            payload.instanceId,
            decision.restrictedUntil,
          )
          return {
            instanceId: payload.instanceId,
            recovery: 'rescheduled',
            restrictedUntil: decision.restrictedUntil.toISOString(),
          }
        }

        await this.commandGuard.assertCommandableInstance(
          payload.instanceId,
          START_WA_INSTANCE_JOB_NAME,
        )
        const state = await this.commands.startInstance(payload.instanceId)
        return {
          instanceId: state.instanceId,
          recovery: 'recovered',
          status: state.status,
        }
      }
      case STOP_WA_INSTANCE_JOB_NAME: {
        const payload = parseWaLifecycleInstanceJobPayload(job.data, STOP_WA_INSTANCE_JOB_NAME)
        const stopped = await this.processOwnerCommand(
          STOP_WA_INSTANCE_JOB_NAME,
          payload.instanceId,
          queueName,
          job.data,
          job,
          () => this.commands.stopInstance(payload.instanceId),
        )

        return {
          instanceId: payload.instanceId,
          stopped: stopped.completed,
          ...(stopped.ownershipStale ? { ownershipStale: true as const } : {}),
        }
      }
      case LOGOUT_WA_INSTANCE_JOB_NAME: {
        const payload = parseWaLifecycleInstanceJobPayload(job.data, LOGOUT_WA_INSTANCE_JOB_NAME)
        const loggedOut = await this.processOwnerCommand(
          LOGOUT_WA_INSTANCE_JOB_NAME,
          payload.instanceId,
          queueName,
          job.data,
          job,
          (expectedOwnership) =>
            this.commands.logoutInstance(payload.instanceId, expectedOwnership?.epoch),
        )

        return {
          instanceId: payload.instanceId,
          loggedOut: loggedOut.completed,
          ...(loggedOut.ownershipStale ? { ownershipStale: true as const } : {}),
        }
      }
      case RENEW_WA_INSTANCE_JOB_NAME: {
        const payload = parseWaLifecycleInstanceJobPayload(job.data, RENEW_WA_INSTANCE_JOB_NAME)
        const renewed = await this.processOwnerCommand(
          RENEW_WA_INSTANCE_JOB_NAME,
          payload.instanceId,
          queueName,
          job.data,
          job,
          () => this.commands.renewInstance(payload.instanceId),
        )

        return {
          instanceId: payload.instanceId,
          renewed: renewed.completed,
          ...(renewed.ownershipStale ? { ownershipStale: true as const } : {}),
        }
      }
      default:
        throw new TypeError(`Unsupported WA lifecycle job: ${job.name}`)
    }
  }

  private async processOwnerCommand(
    jobName: OwnerLifecycleJobName,
    instanceId: string,
    queueName: string,
    rawPayload: unknown,
    genericJob: Partial<Pick<Job<unknown>, 'id' | 'timestamp'>>,
    executeLocally: (expectedOwnership?: WaOwnership) => Promise<boolean>,
  ): Promise<OwnerCommandOutcome> {
    if (queueName === WA_LIFECYCLE_QUEUE_NAME) {
      const ownership = await this.ownerRegistry.getOwnership(instanceId)
      if (!ownership) {
        return {
          completed: await this.resolveMissingOwner(jobName, instanceId, executeLocally),
        }
      }

      const result = parseOwnerCommandResult(
        jobName,
        instanceId,
        await this.enqueueForOwner(
          jobName,
          instanceId,
          ownership,
          jobName === RENEW_WA_INSTANCE_JOB_NAME ? createRenewCommandId(genericJob) : undefined,
        ),
      )
      if (result.ownershipStale) {
        throw new WaLifecycleOwnerUnavailableError(instanceId, jobName)
      }
      return result
    }

    const expectedPayload = parseWaLifecycleOwnerCommandJobPayload(rawPayload, jobName)
    const expectedOwnership: WaOwnership = {
      owner: expectedPayload.expectedOwnerWorkerId,
      epoch: BigInt(expectedPayload.expectedOwnerEpoch),
    }
    const expectedQueueName = createWaLifecycleOwnerQueueName(expectedOwnership.owner)
    if (queueName !== expectedQueueName || this.workerId !== expectedOwnership.owner) {
      throw new TypeError(`WA owner command is on the wrong queue: ${queueName}`)
    }

    const currentOwnership = await this.ownerRegistry.getOwnership(instanceId)
    if (!sameOwnership(currentOwnership, expectedOwnership)) return staleOwnershipOutcome()

    const completed = await executeLocally(expectedOwnership)
    if (completed) return { completed: true }

    const ownershipAfterCommand = await this.ownerRegistry.getOwnership(instanceId)
    if (sameOwnership(ownershipAfterCommand, expectedOwnership)) {
      throw new WaLifecycleOwnerUnavailableError(instanceId, jobName)
    }

    return staleOwnershipOutcome()
  }

  private async resolveMissingOwner(
    jobName: OwnerLifecycleJobName,
    instanceId: string,
    executeLocally: (expectedOwnership?: WaOwnership) => Promise<boolean>,
  ): Promise<boolean> {
    if (await this.queueService.hasPendingStart(instanceId)) {
      throw new WaLifecycleOwnerUnavailableError(instanceId, jobName)
    }

    return jobName === LOGOUT_WA_INSTANCE_JOB_NAME ? executeLocally() : false
  }

  private enqueueForOwner(
    jobName: OwnerLifecycleJobName,
    instanceId: string,
    ownership: WaOwnership,
    commandId?: string,
  ): Promise<unknown> {
    if (jobName === STOP_WA_INSTANCE_JOB_NAME) {
      return this.queueService.enqueueStop(instanceId, ownership)
    }
    if (jobName === LOGOUT_WA_INSTANCE_JOB_NAME) {
      return this.queueService.enqueueLogout(instanceId, ownership)
    }
    return this.queueService.enqueueRenew(instanceId, ownership, commandId)
  }
}

function assertWaLifecycleQueueName(queueName: string): void {
  if (
    queueName !== WA_LIFECYCLE_QUEUE_NAME &&
    !queueName.startsWith(WA_LIFECYCLE_OWNER_QUEUE_PREFIX)
  ) {
    throw new TypeError(`Unsupported WA lifecycle queue: ${queueName}`)
  }
}

function parseOwnerCommandResult(
  jobName: OwnerLifecycleJobName,
  instanceId: string,
  result: unknown,
): OwnerCommandOutcome {
  if (!isRecord(result) || result.instanceId !== instanceId) {
    throw new TypeError(`Invalid owner result for ${jobName}: ${instanceId}`)
  }

  const resultKey =
    jobName === STOP_WA_INSTANCE_JOB_NAME
      ? 'stopped'
      : jobName === LOGOUT_WA_INSTANCE_JOB_NAME
        ? 'loggedOut'
        : 'renewed'
  const completed = result[resultKey]
  if (typeof completed !== 'boolean') {
    throw new TypeError(`Invalid owner result for ${jobName}: ${instanceId}`)
  }

  if (result.ownershipStale !== undefined && result.ownershipStale !== true) {
    throw new TypeError(`Invalid owner result for ${jobName}: ${instanceId}`)
  }
  if (completed && result.ownershipStale === true) {
    throw new TypeError(`Invalid owner result for ${jobName}: ${instanceId}`)
  }

  return {
    completed,
    ...(result.ownershipStale === true ? { ownershipStale: true as const } : {}),
  }
}

function sameOwnership(current: WaOwnership | null, expected: WaOwnership): boolean {
  return current?.owner === expected.owner && current.epoch === expected.epoch
}

function staleOwnershipOutcome(): OwnerCommandOutcome {
  return { completed: false, ownershipStale: true }
}

function createRenewCommandId(job: Partial<Pick<Job<unknown>, 'id' | 'timestamp'>>): string {
  const id = job.id?.trim()
  if (!id || !Number.isSafeInteger(job.timestamp) || (job.timestamp ?? 0) < 0) {
    throw new TypeError('Generic WA renew job requires stable id and timestamp')
  }
  return `${id}@${String(job.timestamp)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
