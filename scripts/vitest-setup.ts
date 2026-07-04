import { tmpdir } from 'node:os'
import { join } from 'node:path'

const worker = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? String(process.pid)

process.env.QUIMBY_DATA_HOME ??= join(tmpdir(), `quimby-vitest-data-${worker}`)
process.env.XDG_CONFIG_HOME ??= join(tmpdir(), `quimby-vitest-config-${worker}`)
