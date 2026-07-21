import { Injectable, Logger } from '@nestjs/common'
import type { WaMessageUpdateEvent, WaMessageUpsertEvent, WaReceiver } from '@smartmessage/wa'

@Injectable()
export class WaIncomingEventReceiver implements WaReceiver {
  private readonly logger = new Logger(WaIncomingEventReceiver.name)

  onMessageUpsert(event: WaMessageUpsertEvent): void {
    this.logger.debug(
      `WA incoming upsert accepted (${event.messages.length} ${plural(event.messages.length, 'message', 'messages')})`,
    )
  }

  onMessageUpdate(event: WaMessageUpdateEvent): void {
    this.logger.debug(
      `WA incoming update accepted (${event.updates.length} ${plural(event.updates.length, 'update', 'updates')})`,
    )
  }
}

function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue
}
