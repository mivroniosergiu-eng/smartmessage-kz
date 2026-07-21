import { z } from 'zod'

const workerAccountSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  instanceId: z.string(),
  loginType: z.string(),
  status: z.string(),
  pid: z.number().nullable(),
  restrictedUntil: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const workerCommandSchema = z.object({
  instanceId: z.string(),
  command: z.string(),
  queued: z.literal(true),
})

const queuedContactSchema = z.object({
  contactId: z.string(),
  queued: z.literal(true),
})

const workerQrSchema = z.object({
  instanceId: z.string(),
  status: z.string(),
  qrCode: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
})

export type WorkerAccount = z.infer<typeof workerAccountSchema>
export type WorkerQr = z.infer<typeof workerQrSchema>

export class WorkerWaClientError extends Error {
  constructor(
    readonly kind: 'config' | 'request' | 'response',
    message: string,
  ) {
    super(message)
    this.name = 'WorkerWaClientError'
  }
}

export async function workerWaRequest<T>(
  path: string,
  init: RequestInit,
  schema: z.ZodType<T>,
): Promise<T> {
  const baseUrl = process.env.WORKER_INTERNAL_API_URL?.trim() || 'http://127.0.0.1:3001'
  const token = process.env.WORKER_INTERNAL_API_TOKEN?.trim()
  if (!token || token === 'change_me_to_a_random_internal_token') {
    throw new WorkerWaClientError('config', 'WhatsApp worker is not configured')
  }

  const headers = new Headers(init.headers)
  headers.set('x-internal-worker-token', token)
  if (init.body !== undefined) headers.set('content-type', 'application/json')

  let response: Response
  try {
    response = await fetch(new URL(path, baseUrl), {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(10_000),
      cache: 'no-store',
    })
  } catch {
    throw new WorkerWaClientError('request', 'WhatsApp worker is unavailable')
  }

  if (!response.ok) {
    throw new WorkerWaClientError('response', mapWorkerStatus(response.status))
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new WorkerWaClientError('response', 'WhatsApp worker returned an invalid response')
  }

  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    throw new WorkerWaClientError('response', 'WhatsApp worker returned an invalid response')
  }

  return parsed.data
}

export const workerAccountsSchema = z.array(workerAccountSchema)
export const workerAccountResponseSchema = workerAccountSchema
export const workerCommandResponseSchema = workerCommandSchema
export const queuedContactResponseSchema = queuedContactSchema
export const workerQrResponseSchema = workerQrSchema

function mapWorkerStatus(status: number): string {
  if (status === 401 || status === 403) return 'WhatsApp worker authorization failed'
  if (status === 404) return 'WhatsApp account or contact was not found'
  if (status === 409) return 'WhatsApp action is currently unavailable'
  if (status >= 500) return 'WhatsApp worker failed to process the request'
  return 'WhatsApp request was rejected'
}
