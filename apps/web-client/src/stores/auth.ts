import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { fetchMe, login as apiLogin, logout as apiLogout } from '../api/auth'
import { getToken, setToken } from '../api/client'
import { clearDraftsForUser } from '../composables/sessionDraft'
import type { PublicUser } from '../api/types'

type AuthStatus = 'initializing' | 'authenticated' | 'guest'

// Module-level singleton so every component observes the same session.
const user: Ref<PublicUser | null> = ref(null)
const status: Ref<AuthStatus> = ref('initializing')

export function useAuth() {
  /** Restores a persisted session on app start; falls back to guest. */
  async function initialize(): Promise<void> {
    if (!getToken()) {
      status.value = 'guest'
      return
    }
    try {
      user.value = await fetchMe()
      status.value = 'authenticated'
    } catch {
      setToken(null)
      user.value = null
      status.value = 'guest'
    }
  }

  async function signIn(username: string, password: string): Promise<void> {
    const result = await apiLogin(username, password)
    user.value = result.user
    status.value = 'authenticated'
  }

  async function signOut(): Promise<void> {
    try {
      await apiLogout()
    } catch {
      // Server may be unreachable — still clear the local session so the UI
      // always returns to the sign-in screen.
    } finally {
      // A shared phone in a classroom: the next student must not find the last
      // one's answers still sitting in localStorage.
      if (user.value !== null) clearDraftsForUser(user.value.id)
      user.value = null
      status.value = 'guest'
    }
  }

  const isAuthenticated: ComputedRef<boolean> = computed(
    () => status.value === 'authenticated',
  )
  const isGuest: ComputedRef<boolean> = computed(() => status.value === 'guest')

  return { user, status, isAuthenticated, isGuest, initialize, signIn, signOut }
}