import { config } from 'dotenv'
import { resolve } from 'node:path'

// @prisma/client НЕ загружает .env сам — делаем это явно для интеграционных тестов.
config({ path: resolve(__dirname, '.env') })

// Фоллбэк для CI/локалки, если .env отсутствует (compose: postgres:postgres@5433).
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/smartmessage?schema=public'
}
