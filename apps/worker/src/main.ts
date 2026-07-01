import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

export function parsePort(rawPort: string | undefined): number {
  const raw = rawPort ?? '3001'
  const port = Number.parseInt(raw, 10)

  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== raw) {
    throw new Error(`Invalid PORT: ${raw}`)
  }

  return port
}

export async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.enableShutdownHooks()
  const port = parsePort(process.env.PORT)
  await app.listen(port)
  console.log(`worker listening on ${port}`)
}

if (process.env.NODE_ENV !== 'test') {
  bootstrap().catch((error) => {
    console.error('worker bootstrap failed', error)
    process.exit(1)
  })
}
