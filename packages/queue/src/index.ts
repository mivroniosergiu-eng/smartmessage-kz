import { Queue, Worker } from 'bullmq'
import type { Job, Processor } from 'bullmq'
import IORedis from 'ioredis'

export const WA_LIFECYCLE_QUEUE_NAME = 'wa-lifecycle'
export const START_WA_INSTANCE_JOB_NAME = 'start-wa-instance'
export const STOP_WA_INSTANCE_JOB_NAME = 'stop-wa-instance'
export const RENEW_WA_INSTANCE_JOB_NAME = 'renew-wa-instance'

export const WA_LIFECYCLE_JOB_NAMES = [
  START_WA_INSTANCE_JOB_NAME,
  STOP_WA_INSTANCE_JOB_NAME,
  RENEW_WA_INSTANCE_JOB_NAME,
] as const

export type WaLifecycleJobName = (typeof WA_LIFECYCLE_JOB_NAMES)[number]

export interface WaLifecycleInstanceJobPayload {
  instanceId: string
}

export type StartWaInstanceJobPayload = WaLifecycleInstanceJobPayload
export type StopWaInstanceJobPayload = WaLifecycleInstanceJobPayload
export type RenewWaInstanceJobPayload = WaLifecycleInstanceJobPayload

/** Создаёт Redis-соединение, совместимое с BullMQ (maxRetriesPerRequest: null). */
export function createConnection(url: string = process.env.REDIS_URL ?? 'redis://localhost:6379'): IORedis {
  return new IORedis(url, { maxRetriesPerRequest: null })
}

/** Типизированная очередь. */
export function createQueue<T>(name: string, connection: IORedis): Queue<T> {
  return new Queue<T>(name, { connection })
}

/** Типизированный воркер. */
export function createWorker<T, R = unknown>(
  name: string,
  processor: Processor<T, R>,
  connection: IORedis,
): Worker<T, R> {
  return new Worker<T, R>(name, processor, { connection })
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type { Job, Processor, Queue, Worker }
