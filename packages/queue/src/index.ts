import { Queue, QueueEvents, Worker } from 'bullmq'
import type { Job, Processor, WorkerOptions } from 'bullmq'
import IORedis from 'ioredis'

export const WA_LIFECYCLE_QUEUE_NAME = 'wa-lifecycle'
export const WA_LIFECYCLE_OWNER_QUEUE_PREFIX = 'wa-lifecycle-owner.'
export const WA_LIFECYCLE_OWNER_RESULT_MAX_AGE_SECONDS = 300
export const WA_LIFECYCLE_OWNER_RESULT_MAX_COUNT = 1_000
export const START_WA_INSTANCE_JOB_NAME = 'start-wa-instance'
export const STOP_WA_INSTANCE_JOB_NAME = 'stop-wa-instance'
export const RENEW_WA_INSTANCE_JOB_NAME = 'renew-wa-instance'

export const WA_LIFECYCLE_JOB_NAMES = [
  START_WA_INSTANCE_JOB_NAME,
  STOP_WA_INSTANCE_JOB_NAME,
  RENEW_WA_INSTANCE_JOB_NAME,
] as const

export type WaLifecycleJobName = (typeof WA_LIFECYCLE_JOB_NAMES)[number]
export type WaLifecycleOwnerJobName =
  typeof STOP_WA_INSTANCE_JOB_NAME | typeof RENEW_WA_INSTANCE_JOB_NAME

export interface WaLifecycleInstanceJobPayload {
  instanceId: string
}

export interface WaLifecycleOwnerCommandJobPayload extends WaLifecycleInstanceJobPayload {
  expectedOwnerWorkerId: string
  expectedOwnerEpoch: string
}

export type StartWaInstanceJobPayload = WaLifecycleInstanceJobPayload
export type StopWaInstanceJobPayload = WaLifecycleInstanceJobPayload
export type RenewWaInstanceJobPayload = WaLifecycleInstanceJobPayload

/**
 * `workerId` is a stable deployment-slot identity, not a per-process UUID.
 * Sequential process generations reuse this queue; concurrent processes must
 * hold an exclusive external lease for the same identity.
 */
export function createWaLifecycleOwnerQueueName(workerId: string): string {
  const normalizedWorkerId = workerId.trim()
  if (normalizedWorkerId.length === 0) {
    throw new TypeError('workerId must be a non-empty string')
  }

  return `${WA_LIFECYCLE_OWNER_QUEUE_PREFIX}${encodeURIComponent(normalizedWorkerId)}`
}

export function parseWaLifecycleOwnerCommandJobPayload(
  payload: unknown,
  jobName: WaLifecycleOwnerJobName,
): WaLifecycleOwnerCommandJobPayload {
  const instance = parseWaLifecycleInstanceJobPayload(payload, jobName)
  if (
    !isRecord(payload) ||
    typeof payload.expectedOwnerWorkerId !== 'string' ||
    typeof payload.expectedOwnerEpoch !== 'string'
  ) {
    throwInvalidWaLifecycleOwnerPayload(jobName)
  }

  const expectedOwnerWorkerId = payload.expectedOwnerWorkerId.trim()
  const expectedOwnerEpoch = payload.expectedOwnerEpoch.trim()
  if (expectedOwnerWorkerId.length === 0 || !/^[1-9]\d*$/.test(expectedOwnerEpoch)) {
    throwInvalidWaLifecycleOwnerPayload(jobName)
  }

  return { ...instance, expectedOwnerWorkerId, expectedOwnerEpoch }
}

export function createWaLifecycleOwnerJobId(
  jobName: WaLifecycleOwnerJobName,
  payload: unknown,
): string {
  const parsed = parseWaLifecycleOwnerCommandJobPayload(payload, jobName)
  return [
    'wa-lifecycle-owner',
    encodeURIComponent(jobName),
    encodeURIComponent(parsed.instanceId),
    encodeURIComponent(parsed.expectedOwnerWorkerId),
    parsed.expectedOwnerEpoch,
  ].join('.')
}

/** Создаёт Redis-соединение, совместимое с BullMQ (maxRetriesPerRequest: null). */
export function createConnection(
  url: string = process.env.REDIS_URL ?? 'redis://localhost:6379',
): IORedis {
  return new IORedis(url, { maxRetriesPerRequest: null })
}

/** Типизированная очередь. */
export function createQueue<T>(name: string, connection: IORedis): Queue<T> {
  return new Queue<T>(name, { connection })
}

/** Создаёт listener подтверждений BullMQ на отдельном duplicated Redis connection. */
export function createQueueEvents(name: string, connection: IORedis): QueueEvents {
  return new QueueEvents(name, { connection })
}

/** Типизированный воркер. */
export function createWorker<T, R = unknown>(
  name: string,
  processor: Processor<T, R>,
  connection: IORedis,
  options: Pick<WorkerOptions, 'autorun'> = {},
): Worker<T, R> {
  return new Worker<T, R>(name, processor, { connection, ...options })
}

export function parseWaLifecycleInstanceJobPayload(
  payload: unknown,
  jobName: WaLifecycleJobName,
): WaLifecycleInstanceJobPayload {
  if (!isRecord(payload) || typeof payload.instanceId !== 'string') {
    throwInvalidWaLifecycleInstancePayload(jobName)
  }

  const instanceId = payload.instanceId.trim()
  if (instanceId.length === 0) {
    throwInvalidWaLifecycleInstancePayload(jobName)
  }

  return { instanceId }
}

export function parseStartWaInstanceJobPayload(payload: unknown): StartWaInstanceJobPayload {
  return parseWaLifecycleInstanceJobPayload(payload, START_WA_INSTANCE_JOB_NAME)
}

export function createWaLifecycleJobId(jobName: WaLifecycleJobName, payload: unknown): string {
  const { instanceId } = parseWaLifecycleInstanceJobPayload(payload, jobName)

  return `wa-lifecycle.${encodeURIComponent(jobName)}.${encodeURIComponent(instanceId)}`
}

function throwInvalidWaLifecycleInstancePayload(jobName: WaLifecycleJobName): never {
  throw new TypeError(`${jobName} payload.instanceId must be a non-empty string`)
}

function throwInvalidWaLifecycleOwnerPayload(jobName: WaLifecycleOwnerJobName): never {
  throw new TypeError(
    `${jobName} owner payload must include a non-empty expectedOwnerWorkerId and positive expectedOwnerEpoch`,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type { Job, Processor, Queue, QueueEvents, Worker }
