import { Inject, Injectable } from '@nestjs/common'
import {
  RENEW_WA_INSTANCE_JOB_NAME,
  START_WA_INSTANCE_JOB_NAME,
  STOP_WA_INSTANCE_JOB_NAME,
  WA_LIFECYCLE_OWNER_QUEUE_PREFIX,
  WA_LIFECYCLE_QUEUE_NAME,
  createWaLifecycleOwnerQueueName,
  parseWaLifecycleOwnerCommandJobPayload,
  parseWaLifecycleInstanceJobPayload,
} from '@smartmessage/queue'
import type { Job } from '@smartmessage/queue'
import type { OwnerRegistry, SessionState, WaOwnership } from '@smartmessage/wa'

import { WaLifecycleCommandService } from './wa-lifecycle-command.service'
import { WaLifecycleQueueService } from './wa-lifecycle-queue.service'
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

export interface RenewWaInstanceJobResult {
  instanceId: string
  renewed: boolean
  ownershipStale?: true
}

export type WaLifecycleJobResult =
  StartWaInstanceJobResult | StopWaInstanceJobResult | RenewWaInstanceJobResult

type OwnerLifecycleJobName = typeof STOP_WA_INSTANCE_JOB_NAME | typeof RENEW_WA_INSTANCE_JOB_NAME

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
    private readonly commands: WaLifecycleCommandService,
    @Inject(WA_OWNER_REGISTRY)
    private readonly ownerRegistry: Pick<OwnerRegistry, 'getOwnership'>,
    @Inject(WA_WORKER_ID) private readonly workerId: string,
    private readonly queueService: WaLifecycleQueueService,
  ) {}

  async process(
    job: Pick<Job<unknown>, 'name' | 'data'> & Partial<Pick<Job<unknown>, 'queueName'>>,
  ): Promise<WaLifecycleJobResult> {
    const queueName = job.queueName ?? WA_LIFECYCLE_QUEUE_NAME
    assertWaLifecycleQueueName(queueName)

    switch (job.name) {
      case START_WA_INSTANCE_JOB_NAME: {
        if (queueName !== WA_LIFECYCLE_QUEUE_NAME) {
          throw new TypeError(`WA start job cannot run on owner queue: ${queueName}`)
        }
        const payload = parseWaLifecycleInstanceJobPayload(job.data, START_WA_INSTANCE_JOB_NAME)
        const state = await this.commands.startInstance(payload.instanceId)

        return {
          instanceId: state.instanceId,
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
          () => this.commands.stopInstance(payload.instanceId),
        )

        return {
          instanceId: payload.instanceId,
          stopped: stopped.completed,
          ...(stopped.ownershipStale ? { ownershipStale: true as const } : {}),
        }
      }
      case RENEW_WA_INSTANCE_JOB_NAME: {
        const payload = parseWaLifecycleInstanceJobPayload(job.data, RENEW_WA_INSTANCE_JOB_NAME)
        const renewed = await this.processOwnerCommand(
          RENEW_WA_INSTANCE_JOB_NAME,
          payload.instanceId,
          queueName,
          job.data,
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
    executeLocally: () => Promise<boolean>,
  ): Promise<OwnerCommandOutcome> {
    if (queueName === WA_LIFECYCLE_QUEUE_NAME) {
      const ownership = await this.ownerRegistry.getOwnership(instanceId)
      if (!ownership) {
        return { completed: await this.resolveMissingOwner(jobName, instanceId) }
      }

      const result = parseOwnerCommandResult(
        jobName,
        instanceId,
        await this.enqueueForOwner(jobName, instanceId, ownership),
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

    const completed = await executeLocally()
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
  ): Promise<boolean> {
    if (await this.queueService.hasPendingStart(instanceId)) {
      throw new WaLifecycleOwnerUnavailableError(instanceId, jobName)
    }

    return false
  }

  private enqueueForOwner(
    jobName: OwnerLifecycleJobName,
    instanceId: string,
    ownership: WaOwnership,
  ): Promise<unknown> {
    return jobName === STOP_WA_INSTANCE_JOB_NAME
      ? this.queueService.enqueueStop(instanceId, ownership)
      : this.queueService.enqueueRenew(instanceId, ownership)
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

  const resultKey = jobName === STOP_WA_INSTANCE_JOB_NAME ? 'stopped' : 'renewed'
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
