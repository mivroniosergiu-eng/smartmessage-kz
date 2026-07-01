import { getSession } from '../lib/auth'
import { redirect } from 'next/navigation'
import { prisma } from '@smartmessage/db'
import { logoutAction } from '../actions/auth'

export default async function DashboardPage() {
  const session = await getSession()

  // Если сессия невалидна (например, подделана или истекла), редиректим
  if (!session) {
    redirect('/login')
  }

  // Получаем лимиты тарифа и информацию о команде из БД
  const team = await prisma.team.findFirst({
    where: {
      id: session.teamId,
      users: { some: { id: session.userId } },
    },
    include: {
      permissions: true,
      subscription: true,
    },
  })

  if (!team) {
    // Если команда не найдена (например, удалена из БД), выходим
    redirect('/login?invalidSession=1')
  }

  return (
    <div className="dashboard-layout">
      <header className="dashboard-header">
        <div>
          <h2 style={{ fontSize: '1.75rem', fontWeight: 600 }}>Панель управления</h2>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            Добро пожаловать, {session.email}
          </p>
        </div>
        <form action={logoutAction}>
          <button type="submit" className="btn-secondary" style={{ width: 'auto', padding: '0.6rem 1.2rem' }}>
            Выйти
          </button>
        </form>
      </header>

      <main className="dashboard-grid">
        {/* Карточка пользователя */}
        <section className="dashboard-card" aria-labelledby="user-info-title">
          <h3 id="user-info-title">Профиль пользователя</h3>
          <p style={{ marginBottom: '0.75rem' }}><strong>Email:</strong> {session.email}</p>
          <p style={{ marginBottom: '0.75rem' }}><strong>Роль:</strong> {session.role}</p>
          <p><strong>ID Команды:</strong> {session.teamId}</p>
        </section>

        {/* Карточка компании */}
        <section className="dashboard-card" aria-labelledby="company-title">
          <h3 id="company-title">Компания</h3>
          <p style={{ marginBottom: '0.75rem' }}><strong>Название:</strong> {team.name}</p>
          <p style={{ marginBottom: '0.75rem' }}><strong>Тариф:</strong> {team.subscription?.tier || 'STARTER'}</p>
          <p><strong>Статус подписки:</strong> {team.subscription?.status || 'TRIALING'}</p>
        </section>

        {/* Карточка лимитов */}
        <section className="dashboard-card" aria-labelledby="limits-title">
          <h3 id="limits-title">Лимиты тарифа</h3>
          <p style={{ marginBottom: '0.75rem' }}>
            <strong>Сообщений в месяц:</strong> {team.permissions?.monthlyBroadcastMessages ?? 10000}
          </p>
          <p style={{ marginBottom: '0.75rem' }}>
            <strong>ИИ-генераций:</strong> {team.permissions?.monthlyAiGenerations ?? 500}
          </p>
          <p>
            <strong>Макс. WhatsApp аккаунтов:</strong> {team.permissions?.maxWhatsappAccounts ?? 1}
          </p>
        </section>
      </main>
    </div>
  )
}
