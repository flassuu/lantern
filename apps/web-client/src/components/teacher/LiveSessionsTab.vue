<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
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
  Printer,
  QrCode,
  Radio,
  Square,
  TriangleAlert,
  Trophy,
  UserCheck,
  Users,
  X,
} from '@lucide/vue'
import { ApiError } from '../../api/client'
import {
  beginSession,
  listSessions,
  releaseSessionResults,
  extendSession,
  sessionResultsBlob,
  setEntryLocked,
  setSessionSettings,
  setSessionStatus,
  startSession,
  type LiveSessionStatus,
  type ParticipantEntry,
  type SessionSummary,
  type SessionWritten,
} from '../../api/sessions'
import type { TestSummary } from '../../api/types'
import EmptyState from '../common/EmptyState.vue'
import QrCodeCard from '../common/QrCode.vue'
import SkeletonList from '../common/SkeletonList.vue'
import TestPicker from './TestPicker.vue'
import TagInput from './TagInput.vue'
import RunTimer from './RunTimer.vue'
import SessionTabs from './SessionTabs.vue'
import ParticipantDetailDialog from './ParticipantDetailDialog.vue'
import SessionLibraryDialog from './SessionLibraryDialog.vue'
import SessionSettingsFields from './SessionSettingsFields.vue'
import { useConfirm } from '../../composables/confirm'
import { useDialogFocus } from '../../composables/focusTrap'
import { effectiveBaseUrl, loadSettings } from '../../composables/settings'
import { isReachableFromPhone, joinLink as buildJoinLink } from '../../utils/links'
import { useSessionChannel } from '../../composables/sessionChannel'
import { saveExport } from '../../composables/exporter'
import { getRoomsState, loadRooms } from '../../composables/rooms'
import { normalizeSettings } from '../../api/normalize'
import type { TestSettings } from '../../api/types'
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
/**
 * What a run is called on screen: the teacher's own name, or the paper's with
 * the day the run started, so two unnamed runs of one test read apart. A run
 * that has not started has no day to stamp yet.
 */
function sessionName(session: SessionSummary): string {
  if (session.name) return session.name
  if (!session.startedAt) return session.title
  const mark = new Intl.DateTimeFormat(locale.value, { month: 'long', day: 'numeric' }).format(
    new Date(session.startedAt),
  )
  return `${session.title} ${mark}`
}
const selectedName = computed(() => (selected.value ? sessionName(selected.value) : ''))
/** "10q · 11m", the short facts the pill beside the paper keeps. */
const selectedTestMeta = computed(() => {
  const test = selectedTest.value
  if (test === null) return ''
  const parts = [t('teacher.live.questionShort', { count: test.questionCount })]
  if (selected.value?.timeLimitSec) {
    parts.push(
      t('teacher.live.minuteShort', { count: Math.round(selected.value.timeLimitSec / 60) }),
    )
  }
  return parts.join(' · ')
})
const rooms = getRoomsState()
const roomNameOf = (id: string | null): string =>
  rooms.rooms.find((room) => room.id === id)?.name ?? ''

/** What the start dialog collects beyond the test: a name, a room, labels. */
const sessionNameDraft = ref('')
const sessionRoomId = ref<string | null>(null)
const sessionTags = ref<string[]>([])
/** What the run will be like; prefilled from the test, overridable here. */
const sessionSettings = ref<TestSettings>(normalizeSettings(null))
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

/** Which student's run is open, or null when none is. The dialog fetches it. */
const detailUserId = ref<string | null>(null)

function openDetail(userId: string): void {
  detailUserId.value = userId
}

function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return t('teacher.errors.generic')
  if (error.code === 'NETWORK') return t('teacher.errors.network')
  if (error.code === 'VALIDATION' || error.code === 'INVALID_OPERATION') return t('teacher.errors.validation')
  if (error.code === 'CONFLICT') return t('teacher.errors.conflict')
  if (error.code === 'NOT_FOUND') return t('teacher.errors.notFound')
  return t('teacher.errors.generic')
}

/**
 * A run thrown away in the library is gone from the open tabs as well: the list
 * is refetched, which also moves the selection off the run that no longer is.
 */
function onLibraryDeleted(): void {
  void load()
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
  sessionSettings.value = normalizeSettings(null)
  showStart.value = true
}

