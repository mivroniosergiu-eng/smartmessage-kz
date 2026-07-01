import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const team = await prisma.team.upsert({
    where: { id: 'demo-team' },
    update: {},
    create: {
      id: 'demo-team',
      name: 'Demo Agency',
      users: { create: { email: 'owner@demo.kz', passwordHash: 'seed-not-a-real-hash', role: 'OWNER' } },
      subscription: { create: { tier: 'GROWTH', status: 'ACTIVE', paymentProvider: 'paddle' } },
      leads: {
        create: [
          { phone: '+77011112233', name: 'Лид 1', utmSource: 'instagram', consentStatus: 'OPTED_IN', consentAt: new Date() },
          { phone: '+77014445566', name: 'Лид 2', utmSource: 'google', consentStatus: 'UNKNOWN' },
        ],
      },
    },
  })
  console.log('seeded team', team.id)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
