import 'reflect-metadata'

import type { ExecutionContext } from '@nestjs/common'
import { UnauthorizedException } from '@nestjs/common'
import { afterEach, describe, expect, it } from 'vitest'

import { InternalWorkerApiGuard } from './internal-worker-api.guard'

const originalToken = process.env.WORKER_INTERNAL_API_TOKEN

describe('InternalWorkerApiGuard', () => {
  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.WORKER_INTERNAL_API_TOKEN
    } else {
      process.env.WORKER_INTERNAL_API_TOKEN = originalToken
    }
  })

  it('fails closed when WORKER_INTERNAL_API_TOKEN is not configured', () => {
    delete process.env.WORKER_INTERNAL_API_TOKEN

    expect(() => new InternalWorkerApiGuard().canActivate(createContext('worker-token'))).toThrow(
      UnauthorizedException,
    )
  })

  it.each(['   ', 'change_me_to_a_random_internal_token'])(
    'fails closed for an empty or known placeholder token: %j',
    (token) => {
      process.env.WORKER_INTERNAL_API_TOKEN = token

      expect(() => new InternalWorkerApiGuard().canActivate(createContext(token))).toThrow(
        UnauthorizedException,
      )
    },
  )

  it('rejects requests without the internal token header', () => {
    process.env.WORKER_INTERNAL_API_TOKEN = 'worker-token'

    expect(() => new InternalWorkerApiGuard().canActivate(createContext(undefined))).toThrow(
      UnauthorizedException,
    )
  })

  it('rejects requests with the wrong internal token header', () => {
    process.env.WORKER_INTERNAL_API_TOKEN = 'worker-token'

    expect(() => new InternalWorkerApiGuard().canActivate(createContext('wrong-token'))).toThrow(
      UnauthorizedException,
    )
  })

  it('accepts requests with the correct internal token header', () => {
    process.env.WORKER_INTERNAL_API_TOKEN = 'worker-token'

    expect(new InternalWorkerApiGuard().canActivate(createContext('worker-token'))).toBe(true)
  })
})

function createContext(token: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: token === undefined ? {} : { 'x-internal-worker-token': token },
      }),
    }),
  } as ExecutionContext
}
