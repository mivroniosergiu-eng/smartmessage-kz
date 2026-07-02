import { Module } from '@nestjs/common'
import { HealthController } from './health.controller'
import { ShutdownService } from './shutdown.service'
import { WaModule } from './wa/wa.module'

@Module({
  imports: [WaModule],
  controllers: [HealthController],
  providers: [ShutdownService],
})
export class AppModule {}
