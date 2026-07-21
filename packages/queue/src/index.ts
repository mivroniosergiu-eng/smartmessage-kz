import { createHash } from 'node:crypto'
import { Queue, QueueEvents, Worker } from 'bullmq'
import type { Job, Processor, WorkerOptions } from 'bullmq'
import IORedis from 'ioredis'

export const WA_LIFECYCLE_QUEUE_NAME = 'wa-lifecycle'
export const WA_LIFECYCLE_OWNER_QUEUE_PREFIX = 'wa-lifecycle-owner.'
export const WA_LIFECYCLE_OWNER_RESULT_MAX_AGE_SECONDS = 300
export const WA_LIFECYCLE_OWNER_RESULT_MAX_COUNT = 1_000
export const START_WA_INSTANCE_JOB_NAME = 'start-wa-instance'
export const STOP_WA_INSTANCE_JOB_NAME = 'stop-wa-instance'
export const LOGOUT_WA_INSTANCE_JOB_NAME = 'logout-wa-instance'
export const RECOVER_RESTRICTED_WA_INSTANCE_JOB_NAME = 'recover-restricted-wa-instance'
export const RENEW_WA_INSTANCE_JOB_NAME = 'renew-wa-instance'

export const WA_PHONE_VALIDATION_QUEUE_NAME = 'validate-phone'
export const WA_PHONE_VALIDATION_OWNER_QUEUE_PREFIX = 'validate-phone-owner.'
export const VALIDATE_WA_PHONE_JOB_NAME = 'validate-wa-phone'

export const WA_SINGLE_SEND_QUEUE_NAME = 'wa-single-send'
export const WA_SINGLE_SEND_OWNER_QUEUE_PREFIX = 'wa-single-send-owner.'
export const SEND_WA_TEXT_JOB_NAME = 'send-wa-text'

export interface WaSingleSendJobPayload {
  instanceId: string
  contactId: string
  text: string
  idempotencyKey: string
}

export interface WaSingleSendOwnerJobPayload extends WaSingleSendJobPayload {
  messageLogId: string
  teamId: string
  phone: string
  expectedOwnerWorkerId: string
  expectedOwnerEpoch: string
}

export function createWaSingleSendOwnerQueueName(workerId: string): string {
  return `${WA_SINGLE_SEND_OWNER_QUEUE_PREFIX}${encodeURIComponent(
    normalizeRequiredString(workerId, 'workerId'),
  )}`
}

export function parseWaSingleSendJobPayload(payload: unknown): WaSingleSendJobPayload {
  if (!isRecord(payload)) throwInvalidWaSingleSendPayload()
  return {
    instanceId: normalizeBoundedString(payload.instanceId, 'payload.instanceId', 1, 120),
    contactId: normalizeBoundedString(payload.contactId, 'payload.contactId', 1, 120),
    text: normalizeBoundedString(payload.text, 'payload.text', 1, 4_000),
    idempotencyKey: normalizeBoundedString(
      payload.idempotencyKey,
      'payload.idempotencyKey',
      8,
      200,
    ),
  }
}

export function parseWaSingleSendOwnerJobPayload(payload: unknown): WaSingleSendOwnerJobPayload {
  const base = parseWaSingleSendJobPayload(payload)
  if (!isRecord(payload)) throwInvalidWaSingleSendOwnerPayload()
  const expectedOwnerEpoch = normalizeRequiredString(
    payload.expectedOwnerEpoch,
    'payload.expectedOwnerEpoch',
  )
  if (!/^[1-9]\d*$/.test(expectedOwnerEpoch)) throwInvalidWaSingleSendOwnerPayload()

  return {
    ...base,
    messageLogId: normalizeRequiredString(payload.messageLogId, 'payload.messageLogId'),
    teamId: normalizeRequiredString(payload.teamId, 'payload.teamId'),
    phone: normalizeRequiredString(payload.phone, 'payload.phone'),
    expectedOwnerWorkerId: normalizeRequiredString(
      payload.expectedOwnerWorkerId,
      'payload.expectedOwnerWorkerId',
    ),
    expectedOwnerEpoch,
  }
}

export function createWaSingleSendJobId(payload: unknown): string {
  const parsed = parseWaSingleSendJobPayload(payload)
  return [
    WA_SINGLE_SEND_QUEUE_NAME,
    SEND_WA_TEXT_JOB_NAME,
    encodeJobIdSegment(parsed.instanceId),
    encodeJobIdSegment(parsed.contactId),
    encodeJobIdSegment(parsed.idempotencyKey),
    createHash('sha256').update(parsed.text).digest('hex').slice(0, 16),
  ].join('.')
}

