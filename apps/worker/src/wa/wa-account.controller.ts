import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpException,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import type { WaAccount } from '@smartmessage/db'

import {
  PrismaWaAccountAdminService,
  WaAccountAdminDuplicateInstanceError,
  WaAccountAdminInvalidInputError,
  WaAccountAdminTeamNotFoundError,
} from './prisma-wa-account-admin.service'
import { WaAccountCommandTargetNotFoundError } from './prisma-wa-account-command.guard'
import { InternalWorkerApiGuard } from './internal-worker-api.guard'
import { WaLifecycleCommandQueueService } from './wa-lifecycle-command-queue.service'

type WaLifecycleCommand = 'start' | 'stop' | 'renew'

interface WaAccountDto {
  id: string
  teamId: string
  instanceId: string
  loginType: string
  status: string
  pid: number | null
  restrictedUntil: string | null
  createdAt: string
  updatedAt: string
}

interface WaLifecycleCommandDto {
  instanceId: string
  command: WaLifecycleCommand
  queued: true
}

@UseGuards(InternalWorkerApiGuard)
@Controller('internal/wa/accounts')
export class WaAccountController {
  constructor(
    private readonly adminService: PrismaWaAccountAdminService,
    private readonly commandQueue: WaLifecycleCommandQueueService,
  ) {}

  @Post()
  async createAccount(@Body() body: unknown): Promise<WaAccountDto> {
    const input = readCreateAccountBody(body)

    try {
      return toWaAccountDto(await this.adminService.createAccount(input))
    } catch (error) {
      throw mapWaHttpError(error)
    }
  }

  @Get()
  async listAccounts(@Query('teamId') teamId: unknown): Promise<WaAccountDto[]> {
    const normalizedTeamId = normalizeNonEmptyString(teamId, 'teamId')

    try {
      const accounts = await this.adminService.listAccounts(normalizedTeamId)
      return accounts.map(toWaAccountDto)
    } catch (error) {
      throw mapWaHttpError(error)
    }
  }

  @Get(':instanceId')
  async getAccount(@Param('instanceId') instanceId: unknown): Promise<WaAccountDto> {
    const normalizedInstanceId = normalizeNonEmptyString(instanceId, 'instanceId')

    try {
      const account = await this.adminService.getAccount(normalizedInstanceId)
      if (!account) {
        throw new NotFoundException('WA account not found')
      }

      return toWaAccountDto(account)
    } catch (error) {
      throw mapWaHttpError(error)
    }
  }

  @Post(':instanceId/start')
  startAccount(@Param('instanceId') instanceId: unknown): Promise<WaLifecycleCommandDto> {
    return this.enqueueLifecycleCommand('start', instanceId)
  }

  @Post(':instanceId/stop')
  stopAccount(@Param('instanceId') instanceId: unknown): Promise<WaLifecycleCommandDto> {
    return this.enqueueLifecycleCommand('stop', instanceId)
  }

  @Post(':instanceId/renew')
  renewAccount(@Param('instanceId') instanceId: unknown): Promise<WaLifecycleCommandDto> {
    return this.enqueueLifecycleCommand('renew', instanceId)
  }

  private async enqueueLifecycleCommand(
    command: WaLifecycleCommand,
    instanceId: unknown,
  ): Promise<WaLifecycleCommandDto> {
    const normalizedInstanceId = normalizeNonEmptyString(instanceId, 'instanceId')

    try {
      if (command === 'start') {
        await this.commandQueue.enqueueStart(normalizedInstanceId)
      } else if (command === 'stop') {
        await this.commandQueue.enqueueStop(normalizedInstanceId)
      } else {
        await this.commandQueue.enqueueRenew(normalizedInstanceId)
      }

      return {
        instanceId: normalizedInstanceId,
        command,
        queued: true,
      }
    } catch (error) {
      throw mapWaHttpError(error)
    }
  }
}

function readCreateAccountBody(body: unknown): { teamId: string; instanceId: string } {
  if (!isRecord(body)) {
    throw new BadRequestException('body must be an object')
  }

  return {
    teamId: normalizeNonEmptyString(body.teamId, 'teamId'),
    instanceId: normalizeNonEmptyString(body.instanceId, 'instanceId'),
  }
}

function normalizeNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${fieldName} must be a non-empty string`)
  }

  const normalized = value.trim()
  if (normalized.length === 0) {
    throw new BadRequestException(`${fieldName} must be a non-empty string`)
  }

  return normalized
}

function mapWaHttpError(error: unknown): HttpException {
  if (error instanceof HttpException) return error
  if (error instanceof WaAccountAdminInvalidInputError) {
    return new BadRequestException(error.message)
  }
  if (error instanceof WaAccountAdminDuplicateInstanceError) {
    return new ConflictException(error.message)
  }
  if (error instanceof WaAccountAdminTeamNotFoundError) {
    return new NotFoundException(error.message)
  }
  if (error instanceof WaAccountCommandTargetNotFoundError) {
    return new NotFoundException(error.message)
  }

  throw error
}

function toWaAccountDto(account: WaAccount): WaAccountDto {
  return {
    id: account.id,
    teamId: account.teamId,
    instanceId: account.instanceId,
    loginType: account.loginType,
    status: account.status,
    pid: account.pid,
    restrictedUntil: account.restrictedUntil?.toISOString() ?? null,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
