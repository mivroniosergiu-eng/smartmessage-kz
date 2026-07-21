import { expect, test } from '@playwright/test'
import { prisma } from '@smartmessage/db'

const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
const email = `phase1-wa-${runId}@example.test`
const password = 'securePassword123'
const teamName = `Phase 1 WA E2E ${runId}`
const foreignTeamName = `Phase 1 WA foreign ${runId}`
const instanceId = `wa-e2e-${runId}`
const connectedInstanceId = `wa-connected-${runId}`
const foreignInstanceId = `wa-foreign-${runId}`
const qrPayload = `qr-test-payload-${runId}`
const phone = '+77001234567'
const confirmedPhone = '+77001234568'

test.afterAll(async () => {
  await prisma.team.deleteMany({ where: { name: { in: [teamName, foreignTeamName] } } })
  await prisma.$disconnect()
})

test('WhatsApp page is protected and renders only the current team data', async ({
  page,
  context,
}) => {
  await context.clearCookies()
  await page.goto('/dashboard/whatsapp')
  await expect(page).toHaveURL(/\/login$/)

  await page.goto('/register')
  await page.locator('input[name="teamName"]').fill(teamName)
  await page.locator('input[name="email"]').fill(email)
  await page.locator('input[name="password"]').fill(password)
  await page.locator('form button[type="submit"]').click()
  await expect(page).toHaveURL(/\/dashboard$/)

  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { teamId: true },
  })
  await prisma.waAccount.create({
    data: {
      teamId: user.teamId,
      instanceId,
      status: 'CONNECTING',
      ownershipEpoch: 1n,
      qrBootstrapEvent: {
        create: {
          qrCode: qrPayload,
          ownershipEpoch: 1n,
          expiresAt: new Date(Date.now() + 60_000),
        },
      },
    },
  })
  await prisma.waAccount.create({
    data: {
      teamId: user.teamId,
      instanceId: connectedInstanceId,
      status: 'CONNECTED',
      ownerWorkerId: 'e2e-owner',
      ownershipEpoch: 1n,
    },
  })
  await prisma.contact.create({
    data: { teamId: user.teamId, phone, name: 'Тестовый контакт' },
  })
  await prisma.contact.create({
    data: {
      teamId: user.teamId,
      phone: confirmedPhone,
      name: 'Подтверждённый контакт',
      isValid: 'CONFIRMED',
    },
  })
  await prisma.team.create({
    data: {
      name: foreignTeamName,
      waAccounts: { create: { instanceId: foreignInstanceId } },
      contacts: { create: { phone: '+77007654321', name: 'Чужой контакт' } },
    },
  })

  await page.goto('/dashboard')
  await page.getByRole('link', { name: 'Открыть WhatsApp' }).click()
  await expect(page).toHaveURL(/\/dashboard\/whatsapp$/)
  await expect(page.getByRole('heading', { name: 'WhatsApp' })).toBeVisible()
  await expect(page.getByText(instanceId, { exact: true })).toBeVisible()
  await expect(page.getByText(connectedInstanceId, { exact: true })).toBeVisible()
  await expect(
    page.getByRole('img', { name: `QR-код для подключения WhatsApp ${instanceId}` }),
  ).toBeVisible()
  await expect(page.getByText(qrPayload, { exact: true })).toHaveCount(0)
  await expect(page.getByText('Тестовый контакт', { exact: true })).toBeVisible()
  await expect(page.getByText(phone, { exact: false })).toBeVisible()
  const unconfirmedContact = page.locator('article').filter({ hasText: phone })
  await expect(unconfirmedContact.locator('input[name="text"]')).toHaveCount(0)
  await expect(
    unconfirmedContact.getByText('Подтвердите номер перед отправкой сообщения.'),
  ).toBeVisible()
  const confirmedContact = page.locator('article').filter({ hasText: confirmedPhone })
  await expect(confirmedContact.locator('input[name="text"]')).toHaveCount(1)
  await expect(page.getByText(foreignInstanceId, { exact: true })).toHaveCount(0)
  await expect(page.getByText('Чужой контакт', { exact: true })).toHaveCount(0)
  await expect(
    page.locator(`form input[name="instanceId"][value="${connectedInstanceId}"]`),
  ).toHaveCount(4)
})