export function createWaSingleSendOwnerJobId(payload: unknown): string {
  const parsed = parseWaSingleSendOwnerJobPayload(payload)
  return [
    'wa-single-send-owner',
    SEND_WA_TEXT_JOB_NAME,
    encodeJobIdSegment(parsed.messageLogId),
    encodeJobIdSegment(parsed.expectedOwnerWorkerId),
    parsed.expectedOwnerEpoch,
  ].join('.')
}

export interface WaPhoneValidationJobPayload {
  contactId: string
  teamId: string
}

export interface WaPhoneValidationOwnerJobPayload extends WaPhoneValidationJobPayload {
  validationRunId: string
  instanceId: string
  phone: string
  expectedOwnerWorkerId: string
  expectedOwnerEpoch: string
}

export function createWaPhoneValidationOwnerQueueName(workerId: string): string {
  const normalizedWorkerId = normalizeRequiredString(workerId, 'workerId')
  return `${WA_PHONE_VALIDATION_OWNER_QUEUE_PREFIX}${encodeURIComponent(normalizedWorkerId)}`
}

export function parseWaPhoneValidationJobPayload(payload: unknown): WaPhoneValidationJobPayload {
  if (!isRecord(payload)) throwInvalidWaPhoneValidationPayload()
  return {
    contactId: normalizeRequiredString(payload.contactId, 'payload.contactId'),
    teamId: normalizeRequiredString(payload.teamId, 'payload.teamId'),
  }
}

export function parseWaPhoneValidationOwnerJobPayload(
  payload: unknown,
): WaPhoneValidationOwnerJobPayload {
  const base = parseWaPhoneValidationJobPayload(payload)
  if (!isRecord(payload)) throwInvalidWaPhoneValidationOwnerPayload()
  const expectedOwnerEpoch = normalizeRequiredString(
    payload.expectedOwnerEpoch,
    'payload.expectedOwnerEpoch',
  )
  if (!/^[1-9]\d*$/.test(expectedOwnerEpoch)) throwInvalidWaPhoneValidationOwnerPayload()

  return {
    ...base,
    validationRunId: normalizeRequiredString(payload.validationRunId, 'payload.validationRunId'),
    instanceId: normalizeRequiredString(payload.instanceId, 'payload.instanceId'),
    phone: normalizeRequiredString(payload.phone, 'payload.phone'),
    expectedOwnerWorkerId: normalizeRequiredString(
      payload.expectedOwnerWorkerId,
      'payload.expectedOwnerWorkerId',
    ),
    expectedOwnerEpoch,
  }
}

export function createWaPhoneValidationJobId(payload: unknown): string {
  const parsed = parseWaPhoneValidationJobPayload(payload)
  return [
    WA_PHONE_VALIDATION_QUEUE_NAME,
    VALIDATE_WA_PHONE_JOB_NAME,
    encodeJobIdSegment(parsed.teamId),
    encodeJobIdSegment(parsed.contactId),
  ].join('.')
}

export function createWaPhoneValidationOwnerJobId(payload: unknown): string {
  const parsed = parseWaPhoneValidationOwnerJobPayload(payload)
  return [
    'validate-phone-owner',
    VALIDATE_WA_PHONE_JOB_NAME,
    encodeJobIdSegment(parsed.teamId),
    encodeJobIdSegment(parsed.contactId),
    encodeJobIdSegment(parsed.validationRunId),
    encodeJobIdSegment(parsed.instanceId),
    encodeJobIdSegment(parsed.phone),
    encodeJobIdSegment(parsed.expectedOwnerWorkerId),
    parsed.expectedOwnerEpoch,
  ].join('.')
}

export const WA_LIFECYCLE_JOB_NAMES = [
  START_WA_INSTANCE_JOB_NAME,
  STOP_WA_INSTANCE_JOB_NAME,
  LOGOUT_WA_INSTANCE_JOB_NAME,
  RECOVER_RESTRICTED_WA_INSTANCE_JOB_NAME,
  RENEW_WA_INSTANCE_JOB_NAME,
] as const

export type WaLifecycleJobName = (typeof WA_LIFECYCLE_JOB_NAMES)[number]
export type WaLifecycleOwnerJobName =
  | typeof STOP_WA_INSTANCE_JOB_NAME
  | typeof LOGOUT_WA_INSTANCE_JOB_NAME
  | typeof RENEW_WA_INSTANCE_JOB_NAME

