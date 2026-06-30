import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { prisma } from '@smartmessage/db'
import { hashPassword, verifyPassword, encryptSession, decryptSession } from './lib/auth'
import { registerAction, loginAction, logoutAction } from './actions/auth'

// Заглушка для Next.js cookies и redirect
const mockCookies = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
}

vi.mock('next/headers', () => ({
  cookies: () => mockCookies,
}))

const mockRedirect = vi.fn()
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    mockRedirect(url)
    // Next.js redirect кидает специальную ошибку, имитируем это
    throw new Error('NEXT_REDIRECT')
  },
}))

describe('Auth Utilities', () => {
  it('должен правильно хэшировать и проверять пароли', () => {
    const password = 'mySecretPassword123'
    const hash = hashPassword(password)
    
    expect(hash).toContain(':')
    expect(verifyPassword(password, hash)).toBe(true)
    expect(verifyPassword('wrongPassword', hash)).toBe(false)
  })

  it('должен кодировать, подписывать и декодировать сессии', () => {
    const payload = { userId: '123', email: 'test@mail.com', role: 'OWNER' }
    const token = encryptSession(payload)
    
    expect(token).toContain('.')
    
    const decoded = decryptSession(token)
    expect(decoded).toEqual(payload)

    // Проверка невалидной сигнатуры
    const tamperedToken = token.slice(0, -5) + 'xxxxx'
    expect(decryptSession(tamperedToken)).toBeNull()
  })
})

describe('Auth Server Actions', () => {
  const testEmail = 'test-action@mail.com'
  const testPassword = 'securePassword123'
  const testTeamName = 'Action Test Team'

  beforeEach(async () => {
    vi.clearAllMocks()
    // Очищаем тестовые данные перед каждым прогоном
    await prisma.user.deleteMany({ where: { email: testEmail } })
    await prisma.team.deleteMany({ where: { name: testTeamName } })
  })

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: testEmail } })
    await prisma.team.deleteMany({ where: { name: testTeamName } })
    await prisma.$disconnect()
  })

  it('registerAction: должен регистрировать нового пользователя и инициализировать лимиты команды', async () => {
    const formData = new FormData()
    formData.append('email', testEmail)
    formData.append('password', testPassword)
    formData.append('teamName', testTeamName)

    try {
      await registerAction(null, formData)
    } catch (e: any) {
      expect(e.message).toBe('NEXT_REDIRECT')
    }

    // Проверяем, что пользователь создан
    const user = await prisma.user.findUnique({
      where: { email: testEmail },
      include: {
        team: {
          include: {
            permissions: true,
            subscription: true,
            stats: true,
          },
        },
      },
    })

    expect(user).not.toBeNull()
    expect(user?.email).toBe(testEmail)
    expect(verifyPassword(testPassword, user!.passwordHash)).toBe(true)
    expect(user?.role).toBe('OWNER')
    
    // Проверяем инициализацию связанных таблиц
    expect(user?.team.name).toBe(testTeamName)
    expect(user?.team.permissions).not.toBeNull()
    expect(user?.team.permissions?.tier).toBe('STARTER')
    expect(user?.team.subscription).not.toBeNull()
    expect(user?.team.stats).not.toBeNull()

    // Проверяем, что была установлена сессионная кука
    expect(mockCookies.set).toHaveBeenCalled()
    expect(mockRedirect).toHaveBeenCalledWith('/dashboard')
  })

  it('registerAction: должен возвращать ошибку при невалидном email', async () => {
    const formData = new FormData()
    formData.append('email', 'invalid-email')
    formData.append('password', testPassword)
    formData.append('teamName', testTeamName)

    const result = await registerAction(null, formData)
    expect(result?.error).toBe('Некорректный формат email')
  })

  it('loginAction: должен авторизовывать пользователя при верных данных', async () => {
    // Сначала регистрируем
    const hash = hashPassword(testPassword)
    const team = await prisma.team.create({ data: { name: testTeamName } })
    await prisma.user.create({
      data: {
        email: testEmail,
        passwordHash: hash,
        role: 'OWNER',
        teamId: team.id,
      },
    })

    const formData = new FormData()
    formData.append('email', testEmail)
    formData.append('password', testPassword)

    try {
      await loginAction(null, formData)
    } catch (e: any) {
      expect(e.message).toBe('NEXT_REDIRECT')
    }

    expect(mockCookies.set).toHaveBeenCalled()
    expect(mockRedirect).toHaveBeenCalledWith('/dashboard')
  })

  it('loginAction: должен возвращать ошибку при неверном пароле', async () => {
    // Регистрируем
    const hash = hashPassword(testPassword)
    const team = await prisma.team.create({ data: { name: testTeamName } })
    await prisma.user.create({
      data: {
        email: testEmail,
        passwordHash: hash,
        role: 'OWNER',
        teamId: team.id,
      },
    })

    const formData = new FormData()
    formData.append('email', testEmail)
    formData.append('password', 'wrongPassword')

    const result = await loginAction(null, formData)
    expect(result?.error).toBe('Неверный email или пароль')
    expect(mockCookies.set).not.toHaveBeenCalled()
  })

  it('logoutAction: должен удалять куку сессии и перенаправлять на страницу входа', async () => {
    try {
      await logoutAction()
    } catch (e: any) {
      expect(e.message).toBe('NEXT_REDIRECT')
    }

    expect(mockCookies.delete).toHaveBeenCalledWith('session')
    expect(mockRedirect).toHaveBeenCalledWith('/login')
  })
})
