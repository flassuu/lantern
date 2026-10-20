// `index.ts` is always the entrypoint; this module is never imported by tests.
import { join } from 'node:path'
import { attachConsole } from './lib/console'
import { applyPendingRestore, snapshotOnUpgrade } from './lib/backup'
import { seedDemo } from './lib/demo'
import { loadConfig } from './config'
import { shutdown, startServer } from './app'

const config = loadConfig(process.argv.slice(2))

// Before anything opens the database: a restore parked by the previous run is
// the database now, and a migration about to run gets a copy of what it replaces.
const restored = applyPendingRestore(config.dataDir, config.dbPath)
const upgradeCopy = snapshotOnUpgrade(config.dbPath, join(config.dataDir, 'backups'))

const app = await startServer({
  host: config.host,
  port: config.port,
  dbPath: config.dbPath,
  webRoot: config.webRoot,
})

const { logs } = app

if (restored) {
  logs.logger.info({ db: config.dbPath }, 'restored the database from the uploaded backup')
}
if (upgradeCopy) {
  logs.logger.info({ copy: upgradeCopy }, 'kept a copy of the database before the migration')
}

// The demo is asked for out loud, and it refuses a database that already holds
// work. Both outcomes are logged: a flag that silently did nothing is worse than
// no flag at all.
if (config.seedDemo) {
  const result = seedDemo(app.database.raw, { uploadsDir: join(config.dataDir, 'uploads') })
  if (result.seeded) {
    logs.logger.info(
      {
        teacher: result.teacher?.username,
        students: result.students?.map((student) => student.username),
        roomKey: result.roomKey,
      },
      `demo data seeded - sign in as ${result.teacher?.username}${
        result.teacher?.password ? ` / ${result.teacher.password}` : ' (your own password)'
      }, students share ${result.students?.[0]?.password}`,
    )
  } else {
    logs.logger.warn({ reason: result.reason }, `demo data was not seeded: ${result.reason}`)
  }
}

logs.logger.info(
  { url: `http://${config.host}:${config.port}`, db: config.dbPath, webRoot: config.webRoot },
  `listening on http://${config.host}:${config.port}`,
)

let stopping = false
async function stop(reason: string): Promise<void> {
  // Ctrl-C twice should not race two closes of the same database handle.
  if (stopping) return
  stopping = true
  logs.logger.info({ reason }, 'stopping')
  await shutdown(app)
  process.exit(0)
}

const console = await attachConsole(
  {
    db: app.database.raw,
    logs,
    uploadsDir: join(config.dataDir, 'uploads'),
    stop: () => stop('console'),
  },
  // `--no-console` for a machine with no one at the keyboard; a pipe turns it off
  // by itself, which is the case a CI run and the desktop app are in.
  { enabled: config.console },
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console?.close()
    void stop(signal)
  })
}