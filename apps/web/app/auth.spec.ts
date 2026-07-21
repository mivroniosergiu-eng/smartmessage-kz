import crypto from 'crypto'
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import { prisma } from '@smartmessage/db'
import { hashPassword, verifyPassword, encryptSession, decryptSession } from './lib/auth'
import { registerAction, loginAction, logoutAction } from './actions/auth'

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
    throw new Error('NEXT_REDIRECT')
  },
}))

describe('Auth Utilities', () => {
  it('hashes and verifies passwords with encoded KDF parameters', () => {
    const password = 'mySecretPassword123'
    const hash = hashPassword(password)
    const [algorithm, digest, iterations, salt, derivedKey] = hash.split(':')

    expect(algorithm).toBe('pbkdf2')
    expect(digest).toBe('sha512')
    expect(Number(iterations)).toBeGreaterThanOrEqual(210000)
    expect(salt).toHaveLength(32)
    expect(derivedKey).toHaveLength(128)
    expect(verifyPassword(password, hash)).toBe(true)
    expect(verifyPassword('wrongPassword', hash)).toBe(false)
  })

  it('supports legacy salt:hash password hashes', () => {
    const password = 'legacyPassword123'
    const salt = '0123456789abcdef0123456789abcdef'
    const legacyHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex')

    expect(verifyPassword(password, `${salt}:${legacyHash}`)).toBe(true)
    expect(verifyPassword('wrongPassword', `${salt}:${legacyHash}`)).toBe(false)
  })

  it('encodes, signs, and decodes sessions', () => {
    const payload = { userId: '123', email: 'test@mail.com', role: 'OWNER' }
    const token = encryptSession(payload)

    expect(token).toContain('.')
    expect(decryptSession(token)).toEqual(payload)

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
    await prisma.user.deleteMany({ where: { email: testEmail } })
    await prisma.team.deleteMany({ where: { name: testTeamName } })
  })

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: testEmail } })
    await prisma.team.deleteMany({ where: { name: testTeamName } })
    await prisma.$disconnect()
  })

  it('registerAction creates owner user and initializes team limits', async () => {
    const formData = new FormData()
    formData.append('email', testEmail)
    formData.append('password', testPassword)
    formData.append('teamName', testTeamName)

    try {
      await registerAction(null, formData)
    } catch (error: any) {
      expect(error.message).toBe('NEXT_REDIRECT')
    }

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
    expect(user?.team.name).toBe(testTeamName)
    expect(user?.team.permissions).not.toBeNull()
    expect(user?.team.permissions?.tier).toBe('STARTER')
    expect(user?.team.subscription).not.toBeNull()
    expect(user?.team.stats).not.toBeNull()
    expect(mockCookies.set).toHaveBeenCalled()
    expect(mockRedirect).toHaveBeenCalledWith('/dashboard')
  })

  it('registerAction returns validation error for invalid email', async () => {
    const formData = new FormData()
    formData.append('email', 'invalid-email')
    formData.append('password', testPassword)
    formData.append('teamName', testTeamName)

    const result = await registerAction(null, formData)

    expect(result?.error).toBe('Некорректный формат email')
  })

  it('registerAction returns a readable validation error for a short password', async () => {
    const formData = new FormData()
    formData.append('email', testEmail)
    formData.append('password', '1234')
    formData.append('teamName', testTeamName)

    const result = await registerAction(null, formData)

    expect(result?.error).toBe('Пароль должен содержать не менее 6 символов')
  })

  it('registerAction handles P2002 as duplicate email', async () => {
    const formData = new FormData()
    formData.append('email', testEmail)
    formData.append('password', testPassword)
    formData.append('teamName', testTeamName)
    const transactionSpy = vi.spyOn(prisma, '$transaction')
    transactionSpy.mockRejectedValueOnce({ code: 'P2002' } as never)

    const result = await registerAction(null, formData)

    expect(result?.error).toBe('Пользователь с таким email уже зарегистрирован')
    transactionSpy.mockRestore()
  })

  it('loginAction signs in with valid credentials', async () => {
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
    } catch (error: any) {
      expect(error.message).toBe('NEXT_REDIRECT')
    }

    expect(mockCookies.set).toHaveBeenCalled()
    expect(mockRedirect).toHaveBeenCalledWith('/dashboard')
  })

  it('loginAction returns error for invalid password', async () => {
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

  it('logoutAction deletes session cookie and redirects to login', async () => {
    try {
      await logoutAction()
    } catch (error: any) {
      expect(error.message).toBe('NEXT_REDIRECT')
    }

    expect(mockCookies.delete).toHaveBeenCalledWith('session')
    expect(mockRedirect).toHaveBeenCalledWith('/login')
  })
})
