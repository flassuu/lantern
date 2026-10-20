import type { FastifyInstance, FastifyPluginAsync } from 'fastify'

export interface HealthDeps {
  version: string
  /** True when the listener answers HTTPS; a phone trusts the app only then. */
  tls: boolean
  checkDatabase: () => boolean
}

export const healthRoutes: FastifyPluginAsync<HealthDeps> = async (
  app: FastifyInstance,
  opts: HealthDeps,
) => {
  app.get('/api/health', async () => {
    return {
      status: 'ok',
      version: opts.version,
      tls: opts.tls,
      database: opts.checkDatabase() ? 'ok' : 'error',
      uptime_ms: process.uptime() * 1000,
      timestamp: new Date().toISOString(),
    }
  })
}