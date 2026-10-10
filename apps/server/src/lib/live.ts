import type { LiveSessionStatus, ParticipantEntry } from './sessions'
import type { UserRole } from './users'

/**
 * The slice of a WebSocket the hub needs. `ws` arrives with @fastify/websocket,
 * so the shape is declared here instead of importing a transitive dependency.
 */
export interface LiveSocket {
  readonly readyState: number
  send(data: string): void
  on(event: 'close' | 'error', listener: () => void): void
  on(event: 'message', listener: (data: unknown) => void): void
}

/** One connected client watching a session. */
export interface LiveClient {
  socket: LiveSocket
  userId: string
  role: UserRole
  isTeacher: boolean
}

export type LiveMessage =
  | { type: 'participants'; participants: ParticipantEntry[] }
  | { type: 'status'; status: LiveSessionStatus; serverNow: string }
  | { type: 'error'; code: string; message: string }

const rooms = new Map<string, Set<LiveClient>>()

/** How far a student is and whether their window is on screen. */
export interface Presence {
  visible: boolean
  questionIndex: number
  answered: number
}

/**
 * Live state that is deliberately not in the database.
 *
 * "On question 3" and "the window is hidden" change every few seconds and mean
 * nothing once the run is over, so they live in memory and vanish with the
 * process. What is worth keeping - the fact that somebody left the window - is
 * written to `participation_events` instead. Two stores, on purpose: one for
 * the room right now, one for the record afterwards.
 */
const presence = new Map<string, Map<string, Presence>>()
/** Open sockets per student, so "offline" means the last one closed, not a blip. */
const openSockets = new Map<string, Map<string, number>>()

function presenceFor(sessionId: string): Map<string, Presence> {
  const found = presence.get(sessionId)
  if (found) return found
  const created = new Map<string, Presence>()
  presence.set(sessionId, created)
  return created
}

function socketsFor(sessionId: string): Map<string, number> {
  const found = openSockets.get(sessionId)
  if (found) return found
  const created = new Map<string, number>()
  openSockets.set(sessionId, created)
  return created
}

export function setPresence(sessionId: string, userId: string, patch: Partial<Presence>): Presence {
  const forSession = presenceFor(sessionId)
  const current: Presence = forSession.get(userId) ?? {
    visible: true,
    questionIndex: 0,
    answered: 0,
  }
  const next = { ...current, ...patch }
  forSession.set(userId, next)
  return next
}

export function presenceOf(sessionId: string): Map<string, Presence> {
  return presence.get(sessionId) ?? new Map()
}

export function addSocket(sessionId: string, userId: string): void {
  const counts = socketsFor(sessionId)
  counts.set(userId, (counts.get(userId) ?? 0) + 1)
}

/**
 * Drops one socket and says whether it was the last: a student reloading the
 * page opens the next socket before the old one closes, and being called
 * "offline" mid-reload would be a lie.
 */
export function removeSocket(sessionId: string, userId: string): boolean {
  const counts = openSockets.get(sessionId)
  if (!counts) return true
  const left = (counts.get(userId) ?? 1) - 1
  if (left > 0) {
    counts.set(userId, left)
    return false
  }
  counts.delete(userId)
  return true
}

export function isOnline(sessionId: string, userId: string): boolean {
  return (openSockets.get(sessionId)?.get(userId) ?? 0) > 0
}

/** A finished run has no room to watch; the memory goes with it. */
export function clearPresence(sessionId: string): void {
  presence.delete(sessionId)
  openSockets.delete(sessionId)
}

function send(client: LiveClient, message: LiveMessage): void {
  if (client.socket.readyState !== 1) return
  client.socket.send(JSON.stringify(message))
}

export function joinRoom(sessionId: string, client: LiveClient): void {
  const room = rooms.get(sessionId) ?? new Set<LiveClient>()
  room.add(client)
  rooms.set(sessionId, room)
}

export function leaveRoom(sessionId: string, client: LiveClient): void {
  const room = rooms.get(sessionId)
  if (!room) return
  room.delete(client)
  if (room.size === 0) rooms.delete(sessionId)
}

/** Sends to every client in the room, or only to the teachers when asked. */
export function broadcast(sessionId: string, message: LiveMessage, teachersOnly = false): void {
  const room = rooms.get(sessionId)
  if (!room) return
  for (const client of room) {
    if (teachersOnly && !client.isTeacher) continue
    send(client, message)
  }
}

export function sendTo(client: LiveClient, message: LiveMessage): void {
  send(client, message)
}

export function roomSize(sessionId: string): number {
  return rooms.get(sessionId)?.size ?? 0
}
