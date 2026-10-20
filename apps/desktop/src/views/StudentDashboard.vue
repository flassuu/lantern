<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { History, Library, LogIn } from '@lucide/vue'
import AppHeader from '../components/AppHeader.vue'
import TabStrip from '../components/common/TabStrip.vue'
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
import AppCard from '../components/common/AppCard.vue'
import SkeletonList from '../components/common/SkeletonList.vue'
import { usePresence } from '../composables/presence'

const { t } = useI18n()

const code = ref('')
const joining = ref(false)
const joinError = ref('')
const state = ref<SessionState | null>(null)
const result = ref<SessionResultBody | null>(null)
const loading = ref(false)
const loadError = ref('')
/** True when the paper was handed in but the teacher holds the result. */
const held = ref(false)

/**
 * Which of the three things a student does is on screen: join a run, read the
 * course, look at results. The same strip the teacher's workbench uses, for the
 * same reason - one row of equal segments that does not resize when the locale
 * changes, and one screen per job instead of three stacked down the page.
 */
const activeTab = ref<'join' | 'courses' | 'results'>('join')

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
 * The clock, folded back into the session the runner reads.
 *
 * The session the student holds is the one they joined with, and by the time
 * they are answering it can be out of date: the teacher paused the run, resumed
 * it (which moves its start mark forward by the length of the hold) or gave it
 * fifteen more seconds. The socket carries all three, and writing them into the
 * one object the runner already reads is what makes the paper's clock the
 * server's clock - without this the student watches a clock that has been
 * running against numbers nobody uses any more, and one that says the time is
 * up while the class is still writing.
 */
watch(
  () => presence.clock.value,
  (clock) => {
    const current = state.value
    if (!current || !clock) return
    state.value = {
      ...current,
      session: {
        ...current.session,
        serverNow: clock.serverNow,
        startedAt: clock.startedAt,
        pausedAt: clock.pausedAt,
        timeLimitSec: clock.timeLimitSec,
      },
    }
  },
)

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

async function showResult(sessionId: string, released = true): Promise<void> {
  // Held is not an error and not a result: the paper is graded and waiting.
  if (!released) {
    held.value = true
    state.value = null
    return
  }
  held.value = false
  loading.value = true
  loadError.value = ''
  try {
    result.value = await getSessionResult(sessionId)
    // The paper is spent: leaving the result must land on the home screen, not
    // on a stale runner for a session that can no longer be submitted.
    state.value = null
  } catch (error) {
    // A held result is not a failure: the teacher has not let it out yet.
    if (error instanceof ApiError && error.code === 'RESULT_HELD') {
      held.value = true
      return
    }
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
  held.value = false
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
  const fromLink = codeFromLink()
  // A link from a teacher's QR arrives with the code already filled in, so the
  // join tab is the one that has to be on screen for it.
  if (fromLink) activeTab.value = 'join'
  code.value = fromLink
  void resume()
})
</script>

<template>
  <div class="min-h-dvh bg-surface">
    <AppHeader />

    <main class="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
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

      <SkeletonList v-if="loading" class="mt-6" :rows="3" />

      <template v-else-if="held">
        <AppCard as="section" class="mt-6">
          <p class="text-sm text-on-surface-variant">{{ t('student.paged.held') }}</p>
        </AppCard>
        <AppButton variant="primary" class="mt-4 rounded-xl" @click="resume()">
          {{ t('student.result.back') }}
        </AppButton>
      </template>

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
          <!-- The waiting room, until the teacher starts the run. The fade is
               the point: the paper arriving is the teacher's press, and a hard
               cut would read as the screen breaking. -->
          <Transition name="view" mode="out-in">
            <LobbyScreen v-if="liveStatus === 'lobby'" :state="state" />
            <SessionRunner
              v-else
              :state="state"
              :left-once="presence.leftOnce.value"
              :report-progress="presence.reportProgress"
              @submitted="showResult"
            />
          </Transition>
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
        <TabStrip
          v-model="activeTab"
          class="mt-5"
          :aria-label="t('student.heading')"
          :items="[
            { value: 'join', label: t('student.tabs.join'), icon: LogIn },
            { value: 'courses', label: t('student.tabs.courses'), icon: Library },
            { value: 'results', label: t('student.tabs.results'), icon: History },
          ]"
        />

        <!--
          `:key` remounts the sheet on a tab change and the transition fades it
          in and out: the same swap as the teacher's workbench, so the two sides
          of the app move the same way.
        -->
        <Transition mode="out-in" name="view">
          <div :key="activeTab" class="mt-5">
            <JoinSessionCard
              v-if="activeTab === 'join'"
              v-model="code"
              v-model:busy="joining"
              v-model:error="joinError"
              @joined="join"
            />
            <StudentCourses v-else-if="activeTab === 'courses'" />
            <StudentResults v-else @open="showResult" />
          </div>
        </Transition>
      </template>

    </main>
  </div>
</template>
