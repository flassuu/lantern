import { reactive } from 'vue'
import { listRooms, type Room } from '../api/rooms'

interface RoomsState {
  rooms: Room[]
  loaded: boolean
}

/**
 * The teacher's rooms, fetched once.
 *
 * Three screens need the same list — the Tests editor picking a room, the Live
 * tab naming a run, and the Rooms tab itself — and a teacher's room list is
 * small and changes rarely. A shared fetch keeps them from racing each other,
 * and a failure leaves an empty list rather than a spinner that never ends:
 * every one of them has something to show without it.
 */
const state = reactive<RoomsState>({ rooms: [], loaded: false })

export function getRoomsState(): RoomsState {
  return state
}

export async function loadRooms(): Promise<Room[]> {
  if (state.loaded) return state.rooms
  try {
    state.rooms = await listRooms()
  } catch {
    // Offline is not an error here: a teacher can still write a test, and the
    // picker simply shows nothing to point at.
    state.rooms = []
  } finally {
    state.loaded = true
  }
  return state.rooms
}

export type { Room } from '../api/rooms'