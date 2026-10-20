import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

/** A flag that cannot be honoured, with a sentence a teacher can act on. */
export class ConfigError extends Error {}

/** TLS material, read at startup so a bad path fails before the port opens. */
export interface TlsConfig {
  cert: Buffer
  key: Buffer
}

export interface ServerConfig {
  host: string
  port: number
  dataDir: string
  webRoot: string | null
  dbPath: string
  /** Interactive commands on stdin. Off for `--no-console`, and off by itself
   *  when stdin is not a terminal. */
  console: boolean
  /** Fill a fresh database with demo data. Never implicit: see `lib/demo.ts`. */
  seedDemo: boolean
  /** Null means plain HTTP, which stays the default on a classroom LAN. */
  tls: TlsConfig | null
}

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

function asWebRoot(value: string | undefined): string | null {
  if (!value) return null
  // Absolute: @fastify/static rejects a relative root with an opaque error.
  const absolute = isAbsolute(value) ? value : resolve(process.cwd(), value)
  return existsSync(absolute) ? absolute : null
}

/**
 * Base directory for locating the production student-client build.
 *
 * - Running from source (`bun src/index.ts`): `import.meta.dir` is the `src`
 *   folder and is used directly.
 * - Compiled binary (`bun build --compile`): `import.meta.dir` points at the
 *   virtual `/$bunfs/root`, so we resolve against the real executable instead.
 */
function baseDir(): string {
  if (!import.meta.dir.startsWith('/$bunfs')) return import.meta.dir
  return dirname(realpathSync(process.execPath))
}

/**
 * Resolves the production student-client build depending on the layout.
 */
function resolveWebRoot(baseDirValue: string): string {
  // From a repo checkout the build always lives one level up, two levels in:
  //   apps/server/src  -> ../../web-client/dist   (source run)
  //   apps/server/dist -> ../../web-client/dist   (compiled binary)
  const candidates = [
    `${baseDirValue}/../../web-client/dist`,
    // When the binary ships bundled beside its web client:
    `${baseDirValue}/../web-client/dist`,
    `${baseDirValue}/dist`,
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return ''
}

/**
 * Both certificate flags or neither.
 *
 * A server that quietly falls back to plain HTTP when one flag is mistyped is
 * the worst outcome: the lesson runs, the passwords cross the room in clear
 * text, and nobody notices. A missing file stops the process with a sentence
 * that names the flag instead.
 */
function readTls(argv: string[]): TlsConfig | null {
  const certPath = arg(argv, '--tls-cert')
  const keyPath = arg(argv, '--tls-key')
  if (!certPath && !keyPath) return null
  if (!certPath || !keyPath) {
    throw new ConfigError('--tls-cert and --tls-key go together: give both, or neither')
  }
  return { cert: readPem(certPath, '--tls-cert'), key: readPem(keyPath, '--tls-key') }
}

function readPem(path: string, flag: string): Buffer {
  try {
    return readFileSync(path)
  } catch {
    throw new ConfigError(`${flag}: cannot read ${path}`)
  }
}

export function loadConfig(argv: string[]): ServerConfig {
  const baseDirValue = baseDir()
  // A relative --data would tie the database and uploads to the working
  // directory of whoever happens to start the binary.
  const dataArg = arg(argv, '--data') ?? './data'
  const dataDir = isAbsolute(dataArg) ? dataArg : resolve(process.cwd(), dataArg)
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })

  const explicitWebRoot = asWebRoot(arg(argv, '--webroot'))
  const autoWebRoot = resolveWebRoot(baseDirValue)

  return {
    host: arg(argv, '--host') ?? '0.0.0.0',
    port: Number(arg(argv, '--port') ?? process.env.PORT ?? 3300),
    dataDir,
    webRoot: explicitWebRoot ?? (autoWebRoot || null),
    dbPath: `${dataDir}/app.db`,
    // A flag with no value: its presence is the whole meaning, which is why it
    // is checked as a member of argv rather than as `arg(argv, '--no-console')`.
    console: !argv.includes('--no-console'),
    // A flag with no value, like `--no-console`: its presence is the meaning.
    seedDemo: argv.includes('--seed-demo'),
    tls: readTls(argv),
  }
}