export interface WaLifecycleInstanceJobPayload {
  instanceId: string
}

export interface WaLifecycleOwnerCommandJobPayload extends WaLifecycleInstanceJobPayload {
  expectedOwnerWorkerId: string
  expectedOwnerEpoch: string
}

export type StartWaInstanceJobPayload = WaLifecycleInstanceJobPayload
export type StopWaInstanceJobPayload = WaLifecycleInstanceJobPayload
export type LogoutWaInstanceJobPayload = WaLifecycleInstanceJobPayload
export interface RecoverRestrictedWaInstanceJobPayload extends WaLifecycleInstanceJobPayload {
  restrictedUntil: string
}
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
  commandId?: string,
): string {
  const parsed = parseWaLifecycleOwnerCommandJobPayload(payload, jobName)
  const segments = [
    'wa-lifecycle-owner',
    encodeJobIdSegment(jobName),
    encodeJobIdSegment(parsed.instanceId),
    encodeJobIdSegment(parsed.expectedOwnerWorkerId),
    parsed.expectedOwnerEpoch,
  ]
  if (jobName === RENEW_WA_INSTANCE_JOB_NAME) {
    const normalizedCommandId = commandId?.trim()
    if (!normalizedCommandId) {
      throw new TypeError('renew-wa-instance owner job requires a non-empty commandId')
    }
    segments.push(encodeJobIdSegment(normalizedCommandId))
  }
  return segments.join('.')
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

export function parseRecoverRestrictedWaInstanceJobPayload(
  payload: unknown,
): RecoverRestrictedWaInstanceJobPayload {
  const instance = parseWaLifecycleInstanceJobPayload(
    payload,
    RECOVER_RESTRICTED_WA_INSTANCE_JOB_NAME,
  )
  if (!isRecord(payload) || typeof payload.restrictedUntil !== 'string') {
    throwInvalidRecoverRestrictedWaInstancePayload()
  }

  const restrictedUntilMs = Date.parse(payload.restrictedUntil)
  if (
    !Number.isSafeInteger(restrictedUntilMs) ||
    new Date(restrictedUntilMs).toISOString() !== payload.restrictedUntil
  ) {
    throwInvalidRecoverRestrictedWaInstancePayload()
  }

  return { ...instance, restrictedUntil: payload.restrictedUntil }
}

export function createRecoverRestrictedWaInstanceJobId(payload: unknown): string {
  const parsed = parseRecoverRestrictedWaInstanceJobPayload(payload)

  return [
    'wa-lifecycle',
    RECOVER_RESTRICTED_WA_INSTANCE_JOB_NAME,
    encodeJobIdSegment(parsed.instanceId),
    String(Date.parse(parsed.restrictedUntil)),
  ].join('.')
}

export function createWaLifecycleJobId(jobName: WaLifecycleJobName, payload: unknown): string {
  if (jobName === RECOVER_RESTRICTED_WA_INSTANCE_JOB_NAME) {
    return createRecoverRestrictedWaInstanceJobId(payload)
  }
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

function throwInvalidRecoverRestrictedWaInstancePayload(): never {
  throw new TypeError(
    `${RECOVER_RESTRICTED_WA_INSTANCE_JOB_NAME} payload.restrictedUntil must be a canonical ISO timestamp`,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodeJobIdSegment(value: string): string {
  return encodeURIComponent(value).replaceAll('.', '%2E')
}

function normalizeRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`)
  }
  return value.trim()
}

function normalizeBoundedString(
  value: unknown,
  fieldName: string,
  minLength: number,
  maxLength: number,
): string {
  const normalized = normalizeRequiredString(value, fieldName)
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new TypeError(`${fieldName} length must be between ${minLength} and ${maxLength}`)
  }
  return normalized
}

function throwInvalidWaPhoneValidationPayload(): never {
  throw new TypeError('validate-wa-phone payload must include contactId and teamId')
}

function throwInvalidWaPhoneValidationOwnerPayload(): never {
  throw new TypeError('validate-wa-phone owner payload is invalid')
}

function throwInvalidWaSingleSendPayload(): never {
  throw new TypeError('send-wa-text payload is invalid')
}

function throwInvalidWaSingleSendOwnerPayload(): never {
  throw new TypeError('send-wa-text owner payload is invalid')
}

export type { Job, Processor, Queue, QueueEvents, Worker }
