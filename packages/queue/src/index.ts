import { Queue, Worker } from 'bullmq'
import type { Job, Processor } from 'bullmq'
import IORedis from 'ioredis'

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

export type { Job, Processor, Queue, Worker }
