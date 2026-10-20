import Fastify, {
  LogController,
  type FastifyError,
  type FastifyInstance,
} from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { dirname, join } from 'node:path'
import { openDatabase, checkDatabase, type Database } from './lib/db'
import { createLogHub, type LogHub } from './lib/log'
import { healthRoutes } from './routes/health'
import { logRoutes } from './routes/logs'
import { authRoutes } from './routes/auth'
import { userRoutes } from './routes/users'
import { testRoutes } from './routes/tests'
import { courseRoutes } from './routes/courses'
import { assetRoutes } from './routes/assets'
import { sessionRoutes } from './routes/sessions'
import { adminRoutes } from './routes/admin'
import { journalRoutes } from './routes/journals'
import { roomRoutes } from './routes/rooms'
import { tagRoutes } from './routes/tags'
import { settingsRoutes } from './routes/settings'
import { attachAuth } from './plugins/auth'
import { APP_VERSION } from './version'

export interface AppOptions {
  host: string
  port: number
  dbPath: string
  webRoot: string | null
  /** Base directory for file uploads; defaults to the DB directory. */
  dataDir?: string
}

export interface TestingApp {
  server: FastifyInstance
  database: Database
  /** The one log stream: stdout, the ring buffer and the live tail. */
  logs: LogHub
}

/**
 * Builds the Fastify application. Kept as a pure factory so integration
 * tests can also call `inject()` without binding a socket.
 */
export function buildApp(options: AppOptions): TestingApp {
  const database = openDatabase(options.dbPath)
  const dataDir = options.dataDir ?? dirname(options.dbPath)
  const uploadsDir = join(dataDir, 'uploads')

  // One logger for the whole process: a terminal gets human lines, a pipe gets
  // the JSON pino wrote, and both fill the buffer that /api/logs serves. Wiring
  // Fastify to a plain `logger` option would give the terminal and the API two
  // different stories about the same run.
  const logs = createLogHub({
    level: process.env.LOG_LEVEL ?? 'info',
    tty: process.stdout.isTTY === true,
  })

  // The cast is only about generics: passing a loggerInstance makes Fastify
  // infer pino's own Logger type, while every plugin in this app is typed
  // against the base logger. Nothing is widened to `any`.
  const app = Fastify({
    loggerInstance: logs.logger,
    // pino logs every request twice — "incoming request" and "request completed" —
    // which is half a console of noise for a teacher and no duration anywhere.
    // One line per request, with the time it took, is written below instead.
    //
    // Fastify 5 wants this through `logController`; the top-level option still
    // works but prints a deprecation notice as plain text into the log, which is
    // exactly the kind of line this project's piped output must never contain.
    logController: new LogController({ disableRequestLogging: true }),
  }) as unknown as FastifyInstance

  void app.register(cors, { origin: true })

  // WebSocket upgrade support; concrete channels are registered later.
  void app.register(websocket)

  if (options.webRoot) {
    void app.register(fastifyStatic, {
      root: options.webRoot,
      prefix: '/',
    })
  }

  // Resolves `request.session` from the bearer token on every request.
  // Attached at root level so the hook reaches every route context.
  attachAuth(app, database)

  /**
   * One log line per request, once it is finished and the status is known.
   *
   * The level follows the outcome, so the console's "Errors" filter means
   * something: a 500 is an error, a 404 is a warning, the rest is information.
   */
  app.addHook('onResponse', async (request, reply) => {
    const status = reply.statusCode
    const line = {
      req: {
        method: request.method,
        url: request.url,
        statusCode: status,
      },
      responseTimeMs: Math.round(reply.elapsedTime),
    }
    if (status >= 500) logs.logger.error(line, 'request failed')
    else if (status >= 400) logs.logger.warn(line, 'request rejected')
    else logs.logger.info(line, 'request completed')
  })

  // Written through the log stream, so the seed warning has a level and reaches
  // the desktop console as a warning instead of arriving as untyped text.
  if (database.seededTeacherWarning) {
    logs.logger.warn(
      { hint: 'TEACHER_PASSWORD' },
      database.seededTeacherWarning,
    )
  }

  void app.register(healthRoutes, {
    version: APP_VERSION,
    checkDatabase: () => checkDatabase(database),
  })

  // Phase 1: accounts & roles.
  void app.register(authRoutes, { database })
  void app.register(userRoutes, { database })

  // Phase 2 foundation: tests & courses.
  void app.register(testRoutes, { database })
  void app.register(courseRoutes, { database, uploadsDir })
  void app.register(assetRoutes, { database, uploadsDir })

  // Phase 3: live session runtime (teacher run + student join/submit).
  void app.register(sessionRoutes, { database })

  // Admin-only introspection: DB health, course participants, backup/restore.
  void app.register(adminRoutes, { database, version: APP_VERSION, dataDir })

  // Phase 5.1: the address students can open, plus what this machine answers on.
  void app.register(settingsRoutes, { database, port: options.port })

  // Phase 5.2: class keys, so a teacher can seat a class without an admin.
  void app.register(roomRoutes, { database })
  void app.register(journalRoutes, { database })

  void app.register(tagRoutes, { database })

  // Phase 5.3: the same log stream the console prints, over HTTP and WebSocket.
  void app.register(logRoutes, { database, logs })

  // Uniform error envelope; validation failures map to 400 VALIDATION.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation) {
      return reply
        .code(400)
        .send({ error: { code: 'VALIDATION', message: error.message } })
    }
    request.log.error(error)
    const status = error.statusCode ?? 500
    const message = status === 500 ? 'internal server error' : error.message
    return reply.code(status).send({ error: { code: status === 500 ? 'INTERNAL' : 'ERROR', message } })
  })

  return { server: app, database, logs }
}

export async function startServer(options: AppOptions): Promise<TestingApp> {
  const app = buildApp(options)
  await app.server.listen({ host: options.host, port: options.port })
  return app
}

/**
 * Closes the listener and the database in the right order.
 *
 * Exported rather than wired to a signal inside the app, because the console's
 * `stop` command, `SIGINT` and the desktop shutting the server down all want
 * exactly this sequence, and three copies of "close, then close the database"
 * is three chances to leak a handle.
 */
export async function shutdown(app: TestingApp): Promise<void> {
  await app.server.close()
  app.database.close()
}