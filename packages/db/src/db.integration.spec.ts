import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const A = 'itest-team-a'
const B = 'itest-team-b'

describe('multi-tenant isolation', () => {
  beforeAll(async () => {
    await prisma.team.deleteMany({ where: { id: { in: [A, B] } } })
    await prisma.team.create({ data: { id: A, name: 'A', leads: { create: { phone: '+77010000001', consentStatus: 'OPTED_IN' } } } })
    await prisma.team.create({ data: { id: B, name: 'B', leads: { create: { phone: '+77010000001', consentStatus: 'OPTED_IN' } } } })
  })
  afterAll(async () => {
    await prisma.team.deleteMany({ where: { id: { in: [A, B] } } })
    await prisma.$disconnect()
  })
  it('запрос лидов команды A не возвращает лидов команды B', async () => {
    const aLeads = await prisma.lead.findMany({ where: { teamId: A } })
    expect(aLeads).toHaveLength(1)
    expect(aLeads.every((l) => l.teamId === A)).toBe(true)
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
    expect(contacts.map((contact) => contact.isValid).sort()).toEqual(['CONFIRMED', 'NOT_ON_WHATSAPP'])
  })
})