/** Picking a test pre-fills the room that test belongs to, if any. */
function chooseTestForStart(testId: string): void {
  startingTestId.value = testId
  const test = props.tests.find((entry) => entry.id === testId)
  if (test) {
    sessionRoomId.value = test.roomId ?? null
    // The run starts from the test's defaults; the teacher can still change them
    // here, which is the whole point of the step.
    sessionSettings.value = test.settings
  }
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
      settings: sessionSettings.value,
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
function applySession(updated: SessionWritten): void {
  sessions.value = sessions.value.map((session) => {
    if (session.id !== updated.id) return session
    // A server that does not send tags answers with an empty set, not with an
    // absent field - and an action never clears a run's labels (there is no
    // untag press), so an empty set can only mean "not sent". Keeping the ones
    // the list showed is what keeps the labels through pause, extend or lock.
    const tags = updated.tags.length > 0 ? updated.tags : session.tags
    return { ...session, ...updated, tags }
  })
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

/** A run with a clock, and not one already over, is the one time can be added to. */
const canExtend = computed(
  () => boardStatus.value !== 'finished' && selected.value?.timeLimitSec != null,
)

/** The lobby's own copy of the settings; saving is optimistic on the response. */
const lobbySettings = computed({
  get: () => selected.value?.settings ?? normalizeSettings(null),
  set: (value: TestSettings) => {
    const session = selected.value
    if (!session) return
    void (async () => {
      actionError.value = ''
      try {
        applySession(await setSessionSettings(session.id, value))
      } catch (error) {
        actionError.value = errorMessage(error)
      }
    })()
  },
})

/** Gives the run more time; only a run with a clock has one to give. */
async function extend(seconds: number): Promise<void> {
  const session = selected.value
  if (!session) return
  actionError.value = ''
  try {
    applySession(await extendSession(session.id, seconds))
  } catch (error) {
    actionError.value = errorMessage(error)
  }
}

/** Lets held results out; from then on submitting students see their score. */
async function release(): Promise<void> {
  const session = selected.value
  if (!session) return
  actionError.value = ''
  try {
    applySession(await releaseSessionResults(session.id))
  } catch (error) {
    actionError.value = errorMessage(error)
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

/** The browser's own print dialog: the fonts are on the machine, unlike the
 *  PDF writer this screen used to have, which knew only Helvetica. */
function printResults(): void {
  window.print()
}

async function exportResults(): Promise<void> {
  const session = selected.value
  if (!session || exporting.value) return
  exporting.value = true
  try {
    // Where and in what format are the save dialog's business; the server just
    // writes the one the extension asked for.
    await saveExport(`session-${session.joinCode}`, (format) =>
      sessionResultsBlob(session.id, format),
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
        which one they were looking at. The wrapper draws nothing itself: it is
        here so the page rhythm does not push the tabs off the board.
      -->
      <div>
        <SessionTabs
          :sessions="sessions"
          :selected-id="selectedId"
          @select="selectedId = $event"
          @library="showLibrary = true"
        />

        <!-- No top gap: the board card is flush under the tabs, so an open tab's
             fill runs into it instead of stopping above a strip of background. -->
        <div class="space-y-3">
          <p
            v-if="actionError"
            role="alert"
            class="mt-3 rounded-xl bg-error-container px-3 py-2 text-sm text-on-error-container"
          >
            {{ actionError }}
          </p>


      <template v-if="selected">
        <!--
          The board is four blocks: what the run is, the clock that governs it,
          how students get in, and what the teacher can do about it. An open tab
          covers this card's top edge under itself, so the tab and the panel read
          as one; the card squares that corner off when the tab opens on it.
        -->
        <AppCard
          as="section"
          :class="sessions[0]?.id === selectedId ? 'rounded-tl-none' : ''"
        >
          <!-- What the run is, and the clock that governs it: two blocks side
               by side, because a teacher reads the name and looks at the clock
               in the same breath. -->
          <div class="flex flex-col gap-3 sm:flex-row sm:items-stretch">
            <div class="min-w-0 flex-1 rounded-2xl bg-surface-container-high p-3 sm:p-4" data-run-data>
              <!-- The panel's order is fixed: the run's name, the paper it ran
                   with its counts, the marks of its life, the labels on it.
                   Every line is here even where its fact is not - a run on the
                   field reads "--:--" for a mark not made yet. -->
              <div class="space-y-1.5">
                <div class="flex min-w-0 items-center justify-between gap-2">
                  <span class="min-w-0 truncate text-lg font-semibold text-on-surface">
                    {{ selectedName }}
                  </span>
                  <!-- The state sits where an eye lands last: out of the read
                       line, pressed to the panel's own edge on the right. -->
                  <span
                    class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
                    :class="statusChip[boardStatus]"
                  >
                    <span class="size-1.5 rounded-full" :class="statusDot[boardStatus]" />
                    {{ t(`teacher.live.status.${boardStatus}`) }}
                  </span>
                </div>

                <!-- The paper is always named, with its counts beside it in the
                     same pill the test's own summary keeps. -->
                <div class="flex min-w-0 items-center gap-2">
                  <span class="min-w-0 truncate text-sm text-on-surface">{{ selected.title }}</span>
                  <span
                    v-if="selectedTestMeta"
                    class="shrink-0 rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-semibold text-on-surface-variant"
                  >
                    {{ selectedTestMeta }}
                  </span>
                </div>

                <p class="text-sm tabular-nums text-on-surface">
                  {{ formatTime(selected.startedAt) || t('teacher.live.noTime') }}
                  /
                  {{
                    selected.finishedAt
                      ? formatTime(selected.finishedAt)
                      : t('teacher.live.noTime')
                  }}
                </p>

                <div
                  v-if="roomNameOf(selected.roomId) || selected.tags.length > 0"
                  class="flex flex-wrap items-center gap-1.5"
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
              </div>
            </div>

            <!-- The clock and its two nudges. A lobby has no clock to show. -->
            <div
              v-if="boardStatus !== 'lobby'"
              class="flex shrink-0 flex-col gap-2 rounded-2xl bg-surface-container-high p-3 sm:min-w-48 sm:p-4"
            >
              <!-- The clock keeps its own second, so a run ticking does not
                   re-render the rest of the board. -->
              <RunTimer
                data-run-clock
                :started-at="selected.startedAt"
                :finished-at="selected.finishedAt"
                :time-limit-sec="selected.timeLimitSec"
                :status="boardStatus"
                :paused-at="selected.pausedAt"
              />
              <!-- One control with two equal presses: the grid cuts it in half,
                   and the 10px gap reads as a pause, not as two actions. A
                   closed run keeps the pair, greyed: the shape of the board does
                   not jump when the run ends. -->
              <div
                data-run-extend
                class="mt-auto grid grid-cols-2 gap-[5px] overflow-hidden rounded-[var(--radius-control)] transition-opacity duration-200"
                :class="canExtend ? '' : 'opacity-40'"
              >
                <button
                  type="button"
                  class="state-layer grid min-h-11 place-items-center bg-primary text-sm font-semibold text-on-primary disabled:pointer-events-none"
                  :disabled="!canExtend"
                  :title="t('teacher.live.addTimeTitle')"
                  @click="extend(15)"
                >
                  {{ t('teacher.live.addTime', { seconds: 15 }) }}
                </button>
                <button
                  type="button"
                  class="state-layer grid min-h-11 place-items-center bg-primary text-sm font-semibold text-on-primary disabled:pointer-events-none"
                  :disabled="!canExtend"
                  :title="t('teacher.live.addTimeTitle')"
                  @click="extend(60)"
                >
                  {{ t('teacher.live.addMinute') }}
                </button>
              </div>
            </div>
          </div>

          <div class="mt-4 rounded-2xl bg-surface-container-high p-3 sm:p-4">
            <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div class="min-w-0">
                <p class="text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant">
                  {{ t('teacher.live.codeLabel') }}
                </p>
                <!-- The code and the control that copies it, side by side: the
                     button is about the code, so it stands where the code is.
                     It carries an icon and says its word on hover, because the
                     code is the loud thing here and a labelled button next to it
                     was the loudest thing on the screen. -->
                <div class="flex items-center gap-1">
                  <p
                    class="font-mono text-3xl font-bold tracking-[0.2em] text-on-surface sm:text-4xl"
                  >
                    {{ selected.joinCode }}
                  </p>
                  <span class="group relative">
                    <AppButton
                      variant="ghost"
                      icon
                      :aria-label="t('teacher.live.copy')"
                      @click="copyCode"
                    >
                      <CircleCheck v-if="copied" class="size-4" aria-hidden="true" />
                      <Copy v-else class="size-4" aria-hidden="true" />
                    </AppButton>
                    <span
                      class="pointer-events-none absolute left-1/2 top-full z-10 mt-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-on-surface px-2 py-1 text-[11px] font-semibold text-surface opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      {{ copied ? t('teacher.live.copied') : t('teacher.live.copy') }}
                    </span>
                  </span>
                </div>
              </div>
              <!-- The two ways in that are not the code: how a phone that cannot
                   see the code the way a phone on the wall does gets in. -->
              <!-- The same pair as Print and Export: one control cut in two, a
                   5px gap of empty panel, square where the halves meet. -->
              <div class="grid grid-cols-2 gap-[5px]">
                <button
                  type="button"
                  class="state-layer flex min-h-11 items-center justify-center gap-1.5 rounded-l-[var(--radius-control)] border border-outline bg-surface px-3 text-sm font-semibold text-on-surface"
                  @click="copyLink"
                >
                  <CircleCheck v-if="linkCopied" class="size-4" aria-hidden="true" />
                  <Link2 v-else class="size-4" aria-hidden="true" />
                  {{ linkCopied ? t('teacher.live.copied') : t('teacher.live.copyLink') }}
                </button>
                <button
                  type="button"
                  class="state-layer flex min-h-11 items-center justify-center gap-1.5 rounded-r-[var(--radius-control)] border border-outline bg-surface px-3 text-sm font-semibold text-on-surface"
                  :aria-pressed="showQr"
                  @click="showQr = !showQr"
                >
                  <QrCode class="size-4" aria-hidden="true" />
                  {{ showQr ? t('teacher.live.hideQr') : t('teacher.live.showQr') }}
                </button>
              </div>
            </div>

            <!-- The link is said here and nowhere else: under the code it was a
                 line of small grey type nobody read, and the students who need it
                 are the ones already looking at the QR. -->
            <div
              v-if="showQr"
              class="mt-3 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-4"
            >
              <QrCodeCard :text="joinLink()" :caption="t('teacher.live.qrCaption')" />
              <div class="min-w-0 flex-1 space-y-2">
                <div class="rounded-xl border border-outline-variant bg-surface p-3">
                  <p class="text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant">
                    {{ t('teacher.live.linkLabel') }}
                  </p>
                  <p class="mt-1.5 break-all font-mono text-sm text-on-surface">{{ joinLink() }}</p>
                </div>
                <p class="text-[11px] text-on-surface-variant">
                  {{ t('teacher.live.qrAddress') }}:
                  <span class="font-mono">{{ joinOrigin }}</span>
                </p>
              </div>
            </div>

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

          <!-- The lobby is the only place the rules can still change: the paper
               is handed out at the start. -->
          <div
            v-if="boardStatus === 'lobby'"
            class="mt-3 rounded-2xl bg-surface-container-high p-3"
          >
            <p class="text-xs font-semibold text-on-surface-variant">
              {{ t('teacher.sessionSettings.title') }}
            </p>
            <p class="mt-0.5 text-[11px] text-on-surface-variant">
              {{ t('teacher.sessionSettings.lobbyOnly') }}
            </p>
            <div class="mt-3">
              <SessionSettingsFields v-model="lobbySettings" />
            </div>
          </div>

          <div class="mt-3 rounded-2xl bg-surface-container-high p-3 sm:p-4">
            <div class="flex flex-wrap items-center gap-2">
              <!-- A closed run has no run controls left; the row says so rather
                   than standing empty, and points at the results on its right. -->
              <p
                v-if="boardStatus === 'finished'"
                class="flex items-center gap-1.5 text-sm text-on-surface-variant"
              >
                <CircleCheck class="size-4" aria-hidden="true" />
                {{ t('teacher.live.finishedHint') }}
              </p>
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
              <!-- The row's actions come in the same shape the results pair and
                   the join pair are cut in: 44px of control, a 14px semibold
                   label, a state layer, and the press handed to the compositor. -->
              <button
                v-if="boardStatus === 'active'"
                type="button"
                class="state-layer flex min-h-11 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-outline bg-surface px-3.5 text-sm font-semibold text-on-surface"
                @click="changeStatus('paused')"
              >
                <Pause class="size-4" aria-hidden="true" />
                {{ t('teacher.live.pause') }}
              </button>
              <button
                v-else-if="boardStatus === 'paused'"
                type="button"
                class="state-layer flex min-h-11 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-outline bg-surface px-3.5 text-sm font-semibold text-on-surface"
                @click="changeStatus('active')"
              >
                <Play class="size-4" aria-hidden="true" />
                {{ t('teacher.live.resume') }}
              </button>
              <button
                v-if="boardStatus !== 'finished'"
                type="button"
                class="state-layer flex min-h-11 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-outline bg-surface px-3.5 text-sm font-semibold text-error"
                @click="changeStatus('finished')"
              >
                <Square class="size-4" aria-hidden="true" />
                {{ t('teacher.live.finish') }}
              </button>
              <button
                v-if="boardStatus !== 'finished'"
                type="button"
                class="state-layer grid size-11 place-items-center rounded-[var(--radius-control)] border border-outline bg-surface text-on-surface-variant"
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
              </button>
              <!-- Printing reads what is on the screen, so it works while the room
                   is still working. The export writes finished results, so it waits
                   for the run to be over; the hint lives on the wrapper, because a
                   disabled button ignores the pointer and its own tooltip never
                   appears. The buttons carry the height and the letterform of the
                   nudge pair on the clock, with the fills they already had. -->
              <div class="ms-auto flex items-center gap-2">
                <span class="text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant">
                  {{ t('teacher.live.resultsLabel') }}
                </span>
                <!-- Results held back: one press lets them out, and the pair takes
                     its place, so the right end is never idle. -->
                <button
                  type="button"
                  class="state-layer flex min-h-11 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-outline bg-surface px-3.5 text-sm font-semibold text-on-surface"
                  v-if="selected.settings.releaseResults === 'teacher' && !selected.resultsReleased"
                  @click="release()"
                >
                  <Trophy class="size-4" aria-hidden="true" />
                  {{ t('teacher.sessionSettings.releaseAction') }}
                </button>
                <!-- The pair is one control, cut in half by the grid: the gap
                     between the halves is empty panel, and only the outward
                     corners round - the sides the two buttons share stay square. -->
                <div v-else class="grid grid-cols-2 gap-[5px]">
                  <button
                    type="button"
                    class="state-layer flex min-h-11 items-center justify-center gap-1.5 rounded-l-[var(--radius-control)] border border-outline bg-surface px-3 text-sm font-semibold text-on-surface"
                    @click="printResults"
                  >
                    <Printer class="size-4" aria-hidden="true" />
                    {{ t('teacher.live.print') }}
                  </button>
                  <span
                    :title="boardStatus === 'finished' ? '' : t('teacher.live.exportNeedsFinished')"
                  >
                    <button
                      type="button"
                      class="state-layer flex min-h-11 w-full items-center justify-center gap-1.5 rounded-r-[var(--radius-control)] border border-outline bg-surface px-3 text-sm font-semibold text-on-surface disabled:pointer-events-none disabled:opacity-60"
                      :disabled="exporting || boardStatus !== 'finished'"
                      @click="exportResults"
                    >
                      <Download class="size-4" aria-hidden="true" />
                      {{ t('teacher.live.export') }}
                    </button>
                  </span>
                </div>
              </div>
            </div>
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
            <li v-for="entry in sortedParticipants" :key="entry.userId">
              <button
                type="button"
                class="flex w-full items-center gap-3 rounded-xl border border-outline-variant bg-surface-container-high px-3 py-2 text-left transition-colors duration-200 hover:bg-surface-container-highest"
                :aria-label="t('teacher.participantDetail.open')"
                @click="openDetail(entry.userId)"
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
              </button>
            </li>
          </ul>
        </AppCard>
      </template>
        </div>
      </div>
    </template>

    <ParticipantDetailDialog
      v-if="detailUserId !== null && selected !== null"
      :session-id="selected.id"
      :user-id="detailUserId"
      @close="detailUserId = null"
    />

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
          <!-- The chips under each test are what a run of it would do; picking
               one loads those rules into the fields below, and what is sent is an
               override for this run only. -->
          <TestPicker
            :tests="props.tests"
            :busy="starting"
            show-settings
            :room-name-of="roomNameOf"
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

          <div class="rounded-xl border border-outline-variant bg-surface p-3">
            <p class="text-xs font-semibold text-on-surface-variant">
              {{ t('teacher.sessionSettings.title') }}
            </p>
            <p class="mt-0.5 text-[11px] text-on-surface-variant">
              {{ t('teacher.sessionSettings.forThisRun') }}
            </p>
            <div class="mt-3">
              <SessionSettingsFields v-model="sessionSettings" />
            </div>
          </div>
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
      @deleted="onLibraryDeleted"
    />
  </div>
</template>
