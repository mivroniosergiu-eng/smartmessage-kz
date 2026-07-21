import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const workerPackageRoot = fileURLToPath(new URL('../../', import.meta.url))

describe('WA package worker runtime compatibility', () => {
  it('loads through the worker tsx/cjs runtime without eagerly resolving Baileys ESM internals', () => {
    const result = spawnSync(
      process.execPath,
      ['--require', 'tsx/cjs', '--eval', "require('@smartmessage/wa')"],
      {
        cwd: workerPackageRoot,
        encoding: 'utf8',
        timeout: 15_000,
      },
    )

    expect(result.status, result.stderr || result.stdout).toBe(0)
  })

  it('preserves explicit worker injection metadata under the worker tsx/cjs runtime', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--require',
        'tsx/cjs',
        '--eval',
        "require('reflect-metadata'); const { WaAccountController } = require('./src/wa/wa-account.controller'); const { WaOperationsController } = require('./src/wa/wa-operations.controller'); const { WaLifecycleCommandQueueService } = require('./src/wa/wa-lifecycle-command-queue.service'); const { WaLifecycleJobProcessor } = require('./src/wa/wa-lifecycle-job.processor'); const { WaPhoneValidationAccountSelector } = require('./src/wa/wa-phone-validation-account.selector'); const { WaPhoneValidationJobProcessor } = require('./src/wa/wa-phone-validation-job.processor'); const { WaSingleSendJobProcessor } = require('./src/wa/wa-single-send-job.processor'); const has = (type, indexes) => { const metadata = Reflect.getMetadata('self:paramtypes', type); return metadata && indexes.every((index) => metadata.some((entry) => entry.index === index)); }; if (!has(WaAccountController, [0, 1, 2]) || !has(WaOperationsController, [0, 1, 2, 3]) || !has(WaLifecycleCommandQueueService, [0, 1]) || !has(WaLifecycleJobProcessor, [0, 1, 2, 3, 4, 5]) || !has(WaPhoneValidationAccountSelector, [0, 1, 2]) || !has(WaPhoneValidationJobProcessor, [0, 1, 2, 3, 4, 5]) || !has(WaSingleSendJobProcessor, [0, 1, 2, 3, 4, 5])) process.exit(1)",
      ],
      {
        cwd: workerPackageRoot,
        encoding: 'utf8',
        timeout: 15_000,
      },
    )

    expect(result.status, result.stderr || result.stdout).toBe(0)
  })
})
