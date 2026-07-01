export interface OwnerClaimResult {
  claimed: boolean
  owner: string
}

export interface OwnerRegistry {
  claim(instanceId: string, workerId: string, ttlMs: number): Promise<OwnerClaimResult>
  renew(instanceId: string, workerId: string, ttlMs: number): Promise<boolean>
  release(instanceId: string, workerId: string): Promise<boolean>
  getOwner(instanceId: string): Promise<string | null>
}

export interface RedisOwnerRegistryOptions {
  keyPrefix?: string
}

export interface RedisOwnerRegistryClient {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>
  get(key: string): Promise<string | null>
}

const DEFAULT_KEY_PREFIX = 'wa:owner:'

const CLAIM_SCRIPT = `
local owner = redis.call("GET", KEYS[1])
if not owner then
  redis.call("PSETEX", KEYS[1], ARGV[2], ARGV[1])
  return {1, ARGV[1]}
end
if owner == ARGV[1] then
  redis.call("PEXPIRE", KEYS[1], ARGV[2])
  return {1, owner}
end
return {0, owner}
`

const RENEW_SCRIPT = `
local owner = redis.call("GET", KEYS[1])
if owner == ARGV[1] then
  redis.call("PEXPIRE", KEYS[1], ARGV[2])
  return 1
end
return 0
`

const RELEASE_SCRIPT = `
local owner = redis.call("GET", KEYS[1])
if owner == ARGV[1] then
  redis.call("DEL", KEYS[1])
  return 1
end
return 0
`

export class RedisOwnerRegistry implements OwnerRegistry {
  private readonly keyPrefix: string

  constructor(
    private readonly redis: RedisOwnerRegistryClient,
    options: RedisOwnerRegistryOptions = {},
  ) {
    this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX
  }

  async claim(instanceId: string, workerId: string, ttlMs: number): Promise<OwnerClaimResult> {
    const result = await this.redis.eval(
      CLAIM_SCRIPT,
      1,
      this.keyFor(instanceId),
      normalizeWorkerId(workerId),
      normalizeTtl(ttlMs),
    )

    return parseClaimResult(result)
  }

  async renew(instanceId: string, workerId: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.eval(
      RENEW_SCRIPT,
      1,
      this.keyFor(instanceId),
      normalizeWorkerId(workerId),
      normalizeTtl(ttlMs),
    )

    return result === 1
  }

  async release(instanceId: string, workerId: string): Promise<boolean> {
    const result = await this.redis.eval(RELEASE_SCRIPT, 1, this.keyFor(instanceId), normalizeWorkerId(workerId))

    return result === 1
  }

  async getOwner(instanceId: string): Promise<string | null> {
    return this.redis.get(this.keyFor(instanceId))
  }

  private keyFor(instanceId: string): string {
    const normalizedInstanceId = instanceId.trim()
    if (normalizedInstanceId.length === 0) {
      throw new TypeError('instanceId must be a non-empty string')
    }

    return `${this.keyPrefix}${encodeURIComponent(normalizedInstanceId)}`
  }
}

function normalizeWorkerId(workerId: string): string {
  const normalizedWorkerId = workerId.trim()
  if (normalizedWorkerId.length === 0) {
    throw new TypeError('workerId must be a non-empty string')
  }

  return normalizedWorkerId
}

function normalizeTtl(ttlMs: number): string {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError('ttlMs must be a positive safe integer')
  }

  return String(ttlMs)
}

function parseClaimResult(result: unknown): OwnerClaimResult {
  if (!Array.isArray(result) || result.length !== 2) {
    throw new TypeError('Unexpected Redis owner claim result')
  }

  const [claimed, owner] = result
  if (typeof owner !== 'string') {
    throw new TypeError('Unexpected Redis owner value')
  }

  return {
    claimed: claimed === 1,
    owner,
  }
}
