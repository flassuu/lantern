<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppHeader from '../components/AppHeader.vue'
import JoinSessionCard from '../components/student/JoinSessionCard.vue'
import SessionResult from '../components/student/SessionResult.vue'
import StudentCourses from '../components/student/StudentCourses.vue'
import StudentResults from '../components/student/StudentResults.vue'
import SessionRunner from '../components/student/SessionRunner.vue'
import LobbyScreen from '../components/student/LobbyScreen.vue'
import { ApiError } from '../api/client'
import {
  getCurrentSession,
  getSessionResult,
  joinSession,
  type SessionResultBody,
  type SessionState,
} from '../api/sessions'
import AppButton from '../components/common/AppButton.vue'
import { usePresence } from '../composables/presence'

const { t } = useI18n()

const code = ref('')
const joining = ref(false)
const joinError = ref('')
const state = ref<SessionState | null>(null)
const result = ref<SessionResultBody | null>(null)
const loading = ref(false)
const loadError = ref('')

/**
 * The run the student is in, as one socket: their own presence and progress go
 * out, and the server's status comes back. That status is what turns a lobby
 * into a paper the moment the teacher starts, without a poll or a reload.
 */
const sessionId = computed(() => state.value?.session.id ?? null)
const presence = usePresence(sessionId)
/** What the server last said, falling back to what the join response said. */
const liveStatus = computed(() => presence.status.value ?? state.value?.session.status ?? 'active')

/**
 * A teacher can hand out a link (or a QR of it) that lands the student straight
 * on the join card with the code filled in.
 */
function codeFromLink(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('join')
  if (fromQuery) return fromQuery.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
  return ''
}

function clearCodeFromLink(): void {
  if (!new URLSearchParams(window.location.search).has('join')) return
  const url = new URL(window.location.href)
  url.searchParams.delete('join')
  window.history.replaceState(null, '', url.toString())
}

function joinErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return t('student.errors.joinFailed')
  if (error.code === 'NOT_FOUND') return t('student.errors.noSuchCode')
  if (error.code === 'CONFLICT') return t('student.errors.sessionClosed')
  if (error.code === 'NETWORK') return t('student.errors.network')
  if (error.code === 'FORBIDDEN') return t('student.errors.notAllowed')
  return t('student.errors.joinFailed')
}

async function join(): Promise<void> {
  joining.value = true
  joinError.value = ''
  try {
    state.value = await joinSession(code.value)
    code.value = ''
    clearCodeFromLink()
  } catch (error) {
    joinError.value = joinErrorMessage(error)
  } finally {
    joining.value = false
  }
}

async function showResult(sessionId: string): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    result.value = await getSessionResult(sessionId)
    // The paper is spent: leaving the result must land on the home screen, not
    // on a stale runner for a session that can no longer be submitted.
    state.value = null
  } catch (error) {
    loadError.value = t('student.errors.resultFailed')
  } finally {
    loading.value = false
  }
}

/**
 * A reload mid-session must land the student back on their paper, not the gate.
 * Deliberately silent: toggling the skeleton here would tear the course list
 * down and mount it again, fetching the courses twice on every page load.
 */
async function resume(): Promise<void> {
  try {
    state.value = await getCurrentSession()
  } catch {
    // No active session is the normal case, not an error worth showing.
    state.value = null
  }
}

function leaveRunner(): void {
  state.value = null
  void resume()
}

onMounted(() => {
  code.value = codeFromLink()
  void resume()
})
</script>

<template>
  <div class="min-h-dvh bg-surface">
    <AppHeader />

    <main class="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6">
      <h2 class="text-xl font-semibold text-on-surface">
        {{ t('student.heading') }}
      </h2>
      <p class="mt-1 text-sm text-on-surface-variant">{{ t('student.subheading') }}</p>

      <p
        v-if="loadError"
        role="alert"
        class="mt-4 rounded-xl bg-error-container px-3 py-2 text-sm text-on-error-container"
      >
        {{ loadError }}
      </p>

      <div v-if="loading" class="mt-6 space-y-3" role="status">
        <span class="sr-only">{{ t('common.loading') }}</span>
        <div class="h-4 w-1/2 rounded-full bg-surface-container-highest" aria-hidden="true" />
        <div class="h-3 w-3/4 rounded-full bg-surface-container-highest" aria-hidden="true" />
      </div>

      <template v-else-if="result">
        <SessionResult class="mt-6" :result="result" />
        <AppButton variant="secondary" class="mt-4 rounded-xl" @click="result = null">
          {{ t('student.result.back') }}
        </AppButton>
        <AppButton variant="primary" class="mt-2 rounded-xl" @click="resume()">
          {{ t('student.result.joinAnother') }}
        </AppButton>
      </template>

      <template v-else-if="state">
        <div class="mt-6">
          <!-- The waiting room, until the teacher starts the run. -->
          <LobbyScreen v-if="liveStatus === 'lobby'" :state="state" />
          <SessionRunner
            v-else
            :state="state"
            :left-once="presence.leftOnce.value"
            :report-progress="presence.reportProgress"
            @submitted="showResult"
          />
        </div>
        <button
          type="button"
          @click="leaveRunner"
          class="mt-4 text-xs text-on-surface-variant underline"
        >
          {{ t('student.runner.leave') }}
        </button>
      </template>

      <template v-else>
        <div class="mt-6">
          <JoinSessionCard
            v-model="code"
            v-model:busy="joining"
            v-model:error="joinError"
            @joined="join"
          />
        </div>

        <div class="mt-6">
          <StudentCourses />
        </div>

        <div class="mt-6">
          <StudentResults @open="showResult" />
        </div>
      </template>

    </main>
  </div>
</template>
