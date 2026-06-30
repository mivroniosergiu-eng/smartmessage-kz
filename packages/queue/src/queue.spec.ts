import { describe, it, expect } from 'vitest'
import { createConnection, createQueue, createWorker } from './index'

const url = process.env.REDIS_URL ?? 'redis://localhost:6380'

describe('queue (integration)', () => {
  it('job проходит через очередь и обрабатывается воркером', async () => {
    const conn = createConnection(url)
    const workerConn = createConnection(url)
    const queue = createQueue<{ n: number }>('phase0-test-queue', conn)
    await queue.obliterate({ force: true })

    let resolveFn: (v: number) => void
    const done = new Promise<number>((res) => { resolveFn = res })
    const worker = createWorker<{ n: number }, number>(
      'phase0-test-queue',
      async (job) => { resolveFn(job.data.n); return job.data.n * 2 },
      workerConn,
    )

    await queue.add('double', { n: 21 })
    const received = await done
    expect(received).toBe(21)

    await worker.close()
    await queue.close()
    await conn.quit()
    await workerConn.quit()
  }, 20000)
})
