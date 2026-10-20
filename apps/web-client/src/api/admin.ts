import { apiFetch, downloadFile } from './client'
import type { ParticipationEntry, SystemStats } from './types'

/** Admin only: flat course → student participation list. */
export async function listParticipants(): Promise<ParticipationEntry[]> {
  const result = await apiFetch<{ participants: ParticipationEntry[] }>(
    '/api/admin/participants',
  )
  return result.participants
}

/** Admin only: aggregated DB counts and server health. */
export async function getSystemStats(): Promise<SystemStats> {
  const result = await apiFetch<{ stats: SystemStats }>('/api/admin/stats')
  return result.stats
}

/**
 * Admin only: the whole database as one downloadable file.
 *
 * A plain link cannot carry the bearer token, so the file comes through the same
 * authenticated request as everything else and is handed to the browser as a
 * download afterwards.
 */
export async function downloadBackup(): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 10)
  await downloadFile('/api/admin/backup', `lantern-backup-${stamp}.db`)
}

/**
 * Admin only: sends a snapshot back. The server validates it and parks it; the
 * caller restarts the server (desktop) or tells the operator to.
 */
export async function restoreBackup(file: File): Promise<{ schemaVersion: number }> {
  const result = await apiFetch<{ restore: { schemaVersion: number } }>(
    '/api/admin/backup/restore',
    {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    },
  )
  return { schemaVersion: result.restore.schemaVersion }
}
