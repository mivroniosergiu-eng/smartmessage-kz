'use client'

import { useFormState, useFormStatus } from 'react-dom'
import Link from 'next/link'
import { loginAction } from '../actions/auth'

const initialState = {
  error: '',
}

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button type="submit" className="btn-primary" disabled={pending}>
      {pending ? 'Вход...' : 'Войти'}
    </button>
  )
}

export default function LoginPage() {
  const [state, formAction] = useFormState(loginAction as any, initialState)

  return (
    <div className="auth-container">
      <h1>SmartMessage</h1>
      <p className="subtitle">Войдите в личный кабинет</p>
      
      <form action={formAction}>
        {state?.error && <div className="error-message">{state.error}</div>}

        <div className="form-group">
          <label htmlFor="email">Email адрес</label>
          <input
            id="email"
            name="email"
            type="email"
            className="input-field"
            placeholder="example@mail.com"
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor="password">Пароль</label>
          <input
            id="password"
            name="password"
            type="password"
            className="input-field"
            placeholder="••••••••"
            required
          />
        </div>

        <SubmitButton />

        <p className="text-center" style={{ marginTop: '1.5rem', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
          Ещё нет аккаунта?{' '}
          <Link href="/register" className="text-link">
            Зарегистрироваться
          </Link>
        </p>
      </form>
    </div>
  )
}
