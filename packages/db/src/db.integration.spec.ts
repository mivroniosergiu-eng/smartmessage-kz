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
    const all = await prisma.lead.findMany({ where: { phone: '+77010000001' } })
    expect(all).toHaveLength(2)
  })
})
