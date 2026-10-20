import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, loadConfig } from '../src/config'

const tmpDir = mkdtempSync(join(tmpdir(), 'lantern-config-'))
const certPath = join(tmpDir, 'cert.pem')
const keyPath = join(tmpDir, 'key.pem')
writeFileSync(certPath, 'certificate\n')
writeFileSync(keyPath, 'key\n')

function load(...flags: string[]): ReturnType<typeof loadConfig> {
  return loadConfig(['--data', join(tmpDir, 'data'), ...flags])
}

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('TLS flags', () => {
  it('stays on plain HTTP when neither flag is given', () => {
    expect(load().tls).toBeNull()
  })

  it('reads both files when both flags are given', () => {
    const { tls } = load('--tls-cert', certPath, '--tls-key', keyPath)
    expect(tls?.cert.toString()).toBe('certificate\n')
    expect(tls?.key.toString()).toBe('key\n')
  })

  it('refuses a certificate without a key', () => {
    expect(() => load('--tls-cert', certPath)).toThrow(ConfigError)
    // The message names both flags: the fix is to add or drop one.
    expect(() => load('--tls-cert', certPath)).toThrow(/go together/)
  })

  it('refuses a key without a certificate', () => {
    expect(() => load('--tls-key', keyPath)).toThrow(ConfigError)
  })

  it('refuses a file it cannot read, and says which flag', () => {
    expect(() => load('--tls-cert', join(tmpDir, 'missing.pem'), '--tls-key', keyPath)).toThrow(
      /--tls-cert: cannot read/,
    )
  })
})
