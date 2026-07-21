import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common'

import {
  PrismaWaPhoneValidationRepository,
  WaPhoneValidationTargetNotFoundError,
} from './prisma-wa-phone-validation.repository'
import {
  PrismaWaSingleSendRepository,
  WaSingleSendContactNotConfirmedError,
  WaSingleSendIdempotencyConflictError,
  WaSingleSendTargetNotFoundError,
  WaSingleSendTargetUnavailableError,
} from './prisma-wa-single-send.repository'
import { InternalWorkerApiGuard } from './internal-worker-api.guard'
import { WaPhoneValidationQueueService } from './wa-phone-validation-queue.service'
import { WaSingleSendQueueService } from './wa-single-send-queue.service'

@UseGuards(InternalWorkerApiGuard)
@Controller('internal/wa')
export class WaOperationsController {
  constructor(
    @Inject(PrismaWaPhoneValidationRepository)
    private readonly phoneRepository: PrismaWaPhoneValidationRepository,
    @Inject(WaPhoneValidationQueueService)
    private readonly phoneQueue: WaPhoneValidationQueueService,
    @Inject(PrismaWaSingleSendRepository)
    private readonly sendRepository: PrismaWaSingleSendRepository,
    @Inject(WaSingleSendQueueService)
    private readonly sendQueue: WaSingleSendQueueService,
  ) {}

  @Post('contacts/validate')
  async validatePhone(@Body() body: unknown): Promise<{ contactId: string; queued: true }> {
    if (!isRecord(body)) throw new BadRequestException('body must be an object')
    const normalizedContactId = required(body.contactId, 'contactId')
    try {
      const teamId = await this.phoneRepository.getTeamId(normalizedContactId)
      await this.phoneQueue.enqueue(normalizedContactId, teamId)
    } catch (error) {
      if (error instanceof WaPhoneValidationTargetNotFoundError) {
        throw new NotFoundException('WA validation contact not found')
      }
      throw error
    }
    return { contactId: normalizedContactId, queued: true }
  }

  @Post('accounts/:instanceId/send-text')
  async sendText(
    @Param('instanceId') instanceId: unknown,
    @Body() body: unknown,
  ): Promise<{ instanceId: string; command: 'send-text'; queued: true }> {
    if (!isRecord(body)) throw new BadRequestException('body must be an object')
    const payload = {
      instanceId: required(instanceId, 'instanceId', 1, 120),
      contactId: required(body.contactId, 'contactId', 1, 120),
      text: required(body.text, 'text', 1, 4_000),
      idempotencyKey: required(body.idempotencyKey, 'idempotencyKey', 8, 200),
    }
    try {
      await this.sendRepository.assertRequestTarget(payload)
      await this.sendQueue.enqueue(payload)
    } catch (error) {
      if (error instanceof WaSingleSendTargetNotFoundError) {
        throw new NotFoundException(error.message)
      }
      if (error instanceof WaSingleSendTargetUnavailableError) {
        throw new ConflictException(error.message)
      }
      if (error instanceof WaSingleSendContactNotConfirmedError) {
        throw new ConflictException(error.message)
      }
      if (error instanceof WaSingleSendIdempotencyConflictError) {
        throw new ConflictException(error.message)
      }
      throw error
    }
    return { instanceId: payload.instanceId, command: 'send-text', queued: true }
  }
}

function required(
  value: unknown,
  field: string,
  minLength = 1,
  maxLength = Number.MAX_SAFE_INTEGER,
): string {
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestException(`${field} must be a non-empty string`)
  const normalized = value.trim()
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new BadRequestException(`${field} length is outside the accepted range`)
  }
  return normalized
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
