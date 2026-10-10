<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  CircleCheck,
  CircleX,
  Copy,
  Download,
  Hourglass,
  Link2,
  Lock,
  LockOpen,
  Pause,
  Percent,
  Play,
  QrCode,
  Radio,
  Square,
  Timer,
  TriangleAlert,
  Trophy,
  UserCheck,
  Users,
  X,
} from '@lucide/vue'
import { ApiError, downloadFile } from '../../api/client'
import {
  beginSession,
  listSessions,
  setEntryLocked,
  setSessionStatus,
  startSession,
  type LiveSession,
  type LiveSessionStatus,
  type ParticipantEntry,
  type SessionSummary,
} from '../../api/sessions'
import type { TestSummary } from '../../api/types'
import EmptyState from '../common/EmptyState.vue'
import QrCodeCard from '../common/QrCode.vue'
import SkeletonList from '../common/SkeletonList.vue'
import TestPicker from './TestPicker.vue'
import TagInput from './TagInput.vue'
import SessionTabs from './SessionTabs.vue'
import SessionLibraryDialog from './SessionLibraryDialog.vue'
import { useConfirm } from '../../composables/confirm'
import { useDialogFocus } from '../../composables/focusTrap'
import { effectiveBaseUrl, loadSettings } from '../../composables/settings'
import { isReachableFromPhone, joinLink as buildJoinLink } from '../../utils/links'
import { useSessionChannel } from '../../composables/sessionChannel'
import { getRoomsState, loadRooms } from '../../composables/rooms'
import { useToast } from '../../composables/toast'
import AppButton from '../../components/common/AppButton.vue'
import AppCard from '../../components/common/AppCard.vue'
import AppDialog from '../../components/common/AppDialog.vue'
import AppInput from '../../components/common/AppInput.vue'

const props = defineProps<{
  tests: TestSummary[]
}>()

const { t, locale } = useI18n()
const confirm = useConfirm()
const toast = useToast()

const sessions = ref<SessionSummary[]>([])
const selectedId = ref('')
const loading = ref(false)
const errorKey = ref('')
const actionError = ref('')
const starting = ref(false)
/** Busy while the lobby is being opened; separate from the start-a-session dialog. */
const lobbyStarting = ref(false)
const startingTestId = ref('')
const showStart = ref(false)
const showLibrary = ref(false)
const copied = ref(false)
const linkCopied = ref(false)
const showQr = ref(false)

/** True while the spreadsheet download is in flight. */
const exporting = ref(false)

/** The server pushes the board over a WebSocket; polling is the fallback. */
const channel = useSessionChannel()
const participants = channel.participants
const boardStatus = channel.status

/**
 * A wall clock the elapsed and remaining labels are derived from. The server
 * measures the time limit against `startedAt` and the wall clock too, so pausing
 * does not stop the count - and neither does this.
 */
const now = ref(Date.now())
let clock: number | undefined

/** The address students are being sent to, and whether they can open it. */
const joinOrigin = computed(() => effectiveBaseUrl())
const originReachable = computed(() => isReachableFromPhone(joinOrigin.value))

const selected = computed(
  () => sessions.value.find((session) => session.id === selectedId.value) ?? null,
)
/**
 * The test behind the selected session, looked up by id: the session list
 * carries `testId` and a title, not the test object - only the create and
 * status responses do - so the question count comes from the list this screen
 * was already handed.
 */
const selectedTest = computed(
  () => props.tests.find((test) => test.id === selected.value?.testId) ?? null,
)
/** What a session is called on screen: the teacher's own name, or the test's. */
const sessionName = (session: SessionSummary): string => session.name ?? session.title
const selectedName = computed(() => (selected.value ? sessionName(selected.value) : ''))
const rooms = getRoomsState()
const roomNameOf = (id: string | null): string =>
  rooms.rooms.find((room) => room.id === id)?.name ?? ''

