import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/*.spec.ts'],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
})
