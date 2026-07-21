import { randomUUID } from 'node:crypto'
import { prisma } from '@smartmessage/db'
import { redirect } from 'next/navigation'

import {
  createWhatsappAccountAction,
  logoutWhatsappAction,
  sendWhatsappMessageAction,
  startWhatsappAction,
  stopWhatsappAction,
  validateWhatsappContactAction,
} from '../../actions/whatsapp'
import { getSession } from '../../lib/auth'
import { normalizeSingleSearchParam, type SearchParamValue } from '../../lib/search-param'
import { isConfirmedWhatsappContact } from '../../lib/whatsapp-policy'
import { WhatsappLiveRefresh } from './whatsapp-live-refresh'
import { WhatsappQrCode } from './whatsapp-qr-code'

type WhatsappPageProps = {
  searchParams?: Promise<{ error?: SearchParamValue }>
}

export default async function WhatsappPage({ searchParams }: WhatsappPageProps) {
  const resolvedSearchParams = await searchParams
  const errorMessage = normalizeSingleSearchParam(resolvedSearchParams?.error)
  const session = await getSession()
  if (!session) redirect('/login')

  const team = await prisma.team.findFirst({
    where: { id: session.teamId, users: { some: { id: session.userId } } },
    select: { id: true },
  })
  if (!team) redirect('/login?invalidSession=1')

  const [accounts, contacts] = await Promise.all([
    prisma.waAccount.findMany({
      where: { teamId: team.id },
      orderBy: { instanceId: 'asc' },
      include: { qrBootstrapEvent: true },
    }),
    prisma.contact.findMany({
      where: { teamId: team.id },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    }),
  ])

  return (
    <main className="dashboard-layout" aria-labelledby="whatsapp-title">
      <WhatsappLiveRefresh enabled={accounts.some((account) => account.status === 'CONNECTING')} />
      <header className="dashboard-header">
        <div>
          <h1 id="whatsapp-title">WhatsApp</h1>
          <p className="subtitle" style={{ textAlign: 'left', marginBottom: 0 }}>
            Подключение аккаунтов, проверка номеров и одиночная отправка
          </p>
        </div>
        <a
          className="btn-secondary"
          style={{ width: 'auto', padding: '0.6rem 1.2rem' }}
          href="/dashboard"
        >
          Назад
        </a>
      </header>

      {errorMessage ? (
        <p className="error-message" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <section className="dashboard-card" aria-labelledby="accounts-title">
        <div style={sectionHeaderStyle}>
          <h2 id="accounts-title">Аккаунты</h2>
          <form action={createWhatsappAccountAction} style={createAccountFormStyle}>
            <input
              className="input-field"
              name="instanceId"
              required
              maxLength={120}
              placeholder="Новый instanceId"
              aria-label="Новый instanceId"
            />
            <button className="btn-primary" type="submit" style={{ width: 'auto' }}>
              Добавить аккаунт
            </button>
          </form>
        </div>
        {accounts.length === 0 ? (
          <p>В вашей команде пока нет WhatsApp-аккаунтов.</p>
        ) : (
          <div className="dashboard-grid">
            {accounts.map((account) => {
              const qrVisible =
                account.status === 'CONNECTING' &&
                account.qrBootstrapEvent &&
                account.qrBootstrapEvent.expiresAt.getTime() > Date.now()
              return (
                <article className="dashboard-card" key={account.instanceId}>
                  <h3>{account.instanceId}</h3>
                  <p>
                    <strong>Статус:</strong> {formatAccountStatus(account.status)}
                  </p>
                  {account.restrictedUntil ? (
                    <p>Ограничение до: {account.restrictedUntil.toISOString()}</p>
                  ) : null}
                  {qrVisible ? (
                    <WhatsappQrCode
                      instanceId={account.instanceId}
                      value={account.qrBootstrapEvent?.qrCode ?? ''}
                    />
                  ) : null}
                  <div style={buttonRowStyle}>
                    <form action={startWhatsappAction}>
                      <input type="hidden" name="instanceId" value={account.instanceId} />
                      <button
                        className="btn-secondary"
                        type="submit"
                        disabled={account.status === 'CONNECTED'}
                      >
                        Старт
                      </button>
                    </form>
                    <form action={stopWhatsappAction}>
                      <input type="hidden" name="instanceId" value={account.instanceId} />
                      <button
                        className="btn-secondary"
                        type="submit"
                        disabled={account.status === 'DISCONNECTED'}
                      >
                        Стоп
                      </button>
                    </form>
                    <form action={logoutWhatsappAction}>
                      <input type="hidden" name="instanceId" value={account.instanceId} />
                      <button className="btn-secondary" type="submit">
                        Logout
                      </button>
                    </form>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      <section
        className="dashboard-card"
        style={{ marginTop: '2rem' }}
        aria-labelledby="contacts-title"
      >
        <h2 id="contacts-title">Проверка и одиночная отправка</h2>
        {contacts.length === 0 ? (
          <p>Контактов пока нет.</p>
        ) : (
          <div style={{ display: 'grid', gap: '1rem' }}>
            {contacts.map((contact) => (
              <article key={contact.id} style={contactRowStyle}>
                <div>
                  <strong>{contact.name || contact.phone}</strong>
                  <p style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                    {contact.phone} · {formatContactStatus(contact.isValid)}
                  </p>
                </div>
                <div style={buttonRowStyle}>
                  <form action={validateWhatsappContactAction}>
                    <input type="hidden" name="contactId" value={contact.id} />
                    <button className="btn-secondary" type="submit">
                      Проверить номер
                    </button>
                  </form>
                  {isConfirmedWhatsappContact(contact.isValid) ? (
                    accounts
                      .filter((account) => account.status === 'CONNECTED')
                      .map((account) => (
                        <form
                          action={sendWhatsappMessageAction}
                          key={account.instanceId}
                          style={sendFormStyle}
                        >
                          <input type="hidden" name="instanceId" value={account.instanceId} />
                          <input type="hidden" name="contactId" value={contact.id} />
                          <input type="hidden" name="phone" value={contact.phone} />
                          <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                          <input
                            className="input-field"
                            name="text"
                            required
                            maxLength={4000}
                            placeholder="Текст сообщения"
                            aria-label={`Текст для ${contact.phone}`}
                          />
                          <button className="btn-primary" type="submit" style={{ width: 'auto' }}>
                            Отправить
                          </button>
                        </form>
                      ))
                  ) : (
                    <p style={{ color: 'var(--text-muted)', margin: 0 }}>
                      Подтвердите номер перед отправкой сообщения.
                    </p>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}

function formatAccountStatus(status: string): string {
  return status.toLowerCase()
}

function formatContactStatus(status: string | null): string {
  return status?.toLowerCase() ?? 'не проверен'
}

const buttonRowStyle = {
  display: 'flex',
  flexWrap: 'wrap' as const,
  gap: '0.5rem',
  marginTop: '1rem',
}
const contactRowStyle = {
  border: '1px solid var(--border-color)',
  borderRadius: '12px',
  padding: '1rem',
}
const sendFormStyle = {
  display: 'flex',
  flexWrap: 'wrap' as const,
  gap: '0.5rem',
  flex: '1 1 420px',
}
const sectionHeaderStyle = {
  display: 'flex',
  flexWrap: 'wrap' as const,
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
}
const createAccountFormStyle = {
  display: 'flex',
  flexWrap: 'wrap' as const,
  gap: '0.5rem',
  alignItems: 'center',
}