/** What the start dialog collects beyond the test: a name, a room, labels. */
const sessionNameDraft = ref('')
const sessionRoomId = ref<string | null>(null)
const sessionTags = ref<string[]>([])
const joinedCount = computed(() => participants.value.length)
const workingCount = computed(
  () => participants.value.filter((entry) => entry.status === 'joined').length,
)
const submittedCount = computed(() => joinedCount.value - workingCount.value)
const passedCount = computed(
  () => participants.value.filter((entry) => entry.passed === true).length,
)
const failedCount = computed(
  () =>
    participants.value.filter((entry) => entry.status !== 'joined' && entry.passed === false)
      .length,
)
/** Mean of the scores that exist, or null while nobody has handed anything in. */
const averagePercent = computed(() => {
  const scored = participants.value.filter(
    (entry) => entry.status !== 'joined' && entry.percent !== null,
  )
  if (scored.length === 0) return null
  return Math.round(scored.reduce((sum, entry) => sum + (entry.percent ?? 0), 0) / scored.length)
})
const progressPercent = computed(() =>
  joinedCount.value === 0 ? 0 : Math.round((submittedCount.value / joinedCount.value) * 100),
)

/** Time since the session started, frozen at the finish mark once it is over. */
const elapsedSeconds = computed(() => {
  const session = selected.value
  if (!session) return 0
  // A lobby has no start mark yet, so it has no elapsed time either.
  if (session.startedAt === null) return 0
  const start = Date.parse(session.startedAt)
  if (Number.isNaN(start)) return 0
  const end = session.finishedAt ? Date.parse(session.finishedAt) : now.value
  return Math.max(0, Math.floor((end - start) / 1000))
})
const remainingSeconds = computed(() => {
  const limit = selected.value?.timeLimitSec
  if (limit == null) return null
  return limit - elapsedSeconds.value
})
const timeIsShort = computed(() => remainingSeconds.value !== null && remainingSeconds.value <= 60)
const timerLabel = computed(() => {
  const remaining = remainingSeconds.value
  if (remaining !== null && remaining <= 0) return t('teacher.live.timeUp')
  return formatClock(remaining ?? elapsedSeconds.value)
})
const timerCaption = computed(() => {
  if (boardStatus.value === 'finished') return t('teacher.live.duration')
  return remainingSeconds.value !== null ? t('teacher.live.timeLeft') : t('teacher.live.elapsed')
})

const sortedParticipants = computed(() =>
  [...participants.value].sort((left, right) => {
    if (left.status === 'joined') return 1
    if (right.status === 'joined') return -1
    return (right.percent ?? -1) - (left.percent ?? -1)
  }),
)

const statusChip: Record<LiveSessionStatus, string> = {
  lobby: 'bg-primary-container text-on-primary-container',
  active: 'bg-success-container text-on-success-container',
  paused: 'bg-warning-container text-on-warning-container',
  finished: 'bg-surface-container-highest text-on-surface-variant',
}

const statusDot: Record<LiveSessionStatus, string> = {
  lobby: 'bg-primary',
  active: 'bg-success',
  paused: 'bg-warning',
  finished: 'bg-on-surface-variant',
}

/** The one dialog on this screen: a test is chosen, then the run starts. */
const panel = ref<HTMLElement | null>(null)
const cancelRef = ref<HTMLButtonElement | null>(null)
useDialogFocus(() => showStart.value, () => closeStart(), panel, cancelRef)

function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, totalSeconds)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit' }).format(date)
}

/** Up to two initials: from the full name when there is one, the login otherwise. */
function monogram(entry: ParticipantEntry): string {
  const source = (entry.fullName || entry.username || '').trim()
  if (!source) return '?'
  const parts = source.split(/\s+/)
  const first = parts[0]?.charAt(0) ?? ''
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : ''
  return (first + last).toUpperCase()
}

/** The avatar carries the result: green for a pass, red for a fail, neutral while
 *  working and neutral when the test has no pass mark to judge against. */
function avatarClass(entry: ParticipantEntry): string {
  if (entry.status === 'joined') return 'bg-surface-container-highest text-on-surface-variant'
  if (entry.passed === true) return 'bg-success-container text-on-success-container'
  if (entry.passed === false) return 'bg-error-container text-on-error-container'
  return 'bg-surface-container-highest text-on-surface-variant'
}

function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return t('teacher.errors.generic')
  if (error.code === 'NETWORK') return t('teacher.errors.network')
  if (error.code === 'VALIDATION' || error.code === 'INVALID_OPERATION') return t('teacher.errors.validation')
  if (error.code === 'CONFLICT') return t('teacher.errors.conflict')
  if (error.code === 'NOT_FOUND') return t('teacher.errors.notFound')
  return t('teacher.errors.generic')
}

