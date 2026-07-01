import { Injectable, OnApplicationShutdown } from '@nestjs/common'

@Injectable()
export class ShutdownService implements OnApplicationShutdown {
  public shutdownSignal: string | null = null

  onApplicationShutdown(signal?: string): void {
    this.shutdownSignal = signal ?? 'manual'
  }
}
