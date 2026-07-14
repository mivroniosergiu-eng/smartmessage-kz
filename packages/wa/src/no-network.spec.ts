import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MockMessageSender } from './sender'
import { MockPhoneValidator } from './phone-validator'
import { MockSessionManager } from './session'

describe('wa mocks', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('do not make external network calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const sender = new MockMessageSender()
    const sessions = new MockSessionManager()
    const validator = new MockPhoneValidator()

    await sender.send({
      instanceId: 'instance-1',
      recipientPhone: 'fixture-recipient-alpha',
      kind: 'text',
      text: 'No network',
      idempotencyKey: 'no-network-1',
    })
    await sessions.connect('instance-1')
    await sessions.handleDisconnect('instance-1', 'transient')
    await validator.validate({ phone: 'fixture-recipient-alpha' })

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('keeps production sources free of network, socket, Baileys, and session-file hooks', async () => {
    const sources = await readProductionSources(path.dirname(fileURLToPath(import.meta.url)))

    for (const source of sources) {
      const isBaileysConnector = source.filePath.endsWith(`${path.sep}baileys-connector.ts`)
      const importDeclarations = source.contents
        .split(/\r?\n/)
        .filter((line) => /^\s*import\s/.test(line))
        .join('\n')

      if (isBaileysConnector) {
        expect(source.contents, source.filePath).toMatch(/@whiskeysockets\/baileys/)
        expect(source.contents, source.filePath).toContain('makeWASocket')
      } else {
        expect(source.contents, source.filePath).not.toMatch(/@whiskeysockets\/baileys/)
        expect(source.contents, source.filePath).not.toContain('makeWASocket')
      }

      expect(importDeclarations, source.filePath).not.toMatch(
        /(?:node:)?(?:net|tls|http|https)|['"]ws['"]/,
      )
      expect(source.contents, source.filePath).not.toMatch(/\bfetch\s*\(/)
      expect(source.contents, source.filePath).not.toContain('useMultiFileAuthState')
      expect(source.contents, source.filePath).not.toContain('auth_info')
      expect(source.contents, source.filePath).not.toContain('wa-sessions')
      expect(source.contents, source.filePath).not.toMatch(/['"][^'"\r\n]*\.session[^'"\r\n]*['"]/)
    }
  })
})

async function readProductionSources(
  directory: string,
): Promise<Array<{ filePath: string; contents: string }>> {
  const entries = await readdir(directory, { withFileTypes: true })
  const sources: Array<{ filePath: string; contents: string }> = []

  for (const entry of entries) {
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      sources.push(...(await readProductionSources(filePath)))
      continue
    }

    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) continue

    sources.push({
      filePath,
      contents: await readFile(filePath, 'utf8'),
    })
  }

  return sources
}
