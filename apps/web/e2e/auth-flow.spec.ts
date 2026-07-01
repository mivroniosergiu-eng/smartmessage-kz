import { test, expect } from '@playwright/test'
import { prisma } from '@smartmessage/db'

const runId = Date.now()
const email = `phase0-e2e-${runId}@example.test`
const password = 'securePassword123'
const teamName = `Phase 0 E2E ${runId}`

test.afterAll(async () => {
  await prisma.user.deleteMany({ where: { email } })
  await prisma.team.deleteMany({ where: { name: teamName } })
  await prisma.$disconnect()
})

test('registration, logout, login, and protected dashboard route work', async ({ page, context }) => {
  await context.clearCookies()

  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/login$/)

  await page.goto('/register')
  await page.locator('input[name="teamName"]').fill(teamName)
  await page.locator('input[name="email"]').fill(email)
  await page.locator('input[name="password"]').fill(password)
  await page.locator('form button[type="submit"]').click()

  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.locator('body')).toContainText(email)

  await page.locator('.dashboard-header form button[type="submit"]').click()
  await expect(page).toHaveURL(/\/login$/)

  await page.locator('input[name="email"]').fill(email)
  await page.locator('input[name="password"]').fill(password)
  await page.locator('form button[type="submit"]').click()

  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.locator('body')).toContainText(email)

  await context.clearCookies()
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/login$/)
})
