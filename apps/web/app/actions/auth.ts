'use server'

import { z } from 'zod'
import { prisma } from '@smartmessage/db'
import type { Prisma } from '@smartmessage/db'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { hashPassword, verifyPassword, encryptSession } from '../lib/auth'
import { SESSION_TTL_SECONDS } from '../lib/session'

const INVALID_EMAIL_MESSAGE = 'Некорректный формат email'
const DUPLICATE_EMAIL_ERROR = 'Пользователь с таким email уже зарегистрирован'
const INVALID_CREDENTIALS_ERROR = 'Неверный email или пароль'

const RegisterSchema = z.object({
  email: z.string().email({ message: INVALID_EMAIL_MESSAGE }),
  password: z.string().min(6, { message: 'Пароль должен содержать не менее 6 символов' }),
  teamName: z.string().min(1, { message: 'Название команды не может быть пустым' }),
})

const LoginSchema = z.object({
  email: z.string().email({ message: INVALID_EMAIL_MESSAGE }),
  password: z.string().min(1, { message: 'Пароль не может быть пустым' }),
})

export type FormState = {
  error?: string
  success?: boolean
} | null

export async function registerAction(
  _prevState: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = formData.get('email') as string
  const password = formData.get('password') as string
  const teamName = formData.get('teamName') as string

  const validation = RegisterSchema.safeParse({ email, password, teamName })
  if (!validation.success) {
    return { error: validation.error.errors[0].message }
  }

  try {
    const existingUser = await prisma.user.findUnique({
      where: { email },
    })

    if (existingUser) {
      return { error: DUPLICATE_EMAIL_ERROR }
    }

    const passwordHash = hashPassword(password)

    const user = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const team = await tx.team.create({
        data: {
          name: teamName,
        },
      })

      const newUser = await tx.user.create({
        data: {
          email,
          passwordHash,
          role: 'OWNER',
          teamId: team.id,
        },
      })

      await tx.subscription.create({
        data: {
          teamId: team.id,
          tier: 'STARTER',
          status: 'TRIALING',
          paymentProvider: 'stub',
        },
      })

      await tx.permissions.create({
        data: {
          teamId: team.id,
          tier: 'STARTER',
          monthlyBroadcastMessages: 10000,
          monthlyAiGenerations: 500,
          maxWhatsappAccounts: 1,
        },
      })

      await tx.stats.create({
        data: {
          teamId: team.id,
          waTimeReset: new Date(),
        },
      })

      await tx.auditLog.create({
        data: {
          teamId: team.id,
          userId: newUser.id,
          action: 'register_team',
          details: `Registered team "${teamName}" and owner user "${email}"`,
        },
      })

      return newUser
    })

    const sessionToken = encryptSession({
      userId: user.id,
      email: user.email,
      teamId: user.teamId,
      role: user.role,
    })

    const cookieStore = await cookies()
    cookieStore.set('session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return { error: DUPLICATE_EMAIL_ERROR }
    }

    console.error('Registration error:', error)
    return { error: 'Произошла внутренняя ошибка при регистрации' }
  }

  redirect('/dashboard')
}

export async function loginAction(_prevState: FormState, formData: FormData): Promise<FormState> {
  const email = formData.get('email') as string
  const password = formData.get('password') as string

  const validation = LoginSchema.safeParse({ email, password })
  if (!validation.success) {
    return { error: validation.error.errors[0].message }
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email },
    })

    if (!user || !verifyPassword(password, user.passwordHash)) {
      return { error: INVALID_CREDENTIALS_ERROR }
    }

    const sessionToken = encryptSession({
      userId: user.id,
      email: user.email,
      teamId: user.teamId,
      role: user.role,
    })

    const cookieStore = await cookies()
    cookieStore.set('session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    })
  } catch (error) {
    console.error('Login error:', error)
    return { error: 'Произошла внутренняя ошибка при авторизации' }
  }

  redirect('/dashboard')
}

export async function logoutAction(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete('session')
  redirect('/login')
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}
