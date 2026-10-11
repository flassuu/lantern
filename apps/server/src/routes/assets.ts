import { createReadStream, existsSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, extname, join } from 'node:path'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { createAsset, deleteAsset, findAssetRow, listAssets } from '../lib/assets'
import type { Database } from '../lib/db'
import { sendError } from '../lib/http'
import { requireRoles } from '../plugins/auth'
import type { Session } from '../lib/tokens'

/**
 * Pictures a question points at: the diagram in the body, the four drawings in
 * a matching question.
 *
 * Upload is the same raw-body shape as a course material — the bytes are the
 * body, the name rides in the query — because a file picker has no other way to
 * hand over a picture without a multipart parser, and a multipart parser is a
 * dependency this server does not need.
 *
 * Assets are images only, and small ones: this is a question diagram, not a
 * photo library, and every byte here is stored on the teacher's own machine and
 * copied over the classroom's Wi-Fi to every phone that takes the paper.
 */
export interface AssetsDeps {
  database: Database
  uploadsDir: string
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

/**
 * 8 MiB. A question diagram that does not fit in that is a photograph, and a
 * photograph in a test question is not what this is for.
 */
const MAX_ASSET_BYTES = 8 * 1024 * 1024

const assetQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { name: { type: 'string', maxLength: 255 } },
} as const

const assetParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', minLength: 36, maxLength: 36 } },
} as const

/** The kind of picture it turned out to be, judged by what was sent. */
function mimeOf(originalName: string, body: Buffer): string | null {
  const ext = extname(originalName).toLowerCase().slice(1)
  const known = MIME_BY_EXT[ext]
  if (known !== undefined) return known
  // No usable extension, but the bytes say what they are. A picture with a
  // wrong name is common enough on a phone that trusting the name alone would
  // store it as something no browser will draw.
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (body.subarray(0, 6).toString('ascii').startsWith('GIF8')) return 'image/gif'
  if (body[0] === 0xff && body[1] === 0xd8) return 'image/jpeg'
  if (
    body.subarray(0, 4).toString('ascii') === 'RIFF' &&
    body.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

export const assetRoutes: FastifyPluginAsync<AssetsDeps> = async (
  app: FastifyInstance,
  { database, uploadsDir }: AssetsDeps,
) => {
  const db = database.raw

  // Raw binary uploads without multipart, the same parser a course material
  // uses: a file picker has no other way to hand over a picture without a
  // multipart parser, and one is a dependency this server does not need.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    const chunks: Buffer[] = []
    payload.on('data', (chunk: Buffer) => chunks.push(chunk))
    payload.on('end', () => done(null, Buffer.concat(chunks)))
    payload.on('error', (error: Error) => done(error))
  })

  app.get(
    '/api/assets',
    {
      preHandler: requireRoles('admin', 'teacher'),
    },
    async (request) => {
      const session = request.session as Session
      return { assets: listAssets(db, session.userId) }
    },
  )

  app.post(
    '/api/assets',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { querystring: assetQuerySchema },
    },
    async (request, reply) => {
      const session = request.session!
      const query = (request.query ?? {}) as { name?: string }
      const body = request.body as Buffer
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return sendError(reply, 400, 'VALIDATION', 'empty file body')
      }
      if (body.length > MAX_ASSET_BYTES) {
        return sendError(reply, 413, 'PAYLOAD_TOO_LARGE', 'an image must be under 8 MiB')
      }
      const originalName = basename(query.name ?? 'image.png')
      const mimeType = mimeOf(originalName, body)
      if (mimeType === null) {
        return sendError(reply, 415, 'VALIDATION', 'only images can be attached to a question')
      }
      const fileName = `${randomUUID()}${extname(originalName).toLowerCase() || '.png'}`
      writeFileSync(join(uploadsDir, fileName), body)
      const asset = createAsset(db, session.userId, {
        title: originalName,
        filePath: fileName,
        mimeType,
        sizeBytes: body.length,
      })
      return reply.code(201).send({ asset })
    },
  )

  /**
   * The picture itself.
   *
   * Any signed-in user may read an asset by id, which includes a student: the
   * ids travel inside the paper they were given, and an id is a UUID that is
   * never listed anywhere. Checking the paper on every image would mean walking
   * the student's whole session to prove one diagram, on every phone, mid
   * question - and would still be a weaker check, since the id is in their hands
   * either way.
   */
  app.get(
    '/api/assets/:id',
    {
      preHandler: requireRoles('admin', 'teacher', 'student'),
      schema: { params: assetParamsSchema },
    },
    async (request, reply) => {
      const params = request.params as { id: string }
      const asset = findAssetRow(db, params.id)
      if (!asset) return sendError(reply, 404, 'NOT_FOUND', 'image not found')
      const filePath = join(uploadsDir, asset.file_path)
      if (!existsSync(filePath)) {
        return sendError(reply, 404, 'NOT_FOUND', 'image file missing')
      }
      return reply
        .type(asset.mime_type)
        // Inline, never as a download: the whole point is that it appears in the
        // question. An immutable id lets it be cached for the length of a run.
        .header('content-disposition', `inline; filename="${asset.title.replace(/"/g, '')}"`)
        .header('cache-control', 'private, max-age=86400, immutable')
        .send(createReadStream(filePath))
    },
  )

  app.delete(
    '/api/assets/:id',
    {
      preHandler: requireRoles('admin', 'teacher'),
      schema: { params: assetParamsSchema },
    },
    async (request, reply) => {
      const session = request.session!
      const params = request.params as { id: string }
      const filePath = deleteAsset(db, params.id, session.userId)
      if (filePath === null) return sendError(reply, 404, 'NOT_FOUND', 'image not found')
      // The row goes first: a file left behind by a failed unlink is invisible,
      // while a row pointing at nothing is a question with a hole in it.
      try {
        rmSync(join(uploadsDir, filePath), { force: true })
      } catch {
        // Nothing to do: the row is gone, so nothing will ever ask for it.
      }
      return reply.code(204).send()
    },
  )
}
