import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { WhatsappQrCode } from './whatsapp-qr-code'

describe('WhatsappQrCode', () => {
  afterEach(cleanup)

  it('renders a locally generated scannable SVG without exposing the raw pairing payload', () => {
    const payload = 'sensitive-wa-pairing-payload'
    const { container } = render(<WhatsappQrCode instanceId="test" value={payload} />)

    const qr = screen.getByRole('img', { name: 'QR-код для подключения WhatsApp test' })
    expect(qr.tagName.toLowerCase()).toBe('svg')
    expect(qr.querySelectorAll('path').length).toBeGreaterThan(0)
    expect(container.querySelector('pre')).toBeNull()
    expect(container).not.toHaveTextContent(payload)
  })
})
