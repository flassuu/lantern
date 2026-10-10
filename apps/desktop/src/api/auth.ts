import { apiFetch, setToken } from './client'
import type { PublicUser } from './types'

export interface LoginResult {
  token: string
  user: PublicUser
}

export interface RegisterPayload {
  username: string
  password: string
  fullName: string
  /** Optional: a key the teacher handed out. It approves the account straight
   *  away; without it the account waits for an admin, as before. */
  roomKey?: string
}

/** What a student is told after registering: which room they joined, if any. */
export interface RegisterResult {
  user: PublicUser
  viaRoom: { roomName: string; teacherName: string } | null
}

export async function login(username: string, password: string): Promise<LoginResult> {
  const result = await apiFetch<LoginResult>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  setToken(result.token)
  return result
}

export async function logout(): Promise<void> {
  try {
    await apiFetch<void>('/api/auth/logout', { method: 'POST' })
  } finally {
    setToken(null)
  }
}

export async function register(payload: RegisterPayload): Promise<RegisterResult> {
  return apiFetch<RegisterResult>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/**
 * Changes the signed-in account's own password.
 *
 * The server ends every session and hands back a new token, so the caller stores
 * it — this is the only way the desktop app's "admin password" setting can mean
 * anything for a database that already exists: the seed variable is read once,
 * when there is no admin yet.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<LoginResult> {
  const result = await apiFetch<LoginResult>('/api/auth/password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  })
  setToken(result.token)
  return result
}

export async function fetchMe(): Promise<PublicUser> {
  const result = await apiFetch<{ user: PublicUser }>('/api/auth/me')
  return result.user
}