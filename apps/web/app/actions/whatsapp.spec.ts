import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSession, mockRedirect, mockRevalidatePath, mockWorkerWaRequest, prisma } = vi.hoisted(
  () => ({
    mockSession: vi.fn(),
    mockRedirect: vi.fn((url: string): never => {
      throw new Error(`REDIRECT:${url}`)
    }),
    mockRevalidatePath: vi.fn(),
    mockWorkerWaRequest: vi.fn(),
    prisma: {
      user: { findFirst: vi.fn() },
      team: { findFirst: vi.fn() },
      waAccount: { findFirst: vi.fn(), count: vi.fn() },
      contact: { findFirst: vi.fn() },
    },
  }),
)

vi.mock('@smartmessage/db', () => ({ prisma }))
vi.mock('../lib/auth', () => ({ getSession: mockSession }))
vi.mock('../lib/worker-wa-client', () => ({
  workerWaRequest: mockWorkerWaRequest,
  workerAccountsSchema: {},
  workerAccountResponseSchema: {},
  workerCommandResponseSchema: {},
  queuedContactResponseSchema: {},
  workerQrResponseSchema: {},
  WorkerWaClientError: class extends Error {},
}))
vi.mock('next/navigation', () => ({ redirect: mockRedirect }))
vi.mock('next/cache', () => ({ revalidatePath: mockRevalidatePath }))

import {
  createWhatsappAccountAction,
  logoutWhatsappAction,
  sendWhatsappMessageAction,
  startWhatsappAction,
  stopWhatsappAction,
  validateWhatsappContactAction,
} from './whatsapp'

