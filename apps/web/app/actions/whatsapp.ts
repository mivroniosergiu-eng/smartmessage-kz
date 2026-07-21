'use server'

import { prisma } from '@smartmessage/db'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { getSession } from '../lib/auth'
import { isConfirmedWhatsappContact } from '../lib/whatsapp-policy'
import {
  workerAccountsSchema,
  workerAccountResponseSchema,
  workerCommandResponseSchema,
  queuedContactResponseSchema,
  workerQrResponseSchema,
  workerWaRequest,
  WorkerWaClientError,
} from '../lib/worker-wa-client'

const instanceIdSchema = z.string().trim().min(1).max(120)
const contactIdSchema = z.string().trim().min(1).max(120)
const phoneSchema = z.string().trim().min(3).max(32)
const textSchema = z.string().trim().min(1).max(4_000)
const idempotencySchema = z.string().trim().min(8).max(200)

export async function refreshWhatsappAccounts(): Promise<void> {
  await requireTeamSession()
  revalidatePath('/dashboard/whatsapp')
}

export async function startWhatsappAction(formData: FormData): Promise<void> {
  await runAccountCommand(formData, 'start')
}

export async function createWhatsappAccountAction(formData: FormData): Promise<void> {
  const session = await requireTeamSession()
  const instanceId = parseFormValue(formData, 'instanceId', instanceIdSchema)
  const team = await prisma.team.findFirst({
    where: { id: session.teamId, users: { some: { id: session.userId } } },
    include: { permissions: true },
  })
  if (!team) return redirectWithError('Команда не найдена')
  const accountCount = await prisma.waAccount.count({ where: { teamId: session.teamId } })
  const maxAccounts = team.permissions?.maxWhatsappAccounts ?? 1
  if (accountCount >= maxAccounts) {
    return redirectWithError('Лимит WhatsApp-аккаунтов вашего тарифа исчерпан')
  }

  try {
    await workerWaRequest(
      '/internal/wa/accounts',
      { method: 'POST', body: JSON.stringify({ teamId: session.teamId, instanceId }) },
      workerAccountResponseSchema,
    )
  } catch (error) {
    return redirectWithError(safeActionError(error))
  }
  revalidatePath('/dashboard/whatsapp')
  redirect('/dashboard/whatsapp')
}

export async function stopWhatsappAction(formData: FormData): Promise<void> {
  await runAccountCommand(formData, 'stop')
}

export async function logoutWhatsappAction(formData: FormData): Promise<void> {
  await runAccountCommand(formData, 'logout')
}

export async function validateWhatsappContactAction(formData: FormData): Promise<void> {
  const session = await requireTeamSession()
  const contactId = parseFormValue(formData, 'contactId', contactIdSchema)
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, teamId: session.teamId },
  })
  if (!contact) return redirectWithError('Контакт не найден в вашей команде')

  try {
    await workerWaRequest(
      '/internal/wa/contacts/validate',
      { method: 'POST', body: JSON.stringify({ contactId }) },
      queuedContactResponseSchema,
    )
  } catch (error) {
    return redirectWithError(safeActionError(error))
  }

  revalidatePath('/dashboard/whatsapp')
  redirect('/dashboard/whatsapp')
}

export async function sendWhatsappMessageAction(formData: FormData): Promise<void> {
  const session = await requireTeamSession()
  const instanceId = parseFormValue(formData, 'instanceId', instanceIdSchema)
  const contactId = parseFormValue(formData, 'contactId', contactIdSchema)
  const phone = parseFormValue(formData, 'phone', phoneSchema)
  const text = parseFormValue(formData, 'text', textSchema)
  const idempotencyKey = parseFormValue(formData, 'idempotencyKey', idempotencySchema)

  const [account, contact] = await Promise.all([
    prisma.waAccount.findFirst({ where: { instanceId, teamId: session.teamId } }),
    prisma.contact.findFirst({ where: { id: contactId, teamId: session.teamId } }),
  ])
  if (!account || !contact || contact.phone !== phone) {
    return redirectWithError('Аккаунт или контакт не найден в вашей команде')
  }
  if (!isConfirmedWhatsappContact(contact.isValid)) {
    return redirectWithError('Номер контакта не подтверждён для WhatsApp')
  }

  try {
    await workerWaRequest(
      `/internal/wa/accounts/${encodeURIComponent(instanceId)}/send-text`,
      {
        method: 'POST',
        body: JSON.stringify({ instanceId, contactId, text, idempotencyKey }),
      },
      workerCommandResponseSchema,
    )
  } catch (error) {
    return redirectWithError(safeActionError(error))
  }

  revalidatePath('/dashboard/whatsapp')
  redirect('/dashboard/whatsapp')
}

export async function getWhatsappQr(instanceId: string) {
  const session = await requireTeamSession()
  const normalizedInstanceId = instanceIdSchema.parse(instanceId)
  const account = await prisma.waAccount.findFirst({
    where: { instanceId: normalizedInstanceId, teamId: session.teamId },
  })
  if (!account) throw new Error('WA account not found')
  return workerWaRequest(
    `/internal/wa/accounts/${encodeURIComponent(normalizedInstanceId)}/qr`,
    { method: 'GET' },
    workerQrResponseSchema,
  )
}

export async function getWhatsappWorkerAccounts() {
  const session = await requireTeamSession()
  return workerWaRequest(
    `/internal/wa/accounts?teamId=${encodeURIComponent(session.teamId)}`,
    { method: 'GET' },
    workerAccountsSchema,
  )
}

async function runAccountCommand(formData: FormData, command: 'start' | 'stop' | 'logout') {
  const session = await requireTeamSession()
  const instanceId = parseFormValue(formData, 'instanceId', instanceIdSchema)
  const account = await prisma.waAccount.findFirst({
    where: { instanceId, teamId: session.teamId },
  })
  if (!account) return redirectWithError('WA аккаунт не найден в вашей команде')

  try {
    await workerWaRequest(
      `/internal/wa/accounts/${encodeURIComponent(instanceId)}/${command}`,
      { method: 'POST' },
      workerCommandResponseSchema,
    )
  } catch (error) {
    return redirectWithError(safeActionError(error))
  }

  revalidatePath('/dashboard/whatsapp')
  redirect('/dashboard/whatsapp')
}

async function requireTeamSession() {
  const session = await getSession()
  if (!session) redirect('/login')
  const user = await prisma.user.findFirst({
    where: { id: session.userId, teamId: session.teamId },
    select: { id: true, teamId: true },
  })
  if (!user) redirect('/login?invalidSession=1')
  return session
}

function parseFormValue<T>(formData: FormData, name: string, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(formData.get(name))
  if (!parsed.success) redirectWithError('Некорректные данные формы')
  return parsed.data
}

function safeActionError(error: unknown): string {
  if (error instanceof WorkerWaClientError) return error.message
  return 'Операция WhatsApp не выполнена'
}

function redirectWithError(message: string): never {
  const encoded = encodeURIComponent(message.slice(0, 160))
  redirect(`/dashboard/whatsapp?error=${encoded}`)
}
