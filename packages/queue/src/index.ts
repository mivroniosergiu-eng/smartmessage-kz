import { Queue, Worker } from 'bullmq'
import type { Job, Processor } from 'bullmq'
import IORedis from 'ioredis'

export const WA_LIFECYCLE_QUEUE_NAME = 'wa-lifecycle'
export const START_WA_INSTANCE_JOB_NAME = 'start-wa-instance'

export interface StartWaInstanceJobPayload {
  instanceId: string
}

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

export function parseStartWaInstanceJobPayload(payload: unknown): StartWaInstanceJobPayload {
  if (!isRecord(payload) || typeof payload.instanceId !== 'string') {
    throw new TypeError('start-wa-instance payload.instanceId must be a non-empty string')
  }

  const instanceId = payload.instanceId.trim()
  if (instanceId.length === 0) {
    throw new TypeError('start-wa-instance payload.instanceId must be a non-empty string')
  }

  return { instanceId }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type { Job, Processor, Queue, Worker }