describe('WhatsApp server actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('WORKER_INTERNAL_API_TOKEN', 'worker-token-for-test')
    mockWorkerWaRequest.mockResolvedValue({ queued: true })
    mockSession.mockResolvedValue({
      userId: 'user-1',
      teamId: 'team-1',
      email: 'owner@example.com',
      role: 'OWNER',
    })
    prisma.user.findFirst.mockResolvedValue({ id: 'user-1', teamId: 'team-1' })
    prisma.team.findFirst.mockResolvedValue({
      id: 'team-1',
      permissions: { maxWhatsappAccounts: 2 },
    })
    prisma.waAccount.count.mockResolvedValue(0)
  })

  it('rejects cross-tenant contact before contacting the worker', async () => {
    prisma.contact.findFirst.mockResolvedValue(null)
    const form = new FormData()
    form.set('contactId', 'contact-other')

    await expect(validateWhatsappContactAction(form)).rejects.toThrow('REDIRECT:')
    expect(mockWorkerWaRequest).not.toHaveBeenCalled()
  })

  it('rejects cross-tenant account/contact pair before single-send enqueue', async () => {
    prisma.waAccount.findFirst.mockResolvedValue(null)
    prisma.contact.findFirst.mockResolvedValue({
      id: 'contact-1',
      teamId: 'team-1',
      phone: '+77001234567',
    })
    const form = new FormData()
    form.set('instanceId', 'instance-other')
    form.set('contactId', 'contact-1')
    form.set('phone', '+77001234567')
    form.set('text', 'hello')
    form.set('idempotencyKey', 'request-12345')

    await expect(sendWhatsappMessageAction(form)).rejects.toThrow('REDIRECT:')
    expect(mockWorkerWaRequest).not.toHaveBeenCalled()
  })

  it('rejects a non-confirmed contact before single-send enqueue', async () => {
    prisma.waAccount.findFirst.mockResolvedValue({ instanceId: 'instance-owned', teamId: 'team-1' })
    prisma.contact.findFirst.mockResolvedValue({
      id: 'contact-1',
      teamId: 'team-1',
      phone: '+77001234567',
      isValid: 'NOT_ON_WHATSAPP',
    })
    const form = new FormData()
    form.set('instanceId', 'instance-owned')
    form.set('contactId', 'contact-1')
    form.set('phone', '+77001234567')
    form.set('text', 'hello')
    form.set('idempotencyKey', 'request-12345')

    await expect(sendWhatsappMessageAction(form)).rejects.toThrow('REDIRECT:')
    expect(mockWorkerWaRequest).not.toHaveBeenCalled()
  })

  it('enqueues single-send for a confirmed tenant contact', async () => {
    prisma.waAccount.findFirst.mockResolvedValue({ instanceId: 'instance-owned', teamId: 'team-1' })
    prisma.contact.findFirst.mockResolvedValue({
      id: 'contact-1',
      teamId: 'team-1',
      phone: '+77001234567',
      isValid: 'CONFIRMED',
    })
    const form = new FormData()
    form.set('instanceId', 'instance-owned')
    form.set('contactId', 'contact-1')
    form.set('phone', '+77001234567')
    form.set('text', 'hello')
    form.set('idempotencyKey', 'request-12345')

    await expect(sendWhatsappMessageAction(form)).rejects.toThrow('REDIRECT:/dashboard/whatsapp')
    expect(mockWorkerWaRequest).toHaveBeenCalledWith(
      '/internal/wa/accounts/instance-owned/send-text',
      {
        method: 'POST',
        body: JSON.stringify({
          instanceId: 'instance-owned',
          contactId: 'contact-1',
          text: 'hello',
          idempotencyKey: 'request-12345',
        }),
      },
      expect.anything(),
    )
  })

  it.each([
    ['create', createWhatsappAccountAction],
    ['start', startWhatsappAction],
    ['stop', stopWhatsappAction],
    ['logout', logoutWhatsappAction],
    ['validate', validateWhatsappContactAction],
    ['send', sendWhatsappMessageAction],
  ] as const)(
    'redirects malformed %s form data without contacting the worker',
    async (_name, action) => {
      await expect(action(new FormData())).rejects.toThrow('REDIRECT:/dashboard/whatsapp?error=')
      expect(mockWorkerWaRequest).not.toHaveBeenCalled()
    },
  )

  it('creates a tenant-scoped account only while the plan limit allows it', async () => {
    const form = new FormData()
    form.set('instanceId', 'instance-new')

    await expect(createWhatsappAccountAction(form)).rejects.toThrow('REDIRECT:/dashboard/whatsapp')
    expect(prisma.team.findFirst).toHaveBeenCalled()
    expect(prisma.waAccount.count).toHaveBeenCalled()
    expect(mockWorkerWaRequest).toHaveBeenCalledWith(
      '/internal/wa/accounts',
      { method: 'POST', body: JSON.stringify({ teamId: 'team-1', instanceId: 'instance-new' }) },
      expect.anything(),
    )

    prisma.waAccount.count.mockResolvedValueOnce(2)
    await expect(createWhatsappAccountAction(form)).rejects.toThrow(
      `REDIRECT:/dashboard/whatsapp?error=${encodeURIComponent('Лимит WhatsApp-аккаунтов вашего тарифа исчерпан')}`,
    )
    expect(mockWorkerWaRequest).toHaveBeenCalledOnce()
  })

  it.each([
    ['start', startWhatsappAction],
    ['stop', stopWhatsappAction],
    ['logout', logoutWhatsappAction],
  ] as const)(
    'queues the %s lifecycle command for a tenant-owned account',
    async (command, action) => {
      prisma.waAccount.findFirst.mockResolvedValue({
        instanceId: 'instance-owned',
        teamId: 'team-1',
      })
      const form = new FormData()
      form.set('instanceId', 'instance-owned')

      await expect(action(form)).rejects.toThrow('REDIRECT:/dashboard/whatsapp')

      expect(prisma.waAccount.findFirst).toHaveBeenCalledWith({
        where: { instanceId: 'instance-owned', teamId: 'team-1' },
      })
      expect(mockWorkerWaRequest).toHaveBeenCalledWith(
        `/internal/wa/accounts/instance-owned/${command}`,
        { method: 'POST' },
        expect.anything(),
      )
      expect(mockRevalidatePath).toHaveBeenCalledWith('/dashboard/whatsapp')
    },
  )
})
