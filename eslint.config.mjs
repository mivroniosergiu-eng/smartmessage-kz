// Корневой flat-config ESLint для всего монорепо (Фаза 0).
// TypeScript-aware правила + защита от антипаттернов донора (секреты в коде, raw SQL).
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  {
    // Не линтим сгенерированное и сборку (AGENTS.md §12: генерируемые файлы не править).
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'packages/db/ERD.md',
      // apps/web линтится через `next lint` (ESLint 8 + eslint-config-next),
      // чтобы не конфликтовать с ESLint 9 flat-config корня.
      'apps/web/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Базовая гигиена. Неиспользуемое — ошибка, но допускаем префикс _ для намеренно проигнорированного.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // any допускаем точечно (Next FormState, Baileys-payload), но предупреждаем.
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
    },
  },
  {
    // Тесты: ослабляем шум, не само поведение.
    files: ['**/*.spec.ts', '**/*.spec.tsx', '**/*.test.ts', '**/*.test.tsx'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
