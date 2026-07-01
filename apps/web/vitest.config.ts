import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['app/**/*.spec.{ts,tsx}', 'middleware.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['app/**/*.{ts,tsx}', 'middleware.ts'],
      exclude: ['**/*.spec.{ts,tsx}', '**/*.test.{ts,tsx}', 'app/layout.tsx'],
    },
  },
})