async function load(): Promise<void> {
  loading.value = true
  errorKey.value = ''
  try {
    sessions.value = await listSessions()
    if (!selectedId.value || !sessions.value.some((session) => session.id === selectedId.value)) {
      selectedId.value = sessions.value[0]?.id ?? ''
    }
  } catch (error) {
    errorKey.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

function openStart(): void {
  actionError.value = ''
  startingTestId.value = ''
  // Every run starts blank, except for the room: most of the time the paper was
  // written for one group and that is who is in the room, so offering it already
  // ticked saves a decision that is usually already made.
  sessionNameDraft.value = ''
  sessionTags.value = []
  sessionRoomId.value = null
  showStart.value = true
}

/** Picking a test pre-fills the room that test belongs to, if any. */
function chooseTestForStart(testId: string): void {
  startingTestId.value = testId
  const test = props.tests.find((entry) => entry.id === testId)
  if (test) sessionRoomId.value = test.roomId ?? null
}

function closeStart(): void {
  if (starting.value) return
  showStart.value = false
  startingTestId.value = ''
}

async function start(testId: string): Promise<void> {
  starting.value = true
  actionError.value = ''
  try {
    const name = sessionNameDraft.value.trim()
    const session = await startSession(testId, {
      name: name === '' ? null : name,
      roomId: sessionRoomId.value,
      tags: sessionTags.value,
    })
    showStart.value = false
    startingTestId.value = ''
    toast.success(t('teacher.live.started', { code: session.joinCode }))
    await load()
    selectedId.value = session.id
  } catch (error) {
    actionError.value = errorMessage(error)
  } finally {
    starting.value = false
  }
}

/** Folds a session the server just returned back into the list, in place. */
function applySession(updated: LiveSession): void {
  sessions.value = sessions.value.map((session) =>
    session.id === updated.id ? { ...session, ...updated } : session,
  )
}

/** Leaves the lobby: stamps the clock and opens the doors. */
async function begin(): Promise<void> {
  const session = selected.value
  if (!session) return
  actionError.value = ''
  lobbyStarting.value = true
  try {
    applySession(await beginSession(session.id))
  } catch (error) {
    actionError.value = errorMessage(error)
  } finally {
    lobbyStarting.value = false
  }
}

async function toggleEntryLock(): Promise<void> {
  const session = selected.value
  if (!session) return
  actionError.value = ''
  try {
    applySession(await setEntryLocked(session.id, !session.entryLocked))
  } catch (error) {
    actionError.value = errorMessage(error)
  }
}

/**
 * What the board says about a student who has not handed in yet. Offline beats
 * hidden beats answered, because that is the order of how much it matters.
 */
function liveState(entry: ParticipantEntry): string {
  if (entry.online === false) return t('teacher.live.presence.offline')
  if (entry.active === false) return t('teacher.live.presence.inactive')
  if ((entry.answered ?? 0) > 0) {
    return t('teacher.live.presence.answered', { count: entry.answered ?? 0 })
  }
  return t('teacher.live.presence.waiting')
}

function liveTone(entry: ParticipantEntry): string {
  if (entry.online === false) return 'bg-error-container text-on-error-container'
  if (entry.active === false) return 'bg-warning-container text-on-warning-container'
  return 'bg-surface-container-highest text-on-surface-variant'
}

async function changeStatus(status: LiveSessionStatus): Promise<void> {
  if (!selected.value) return
  if (status === 'finished') {
    const outstanding = participants.value.filter((entry) => entry.status === 'joined').length
    const ok = await confirm({
      message:
        outstanding > 0
          ? t('teacher.live.finishConfirmOutstand', { count: outstanding })
          : t('teacher.live.finishConfirm'),
    })
    if (!ok) return
  }
  actionError.value = ''
  try {
    await setSessionStatus(selected.value.id, status)
    await load()
  } catch (error) {
    actionError.value = errorMessage(error)
  }
}

async function exportCsv(): Promise<void> {
  const session = selected.value
  if (!session || exporting.value) return
  exporting.value = true
  try {
    await downloadFile(
      `/api/sessions/${session.id}/results.csv`,
      `session-${session.joinCode}.csv`,
    )
  } catch (error) {
    toast.error(
      error instanceof ApiError && error.status === 403
        ? t('teacher.errors.generic')
        : t('teacher.errors.network'),
    )
  } finally {
    exporting.value = false
  }
}

async function writeClipboard(value: string, flag: 'code' | 'link'): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    if (flag === 'code') copied.value = true
    else linkCopied.value = true
    window.setTimeout(() => {
      if (flag === 'code') copied.value = false
      else linkCopied.value = false
    }, 1500)
  } catch {
    // Clipboard is blocked in some contexts; the value is on screen anyway.
    actionError.value = t('teacher.live.copyFailed')
  }
}

