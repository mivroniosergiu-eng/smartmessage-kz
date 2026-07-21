'use client'

import { QRCodeSVG } from 'qrcode.react'

type WhatsappQrCodeProps = {
  instanceId: string
  value: string
}

export function WhatsappQrCode({ instanceId, value }: WhatsappQrCodeProps) {
  const accessibleName = `QR-код для подключения WhatsApp ${instanceId}`

  return (
    <div style={containerStyle} data-testid={`wa-qr-${instanceId}`}>
      <p style={{ marginBottom: '0.75rem' }}>
        <strong>Отсканируйте QR-код в WhatsApp</strong>
      </p>
      <div style={qrFrameStyle}>
        <QRCodeSVG
          value={value}
          size={300}
          level="M"
          marginSize={4}
          bgColor="#ffffff"
          fgColor="#000000"
          title={accessibleName}
          role="img"
          aria-label={accessibleName}
          style={{ display: 'block', width: '100%', height: 'auto' }}
        />
      </div>
      <small style={{ color: 'var(--text-muted)' }}>
        WhatsApp → Связанные устройства → Привязка устройства. Код обновляется автоматически.
      </small>
    </div>
  )
}

const containerStyle = { marginTop: '1rem', maxWidth: '332px' }
const qrFrameStyle = {
  background: '#ffffff',
  borderRadius: '12px',
  padding: '0.75rem',
  marginBottom: '0.75rem',
}
