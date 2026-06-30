'use server'

import { z } from 'zod'
import { prisma } from '@smartmessage/db'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { hashPassword, verifyPassword, encryptSession } from '../lib/auth'

const RegisterSchema = z.object({
  email: z.string().email({ message: 'Некорректный формат email' }),
  password: z.string().min(6, { message: 'Пароль должен быть не менее 6 символов' }),
  teamName: z.string().min(1, { message: 'Имя команды не может быть пустым' }),
})

const LoginSchema = z.object({
  email: z.string().email({ message: 'Некорректный формат email' }),
  password: z.string().min(1, { message: 'Пароль не может быть пустым' }),
})

export type FormState = {
  error?: string
  success?: boolean
} | null

/**
 * Server Action для регистрации нового пользователя и создания команды.
 */
export async function registerAction(prevState: FormState, formData: FormData): Promise<FormState> {
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
      return { error: 'Пользователь с таким email уже зарегистрирован' }
    }

    const passwordHash = hashPassword(password)

    // Выполняем создание команды, пользователя и связанных сущностей в транзакции
    const user = await prisma.$transaction(async (tx) => {
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

      // Инициализируем Subscription
      await tx.subscription.create({
        data: {
          teamId: team.id,
          tier: 'STARTER',
          status: 'TRIALING',
          paymentProvider: 'stub',
        },
      })

      // Инициализируем Permissions (лимиты Starter-тарифа)
      await tx.permissions.create({
        data: {
          teamId: team.id,
          tier: 'STARTER',
          monthlyBroadcastMessages: 10000,
          monthlyAiGenerations: 500,
          maxWhatsappAccounts: 1,
        },
      })

      // Инициализируем Stats
      await tx.stats.create({
        data: {
          teamId: team.id,
          waTimeReset: new Date(),
        },
      })

      // Записываем лог аудита
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

    // Устанавливаем куку сессии
    const sessionToken = encryptSession({
      userId: user.id,
      email: user.email,
      teamId: user.teamId,
      role: user.role,
    })

    cookies().set('session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 7 дней
    })

  } catch (error) {
    console.error('Registration error:', error)
    return { error: 'Произошла внутренняя ошибка при регистрации' }
  }

  // Редирект должен быть вне блока try-catch, так как он бросает специальное исключение
  redirect('/dashboard')
}

/**
 * Server Action для входа пользователя.
 */
export async function loginAction(prevState: FormState, formData: FormData): Promise<FormState> {
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
      return { error: 'Неверный email или пароль' }
    }

    // Устанавливаем куку сессии
    const sessionToken = encryptSession({
      userId: user.id,
      email: user.email,
      teamId: user.teamId,
      role: user.role,
    })

    cookies().set('session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 7 дней
    })

  } catch (error) {
    console.error('Login error:', error)
    return { error: 'Произошла внутренняя ошибка при авторизации' }
  }

  redirect('/dashboard')
}

/**
 * Server Action для выхода.
 */
export async function logoutAction(): Promise<void> {
  cookies().delete('session')
  redirect('/login')
}
