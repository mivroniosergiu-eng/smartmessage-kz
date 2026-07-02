import { Inject, Injectable } from '@nestjs/common'
import type { SessionState, WaSessionLifecycleService } from '@smartmessage/wa'

import { WA_SESSION_LIFECYCLE } from './wa.tokens'

type WaLifecyclePort = Pick<WaSessionLifecycleService, 'start' | 'stop' | 'renew'>

@Injectable()
export class WaLifecycleCommandService {
  constructor(@Inject(WA_SESSION_LIFECYCLE) private readonly lifecycle: WaLifecyclePort) {}

  async startInstance(instanceId: string): Promise<SessionState> {
    return this.lifecycle.start(normalizeInstanceId(instanceId))
  }

  async stopInstance(instanceId: string): Promise<boolean> {
    return this.lifecycle.stop(normalizeInstanceId(instanceId))
  }

  async renewInstance(instanceId: string): Promise<boolean> {
    return this.lifecycle.renew(normalizeInstanceId(instanceId))
  }
}

function normalizeInstanceId(instanceId: string): string {
  const normalizedInstanceId = instanceId.trim()
  if (normalizedInstanceId.length === 0) {
    throw new TypeError('instanceId must be a non-empty string')
  }

  return normalizedInstanceId
}
