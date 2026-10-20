import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp, type TestingApp } from '../src/app'
import { APP_VERSION } from '../src/version'

let app: TestingApp
let tmpDir: string

describe('server scaffold', () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'testsys-'))
  app = buildApp({
    host: '127.0.0.1',
    port: 0,
    dbPath: join(tmpDir, 'test.db'),
    webRoot: null,
  })

  afterAll(() => {
    app.server.close()
    app.database.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('GET /api/health returns ok with a working database', async () => {
    const res = await app.server.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      status: string
      database: string
      version: string
      tls: boolean
    }
    expect(body.status).toBe('ok')
    expect(body.database).toBe('ok')
    expect(body.version).toBe(APP_VERSION)
    // Plain HTTP unless the config handed the listener a certificate.
    expect(body.tls).toBe(false)
  })
})