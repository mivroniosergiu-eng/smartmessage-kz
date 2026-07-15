export interface OwnerClaimResult {
  claimed: boolean
  owner: string
  epoch: bigint
}

export interface WaOwnership {
  owner: string
  epoch: bigint
}

export interface OwnerRegistry {
  claim(
    instanceId: string,
    workerId: string,
    ttlMs: number,
    minimumEpoch?: bigint,
  ): Promise<OwnerClaimResult>
  renew(instanceId: string, workerId: string, ttlMs: number, epoch: bigint): Promise<boolean>
  release(instanceId: string, workerId: string, epoch: bigint): Promise<boolean>
  getOwnership(instanceId: string): Promise<WaOwnership | null>
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
local function normalize_decimal(value)
  local normalized = string.gsub(value, "^0+", "")
  if normalized == "" then
    return "0"
  end
  return normalized
end

local function decimal_less(left, right)
  left = normalize_decimal(left)
  right = normalize_decimal(right)
  if string.len(left) ~= string.len(right) then
    return string.len(left) < string.len(right)
  end
  return left < right
end

local function decimal_less_or_equal(left, right)
  return not decimal_less(right, left)
end

local current = redis.call("GET", KEYS[1])
if not current then
  local counter = redis.call("GET", KEYS[2]) or "0"
  if decimal_less(counter, ARGV[3]) then
    redis.call("SET", KEYS[2], ARGV[3])
  end
  redis.call("INCR", KEYS[2])
  local epoch = redis.call("GET", KEYS[2])
  redis.call("PSETEX", KEYS[1], ARGV[2], epoch .. "|" .. ARGV[1])
  return {1, ARGV[1], epoch}
end

local separator = string.find(current, "|", 1, true)
local owner = current
local epoch = "0"
if separator then
  epoch = string.sub(current, 1, separator - 1)
  owner = string.sub(current, separator + 1)
end

if owner == ARGV[1] then
  if epoch == "0" or decimal_less_or_equal(epoch, ARGV[3]) then
    local counter = redis.call("GET", KEYS[2]) or "0"
    if decimal_less(counter, ARGV[3]) then
      redis.call("SET", KEYS[2], ARGV[3])
    end
    redis.call("INCR", KEYS[2])
    epoch = redis.call("GET", KEYS[2])
    redis.call("PSETEX", KEYS[1], ARGV[2], epoch .. "|" .. owner)
  else
    redis.call("PEXPIRE", KEYS[1], ARGV[2])
  end
  return {1, owner, epoch}
end
return {0, owner, epoch}
`

const RENEW_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current == ARGV[3] .. "|" .. ARGV[1] then
  redis.call("PEXPIRE", KEYS[1], ARGV[2])
  return 1
end
return 0
`

const RELEASE_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current == ARGV[2] .. "|" .. ARGV[1] then
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

  async claim(
    instanceId: string,
    workerId: string,
    ttlMs: number,
    minimumEpoch: bigint = 0n,
  ): Promise<OwnerClaimResult> {
    const result = await this.redis.eval(
      CLAIM_SCRIPT,
      2,
      this.keyFor(instanceId),
      this.fenceKeyFor(instanceId),
      normalizeWorkerId(workerId),
      normalizeTtl(ttlMs),
      normalizeMinimumEpoch(minimumEpoch),
    )

    return parseClaimResult(result)
  }

  async renew(
    instanceId: string,
    workerId: string,
    ttlMs: number,
    epoch: bigint,
  ): Promise<boolean> {
    const result = await this.redis.eval(
      RENEW_SCRIPT,
      1,
      this.keyFor(instanceId),
      normalizeWorkerId(workerId),
      normalizeTtl(ttlMs),
      normalizeEpoch(epoch),
    )

    return result === 1
  }

  async release(instanceId: string, workerId: string, epoch: bigint): Promise<boolean> {
    const result = await this.redis.eval(
      RELEASE_SCRIPT,
      1,
      this.keyFor(instanceId),
      normalizeWorkerId(workerId),
      normalizeEpoch(epoch),
    )

    return result === 1
  }

  async getOwner(instanceId: string): Promise<string | null> {
    return (await this.getOwnership(instanceId))?.owner ?? null
  }

  async getOwnership(instanceId: string): Promise<WaOwnership | null> {
    const value = await this.redis.get(this.keyFor(instanceId))
    return value ? parseStoredOwnership(value) : null
  }

  private keyFor(instanceId: string): string {
    const normalizedInstanceId = instanceId.trim()
    if (normalizedInstanceId.length === 0) {
      throw new TypeError('instanceId must be a non-empty string')
    }

    return `${this.keyPrefix}${encodeURIComponent(normalizedInstanceId)}`
  }

  private fenceKeyFor(instanceId: string): string {
    return `${this.keyFor(instanceId)}:fence`
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

function normalizeEpoch(epoch: bigint): string {
  if (epoch <= 0n) throw new RangeError('epoch must be a positive bigint')
  return epoch.toString()
}

function normalizeMinimumEpoch(epoch: bigint): string {
  if (epoch < 0n) throw new RangeError('minimumEpoch must be a non-negative bigint')
  return epoch.toString()
}

function parseClaimResult(result: unknown): OwnerClaimResult {
  if (!Array.isArray(result) || result.length !== 3) {
    throw new TypeError('Unexpected Redis owner claim result')
  }

  const [claimed, owner, epoch] = result
  if (typeof owner !== 'string' || typeof epoch !== 'string' || !/^\d+$/.test(epoch)) {
    throw new TypeError('Unexpected Redis owner value')
  }

  return {
    claimed: claimed === 1,
    owner,
    epoch: BigInt(epoch),
  }
}

function parseStoredOwnership(value: string): WaOwnership {
  const separator = value.indexOf('|')
  if (separator < 0) return { owner: value, epoch: 0n }
  return { owner: value.slice(separator + 1), epoch: BigInt(value.slice(0, separator)) }
}
