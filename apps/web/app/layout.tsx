import type { ReactNode } from 'react'
import './global.css'

export const metadata = {
  title: 'SmartMessage KZ',
  description: 'B2B маркетинговая автоматизация на WhatsApp',
  icons: {
    icon: '/smartmessage-icon.svg',
  },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  )
}
