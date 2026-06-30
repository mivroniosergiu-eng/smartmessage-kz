import type { ReactNode } from 'react'

export const metadata = {
  title: 'SmartMessage KZ',
  description: 'B2B маркетинговая автоматизация на WhatsApp',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  )
}
