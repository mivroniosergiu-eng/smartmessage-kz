import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const A = 'itest-team-a'
const B = 'itest-team-b'
const C = 'itest-team-c'

describe('multi-tenant isolation', () => {
  beforeAll(async () => {
    await prisma.team.deleteMany({ where: { id: { in: [A, B, C] } } })
    await prisma.team.create({ data: { id: A, name: 'A', leads: { create: { phone: '+77010000001', consentStatus: 'OPTED_IN' } } } })
    await prisma.team.create({ data: { id: B, name: 'B', leads: { create: { phone: '+77010000001', consentStatus: 'OPTED_IN' } } } })
  })
  afterAll(async () => {
    await prisma.team.deleteMany({ where: { id: { in: [A, B, C] } } })
    await prisma.$disconnect()
  })
  it('запрос лидов команды A не возвращает лидов команды B', async () => {
    const aLeads = await prisma.lead.findMany({ where: { teamId: A } })
    expect(aLeads).toHaveLength(1)
    expect(aLeads.every((lead: { teamId: string }) => lead.teamId === A)).toBe(true)
  })
  it('один и тот же телефон допустим в разных командах', async () => {
    const all = await prisma.lead.findMany({ where: { phone: '+77010000001', teamId: { in: [A, B] } } })
    expect(all).toHaveLength(2)
  })

  it('контакты уникальны внутри команды, но могут повторяться между командами', async () => {
    await prisma.contact.deleteMany({ where: { teamId: { in: [A, B] } } })
    await prisma.contact.create({
      data: { teamId: A, phone: '+77010000002', name: 'A Contact', isValid: 'CONFIRMED' },
    })
    await prisma.contact.create({
      data: { teamId: B, phone: '+77010000002', name: 'B Contact', isValid: 'NOT_ON_WHATSAPP' },
    })

    await expect(
      prisma.contact.create({
        data: { teamId: A, phone: '+77010000002', name: 'Duplicate' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' })

    const contacts = await prisma.contact.findMany({ where: { phone: '+77010000002', teamId: { in: [A, B] } } })
    expect(contacts).toHaveLength(2)
    expect(contacts.map((contact: { isValid: string | null }) => contact.isValid).sort()).toEqual([
      'CONFIRMED',
      'NOT_ON_WHATSAPP',
    ])
  })

  it('phase 0 tenant contracts enforce defaults, attribution, billing uniqueness, and relations', async () => {
    const team = await prisma.team.create({ data: { id: C, name: 'C' } })
    const user = await prisma.user.create({
      data: {
        email: 'itest-member@example.com',
        passwordHash: 'legacy-salt:legacy-hash',
        teamId: team.id,
      },
    })
    const lead = await prisma.lead.create({
      data: {
        teamId: team.id,
        phone: '+77010000003',
      },
    })

    expect(user.role).toBe('MEMBER')
    expect(lead.source).toBe('MANUAL')

    await prisma.subscription.create({
      data: {
        teamId: team.id,
        paymentProvider: 'stub',
        providerCustomerId: 'cus_itest_unique',
      },
    })
    await expect(
      prisma.subscription.create({
        data: {
          teamId: A,
          paymentProvider: 'stub',
          providerCustomerId: 'cus_itest_unique',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' })

    await prisma.waAccount.create({
      data: {
        teamId: team.id,
        instanceId: 'itest-instance-c',
      },
    })
    await prisma.waSession.create({
      data: {
        teamId: team.id,
        instanceId: 'itest-instance-c',
        status: 'CONNECTED',
      },
    })
    await prisma.messageLog.create({
      data: {
        teamId: team.id,
        instanceId: 'itest-instance-c',
        phone: '+77010000003',
        type: 'text',
        message: 'hello',
      },
    })
    await prisma.auditLog.create({
      data: {
        teamId: team.id,
        userId: user.id,
        action: 'itest',
      },
    })

    await prisma.team.delete({ where: { id: team.id } })

    await expect(prisma.waSession.findMany({ where: { teamId: team.id } })).resolves.toHaveLength(0)
    await expect(prisma.messageLog.findMany({ where: { teamId: team.id } })).resolves.toHaveLength(0)
    await expect(prisma.auditLog.findMany({ where: { teamId: team.id } })).resolves.toHaveLength(0)
  })
})
