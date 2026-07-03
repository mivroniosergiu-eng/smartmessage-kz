import { timingSafeEqual } from 'node:crypto'

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'

const INTERNAL_WORKER_TOKEN_HEADER = 'x-internal-worker-token'

@Injectable()
export class InternalWorkerApiGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expectedToken = process.env.WORKER_INTERNAL_API_TOKEN?.trim()
    if (!expectedToken) {
      throw new UnauthorizedException('Internal worker API is not configured')
    }

    const request = context.switchToHttp().getRequest<InternalWorkerRequest>()
    const token = readHeader(request.headers, INTERNAL_WORKER_TOKEN_HEADER)
    if (!token || !tokensEqual(token, expectedToken)) {
      throw new UnauthorizedException('Unauthorized')
    }

    return true
  }
}

function readHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name]
  if (Array.isArray(value)) return value[0]

  return value
}

function tokensEqual(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received)
  const expectedBuffer = Buffer.from(expected)

  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer)
}

interface InternalWorkerRequest {
  headers: Record<string, string | string[] | undefined>
}