function copyCode(): Promise<void> {
  return selected.value ? writeClipboard(selected.value.joinCode, 'code') : Promise.resolve()
}

/**
 * The link a student opens. It comes from the server's public address when an
 * admin has set one, and from this window's origin otherwise - which is the
 * teacher's own machine, and a phone cannot open it. That is why the origin is
 * shown below the QR and called out when it is unreachable.
 */
function joinLink(): string {
  if (!selected.value) return ''
  return buildJoinLink(effectiveBaseUrl(), selected.value.joinCode)
}

function copyLink(): Promise<void> {
  return writeClipboard(joinLink(), 'link')
}

watch(selectedId, (id) => {
  if (id) channel.connect(id)
  else channel.disconnect()
})

onMounted(() => {
  void load()
  void loadSettings()
  void loadRooms()
  clock = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onBeforeUnmount(() => {
  if (clock !== undefined) window.clearInterval(clock)
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h3 class="text-base font-semibold text-on-surface">{{ t('teacher.live.heading') }}</h3>
      <!-- While the list is empty the empty state carries the call to action, so
           the header does not repeat it. -->
      <AppButton v-if="loading || sessions.length > 0" variant="primary" @click="openStart">
        <Radio class="size-3.5" aria-hidden="true" />
        {{ t('teacher.live.start') }}
      </AppButton>
    </div>

    <p
      v-if="errorKey"
      role="alert"
      class="rounded-xl bg-error-container px-3 py-2 text-sm text-on-error-container"
    >
      {{ errorKey }}
    </p>

    <SkeletonList v-if="loading" :rows="2" />

    <EmptyState
      v-else-if="sessions.length === 0"
      :icon="Radio"
      :title="t('teacher.live.emptyTitle')"
      :description="t('teacher.live.emptyHint')"
      :action-label="t('teacher.live.start')"
      @action="openStart"
    />

    <template v-else>
      <!--
        One unit. The tabs are the sheet's top edge and the board below them
        belongs to the tab that is open; the alternative - a row of tabs beside a
        board of unknown ownership - made the teacher count cards to be sure
        which one they were looking at.
      -->
      <div class="overflow-hidden rounded-2xl border border-outline-variant bg-surface">
        <SessionTabs
          :sessions="sessions"
          :selected-id="selectedId"
          @select="selectedId = $event"
          @library="showLibrary = true"
        />

        <div class="space-y-3 p-3">
          <p
            v-if="actionError"
            role="alert"
            class="rounded-xl bg-error-container px-3 py-2 text-sm text-on-error-container"
          >
            {{ actionError }}
          </p>


      <template v-if="selected">
        <!-- Who the session is, how long it has run, and how students get in. -->
        <AppCard as="section">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <span
                  class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
                  :class="statusChip[boardStatus]"
                >
                  <span class="size-1.5 rounded-full" :class="statusDot[boardStatus]" />
                  {{ t(`teacher.live.status.${boardStatus}`) }}
                </span>
                <span class="text-[11px] text-on-surface-variant">
                  <template v-if="selectedTest">
                    {{ t('teacher.tests.questionCount', { count: selectedTest.questionCount }) }}
                  </template>
                  <template v-if="selected.timeLimitSec">
                    <span v-if="selectedTest"> · </span>{{ selected.timeLimitSec / 60 }}
                    {{ t('teacher.tests.minutes') }}
                  </template>
                </span>
              </div>
              <h4 class="mt-1.5 truncate text-lg font-semibold text-on-surface">
                {{ selectedName }}
              </h4>
              <!-- A run the teacher named shows the paper it ran as well: the name
                   says which lesson this was, the title says what was asked. -->
              <p
                v-if="selected.name && selected.title"
                class="mt-0.5 truncate text-xs text-on-surface-variant"
              >
                {{ selected.title }}
              </p>
              <div
                v-if="roomNameOf(selected.roomId) || selected.tags.length"
                class="mt-1.5 flex flex-wrap items-center gap-1.5"
              >
                <span
                  v-if="roomNameOf(selected.roomId)"
                  class="inline-flex items-center gap-1 rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-semibold text-on-surface-variant"
                >
                  <Users class="size-3" aria-hidden="true" />
                  {{ roomNameOf(selected.roomId) }}
                </span>
                <span
                  v-for="tag in selected.tags"
                  :key="tag.id"
                  class="rounded-full bg-secondary-container px-2 py-0.5 text-[11px] font-semibold text-on-secondary-container"
                >
                  {{ tag.name }}
                </span>
              </div>
              <p v-if="selected.startedAt" class="mt-0.5 text-xs text-on-surface-variant">
                {{ t('teacher.live.startedAt', { time: formatTime(selected.startedAt) }) }}
              </p>
            </div>

            <!-- A lobby has no clock to show; the tiles below are all zero anyway. -->
            <div
              v-if="boardStatus !== 'lobby'"
              class="flex shrink-0 items-center gap-2 rounded-2xl border border-outline-variant bg-surface-container-high px-3 py-2"
            >
              <span
                class="grid size-9 place-items-center rounded-full bg-surface-container-highest text-on-surface-variant"
              >
                <Timer class="size-4" aria-hidden="true" />
              </span>
              <span class="leading-tight">
                <span
                  class="block text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant"
                >
                  {{ timerCaption }}
                </span>
                <span
                  class="block font-mono text-base font-semibold tabular-nums"
                  :class="timeIsShort ? 'text-error' : 'text-on-surface'"
                >
                  {{ timerLabel }}
                </span>
              </span>
            </div>
          </div>

          <div class="mt-4 rounded-2xl border border-outline-variant bg-surface-container-high p-3 sm:p-4">
            <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div class="min-w-0">
                <p class="text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant">
                  {{ t('teacher.live.codeLabel') }}
                </p>
                <p
                  class="font-mono text-3xl font-bold tracking-[0.2em] text-on-surface sm:text-4xl"
                >
                  {{ selected.joinCode }}
                </p>
              </div>
              <div class="flex flex-wrap gap-2">
                <AppButton variant="primary" @click="copyCode">
                  <CircleCheck v-if="copied" class="size-3.5" aria-hidden="true" />
                  <Copy v-else class="size-3.5" aria-hidden="true" />
                  {{ copied ? t('teacher.live.copied') : t('teacher.live.copy') }}
                </AppButton>
                <AppButton variant="secondary" @click="copyLink">
                  <CircleCheck v-if="linkCopied" class="size-3.5" aria-hidden="true" />
                  <Link2 v-else class="size-3.5" aria-hidden="true" />
                  {{ linkCopied ? t('teacher.live.copied') : t('teacher.live.copyLink') }}
                </AppButton>
                <AppButton
                  variant="secondary"
                  :aria-pressed="showQr"
                  @click="showQr = !showQr"
                >
                  <QrCode class="size-3.5" aria-hidden="true" />
                  {{ showQr ? t('teacher.live.hideQr') : t('teacher.live.showQr') }}
                </AppButton>
              </div>
            </div>

            <div v-if="showQr" class="mt-3 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
              <QrCodeCard :text="joinLink()" :caption="t('teacher.live.qrCaption')" />
              <div class="min-w-0 space-y-1">
                <p class="text-xs text-on-surface-variant">{{ t('teacher.live.linkHint') }}</p>
                <p class="break-all font-mono text-[11px] text-on-surface-variant">
                  {{ joinLink() }}
                </p>
                <p class="text-[11px] text-on-surface-variant">
                  {{ t('teacher.live.qrAddress') }}:
                  <span class="font-mono">{{ joinOrigin }}</span>
                </p>
              </div>
            </div>
            <p v-else class="mt-3 text-xs text-on-surface-variant">
              {{ t('teacher.live.linkHint') }}
              <span class="break-all font-mono text-[11px]">{{ joinLink() }}</span>
            </p>

            <!-- A QR that scans and then fails reads as a broken app, so the one
                 case where that happens is stated instead of left to be
                 discovered in the middle of a lesson. -->
            <p
              v-if="!originReachable"
              class="mt-3 flex items-start gap-2 rounded-xl bg-warning-container px-3 py-2 text-xs text-on-warning-container"
            >
              <TriangleAlert class="mt-px size-4 shrink-0" aria-hidden="true" />
              <span>
                {{ t('teacher.live.unreachableHint') }}
                <span class="break-all font-mono">{{ joinOrigin }}</span>
              </span>
            </p>
          </div>

          <p v-if="boardStatus === 'lobby'" class="mt-3 text-xs text-on-surface-variant">
            {{ t('teacher.live.lobbyHint', { count: joinedCount }) }}
          </p>

          <div class="mt-4 flex flex-wrap items-center gap-2">
            <!-- The one action that leaves the lobby. -->
            <AppButton
              v-if="boardStatus === 'lobby'"
              variant="primary"
              :disabled="lobbyStarting"
              @click="begin()"
            >
              <Play class="size-3.5" aria-hidden="true" />
              {{ t('teacher.live.begin') }}
            </AppButton>
            <AppButton
              v-if="boardStatus === 'active'"
              variant="secondary"
              @click="changeStatus('paused')"
            >
              <Pause class="size-3.5" aria-hidden="true" />
              {{ t('teacher.live.pause') }}
            </AppButton>
            <AppButton
              v-else-if="boardStatus === 'paused'"
              variant="secondary"
              @click="changeStatus('active')"
            >
              <Play class="size-3.5" aria-hidden="true" />
              {{ t('teacher.live.resume') }}
            </AppButton>
            <AppButton
              v-if="boardStatus !== 'finished'"
              variant="danger"
              @click="changeStatus('finished')"
            >
              <Square class="size-3.5" aria-hidden="true" />
              {{ t('teacher.live.finish') }}
            </AppButton>
            <AppButton
              v-if="boardStatus !== 'finished'"
              variant="ghost"
              icon
              size="sm"
              :aria-pressed="selected.entryLocked"
              :aria-label="
                selected.entryLocked ? t('teacher.live.entryUnlock') : t('teacher.live.entryLock')
              "
              v-tip="
                selected.entryLocked ? t('teacher.live.entryUnlock') : t('teacher.live.entryLock')
              "
              @click="toggleEntryLock()"
            >
              <Lock v-if="selected.entryLocked" class="size-4" aria-hidden="true" />
              <LockOpen v-else class="size-4" aria-hidden="true" />
            </AppButton>
            <AppButton variant="secondary" :disabled="exporting" @click="exportCsv">
              <Download class="size-3.5" aria-hidden="true" />
              {{ t('teacher.live.exportCsv') }}
            </AppButton>

            <span
              class="ms-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
              :class="
                channel.connected.value
                  ? 'bg-success-container text-on-success-container'
                  : 'bg-warning-container text-on-warning-container'
              "
            >
              <span
                class="size-1.5 rounded-full"
                :class="channel.connected.value ? 'bg-success' : 'bg-warning'"
              />
              {{ channel.connected.value ? t('teacher.live.connected') : t('teacher.live.pollingShort') }}
              <span class="sr-only">
                {{ channel.connected.value ? t('teacher.live.live') : t('teacher.live.polling') }}
              </span>
            </span>
          </div>
        </AppCard>

        <!-- The board: the numbers a teacher watches while the room works. -->
        <AppCard as="section">
          <h4 class="flex items-center gap-2 text-sm font-semibold text-on-surface">
            <Users class="size-4" aria-hidden="true" />
            {{ t('teacher.live.boardTitle') }}
          </h4>

          <div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div class="rounded-xl border border-outline-variant bg-surface-container-high px-3 py-2.5">
              <span
                class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant"
              >
                <Users class="size-3.5" aria-hidden="true" />
                {{ t('teacher.live.stats.joined') }}
              </span>
              <p class="mt-1 text-2xl font-semibold tabular-nums text-on-surface">{{ joinedCount }}</p>
            </div>
            <div class="rounded-xl border border-outline-variant bg-surface-container-high px-3 py-2.5">
              <span
                class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant"
              >
                <UserCheck class="size-3.5" aria-hidden="true" />
                {{ t('teacher.live.stats.submitted') }}
              </span>
              <p class="mt-1 text-2xl font-semibold tabular-nums text-primary">{{ submittedCount }}</p>
            </div>
            <div class="rounded-xl border border-outline-variant bg-surface-container-high px-3 py-2.5">
              <span
                class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant"
              >
                <Trophy class="size-3.5" aria-hidden="true" />
                {{ t('teacher.live.stats.passed') }}
              </span>
              <p class="mt-1 text-2xl font-semibold tabular-nums text-success">{{ passedCount }}</p>
            </div>
            <div class="rounded-xl border border-outline-variant bg-surface-container-high px-3 py-2.5">
              <span
                class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant"
              >
                <CircleX class="size-3.5" aria-hidden="true" />
                {{ t('teacher.live.stats.failed') }}
              </span>
              <p class="mt-1 text-2xl font-semibold tabular-nums text-error">{{ failedCount }}</p>
            </div>
          </div>

          <div class="mt-4">
            <div class="flex items-center justify-between text-xs">
              <span class="font-semibold text-on-surface">
                {{ t('teacher.live.board', { done: submittedCount, joined: joinedCount }) }}
              </span>
              <span class="tabular-nums text-on-surface-variant">{{ progressPercent }}%</span>
            </div>
            <div
              class="mt-2 h-2.5 overflow-hidden rounded-full bg-surface-container-highest"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="progressPercent"
              :aria-label="t('teacher.live.board', { done: submittedCount, joined: joinedCount })"
            >
              <!-- scaleX, not width: the fill grows on the compositor and the bar
                   never re-flows the page while twenty answers arrive. -->
              <div
                class="h-full w-full origin-left rounded-full bg-primary transition-transform [transition-duration:var(--motion-medium)] [transition-timing-function:var(--ease-emphasized)]"
                :style="{ transform: `scaleX(${progressPercent / 100})` }"
              />
            </div>
          </div>

          <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-on-surface-variant">
            <span v-if="averagePercent !== null" class="inline-flex items-center gap-1.5">
              <Percent class="size-3.5" aria-hidden="true" />
              {{ t('teacher.live.average') }}
              <span class="font-semibold tabular-nums text-on-surface">{{ averagePercent }}%</span>
            </span>
            <span v-if="joinedCount > 0" class="inline-flex items-center gap-1.5">
              <Hourglass v-if="workingCount > 0" class="size-3.5" aria-hidden="true" />
              <CircleCheck v-else class="size-3.5 text-success" aria-hidden="true" />
              {{
                workingCount > 0
                  ? t('teacher.live.waiting', { count: workingCount })
                  : t('teacher.live.allSubmitted')
              }}
            </span>
          </div>
        </AppCard>

        <AppCard as="section">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h4 class="flex items-center gap-2 text-sm font-semibold text-on-surface">
              <Users class="size-4" aria-hidden="true" />
              {{ t('teacher.live.participants') }}
            </h4>
            <span
              v-if="joinedCount > 0"
              class="rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-semibold tabular-nums text-on-surface-variant"
            >
              {{ joinedCount }}
            </span>
          </div>

          <p
            v-if="participants.length === 0"
            class="mt-3 flex items-center gap-1.5 text-xs text-on-surface-variant"
          >
            <Users class="size-3.5" aria-hidden="true" />
            {{ t('teacher.live.noParticipants') }}
          </p>

          <ul v-else class="mt-3 space-y-1.5">
            <li
              v-for="entry in sortedParticipants"
              :key="entry.userId"
              class="flex items-center gap-3 rounded-xl border border-outline-variant bg-surface-container-high px-3 py-2"
            >
              <span
                class="grid size-9 shrink-0 place-items-center rounded-full text-xs font-semibold"
                :class="avatarClass(entry)"
                aria-hidden="true"
              >
                {{ monogram(entry) }}
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm text-on-surface">
                  {{ entry.fullName || entry.username }}
                </span>
                <span
                  v-if="entry.status !== 'joined'"
                  class="block text-[11px] text-on-surface-variant"
                >
                  {{ t('teacher.live.submittedAt', { time: formatTime(entry.submittedAt) }) }}
                </span>
              </span>

              <span
                v-if="entry.status === 'joined'"
                class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold transition-colors duration-200"
                :class="liveTone(entry)"
              >
                <Hourglass class="size-3" aria-hidden="true" />
                {{ liveState(entry) }}
              </span>
              <span v-else class="flex shrink-0 items-center gap-2">
                <span class="text-sm font-semibold tabular-nums text-on-surface">
                  <template v-if="entry.percent === null">—</template>
                  <template v-else>{{ entry.percent }}%</template>
                </span>
                <!-- A test without a pass mark has a score and no verdict. -->
                <span
                  v-if="entry.passed !== null"
                  class="rounded-full px-1.5 py-0.5 text-[11px] font-semibold"
                  :class="
                    entry.passed
                      ? 'bg-success-container text-on-success-container'
                      : 'bg-error-container text-on-error-container'
                  "
                >
                  {{ entry.passed ? t('teacher.live.passed') : t('teacher.live.failed') }}
                </span>
              </span>
            </li>
          </ul>
        </AppCard>
      </template>
        </div>
      </div>
    </template>

    <AppDialog
      v-if="showStart"
      :label="t('teacher.live.startTitle')"
      max-width="max-w-lg"
      @close="closeStart"
    >
      <div ref="panel" class="flex max-h-[92dvh] flex-col">
        <header class="flex items-start justify-between gap-3 border-b border-outline-variant p-4">
          <div class="min-w-0">
            <h3 class="text-base font-semibold text-on-surface">
              {{ t('teacher.live.startTitle') }}
            </h3>
            <p class="mt-0.5 text-sm text-on-surface-variant">{{ t('teacher.live.startHint') }}</p>
          </div>
          <AppButton
            variant="ghost"
            class="shrink-0"
            :aria-label="t('common.close')"
            @click="closeStart"
          >
            <X class="size-4" aria-hidden="true" />
          </AppButton>
        </header>

        <div class="flex-1 space-y-4 overflow-y-auto p-4">
          <TestPicker
            :tests="props.tests"
            :busy="starting"
            @select="chooseTestForStart"
          />

          <!-- Three optionals, all of which make the archive usable later: what
               the run was called, which group sat it, what it covered. -->
          <label class="block">
            <span class="text-xs font-semibold text-on-surface-variant">
              {{ t('teacher.live.runName') }}
            </span>
            <AppInput
              v-model="sessionNameDraft"
              class="mt-1"
              :placeholder="t('teacher.live.runNamePlaceholder')"
              maxlength="120"
            />
          </label>

          <div>
            <p class="text-xs font-semibold text-on-surface-variant">
              {{ t('teacher.live.runRoom') }}
            </p>
            <p class="mt-0.5 text-[11px] text-on-surface-variant">
              {{ t('teacher.live.runRoomHint') }}
            </p>
            <ul v-if="rooms.rooms.length" class="mt-2 flex flex-wrap gap-1.5">
              <li>
                <AppButton
                  variant="secondaryPlain"
                  size="sm"
                  :aria-pressed="sessionRoomId === null"
                  :class="sessionRoomId === null ? 'bg-secondary-container text-on-secondary-container' : ''"
                  @click="sessionRoomId = null"
                >
                  {{ t('teacher.tests.roomNone') }}
                </AppButton>
              </li>
              <li v-for="room in rooms.rooms" :key="room.id">
                <AppButton
                  variant="secondaryPlain"
                  size="sm"
                  :aria-pressed="sessionRoomId === room.id"
                  :class="sessionRoomId === room.id ? 'bg-secondary-container text-on-secondary-container' : ''"
                  @click="sessionRoomId = room.id"
                >
                  {{ room.name }}
                </AppButton>
              </li>
            </ul>
            <p v-else class="mt-2 text-[11px] text-on-surface-variant">
              {{ t('teacher.tests.roomNoneHint') }}
            </p>
          </div>

          <TagInput v-model="sessionTags" :label="t('teacher.tags.label')" />
        </div>

        <footer class="flex justify-end gap-2 border-t border-outline-variant p-4">
          <AppButton variant="secondary" ref="cancelRef" @click="closeStart">
            {{ t('common.cancel') }}
          </AppButton>
          <AppButton
            variant="primary"
            :disabled="!startingTestId || starting"
            @click="start(startingTestId)"
          >
            <Play class="size-3.5" aria-hidden="true" />
            {{ starting ? t('common.loading') : t('teacher.live.startRun') }}
          </AppButton>
        </footer>
      </div>
    </AppDialog>

    <SessionLibraryDialog
      v-if="showLibrary"
      :tests="props.tests"
      :selected-id="selectedId"
      @select="selectedId = $event"
      @close="showLibrary = false"
    />
  </div>
</template>
