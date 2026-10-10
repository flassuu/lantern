import { apiFetch } from './client'
import type { CreateRoom, Room, RoomCourse, RoomDetail, RoomMember, RoomPreview } from './types'

/** The signed-in teacher's own rooms; an admin sees every room. */
export async function listRooms(): Promise<Room[]> {
  const result = await apiFetch<{ rooms: Room[] }>('/api/rooms')
  return result.rooms
}

export async function getRoom(id: string): Promise<RoomDetail> {
  return apiFetch<RoomDetail>(`/api/rooms/${id}`)
}

export async function createRoom(input: CreateRoom): Promise<Room> {
  const result = await apiFetch<{ room: Room }>('/api/rooms', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return result.room
}

/** Renames a room, re-points it at courses, or both — whichever fields are sent. */
export async function updateRoom(
  id: string,
  input: { name?: string; courseIds?: string[] },
): Promise<RoomDetail> {
  return apiFetch<RoomDetail>(`/api/rooms/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export async function revokeRoom(id: string): Promise<Room> {
  const result = await apiFetch<{ room: Room }>(`/api/rooms/${id}/revoke`, {
    method: 'POST',
  })
  return result.room
}

/** A new key for a room whose code was photographed and left on a wall. */
export async function regenerateRoomKey(id: string): Promise<string> {
  const result = await apiFetch<{ key: string }>(`/api/rooms/${id}/key`, {
    method: 'POST',
  })
  return result.key
}

export async function deleteRoom(id: string): Promise<void> {
  await apiFetch<void>(`/api/rooms/${id}`, { method: 'DELETE' })
}

/** Public: what a room key leads to, checked before a student types a password. */
export async function previewRoomKey(key: string): Promise<RoomPreview> {
  const result = await apiFetch<{ preview: RoomPreview }>(
    `/api/rooms/preview?key=${encodeURIComponent(key)}`,
  )
  return result.preview
}

export type { Room, RoomCourse, RoomDetail, RoomMember, RoomPreview }