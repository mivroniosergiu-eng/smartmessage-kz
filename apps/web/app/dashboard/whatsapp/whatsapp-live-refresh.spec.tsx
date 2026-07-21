import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}))

import { WhatsappLiveRefresh } from './whatsapp-live-refresh'

describe('WhatsappLiveRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    refresh.mockReset()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('refreshes connecting account status every five seconds and stops when disabled', () => {
    const view = render(<WhatsappLiveRefresh enabled />)

    vi.advanceTimersByTime(4_999)
    expect(refresh).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(refresh).toHaveBeenCalledOnce()

    view.rerender(<WhatsappLiveRefresh enabled={false} />)
    vi.advanceTimersByTime(5_000)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('does not schedule refreshes while no account is connecting', () => {
    render(<WhatsappLiveRefresh enabled={false} />)

    vi.advanceTimersByTime(15_000)
    expect(refresh).not.toHaveBeenCalled()
  })
})
