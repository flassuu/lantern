<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Ban,
  BookOpen,
  CircleCheck,
  Copy,
  Grid3x3,
  KeyRound,
  Pencil,
  Plus,
  QrCode,
  RefreshCw,
  Trash2,
  Users,
  X,
} from '@lucide/vue'
import { ApiError } from '../../api/client'
import {
  createRoom,
  deleteRoom,
  getRoom,
  listRooms,
  regenerateRoomKey,
  revokeRoom,
  updateRoom,
} from '../../api/rooms'
import { listCourses } from '../../api/courses'
import { updateSettings } from '../../api/settings'
import { listPendingStudents, setUserStatus } from '../../api/users'
import type { CourseSummary, PublicUser, Room, RoomMember } from '../../api/types'
import EmptyState from '../common/EmptyState.vue'
import QrCodeCard from '../common/QrCode.vue'
import SkeletonList from '../common/SkeletonList.vue'
import AppButton from '../../components/common/AppButton.vue'
import AppCard from '../../components/common/AppCard.vue'
import AppDialog from '../../components/common/AppDialog.vue'
import AppInput from '../../components/common/AppInput.vue'
import { useConfirm } from '../../composables/confirm'
import { useDialogFocus } from '../../composables/focusTrap'
import { applySettings, effectiveBaseUrl, loadSettings } from '../../composables/settings'
import { useToast } from '../../composables/toast'
import { isReachableFromPhone, registrationLink } from '../../utils/links'

/**
 * The teacher's own rooms.
 *
 * A room is a key: something a student can type or scan to get an approved
 * account without an admin in the room. Everything on this tab serves that one
 * moment — the key is shown big enough to read from a desk, offered as a QR for
 * the whole room to scan, and replaceable when it has been photographed and left
 * on a wall. A room also names the courses its students are enrolled in, which
 * is what ties "who is here" to "what they are studying" without an admin in
 * the room. Nothing here grants a teacher anything over anybody else.
 */
const { t } = useI18n()
const toast = useToast()
const confirm = useConfirm()

const rooms = ref<Room[]>([])
/** Students stuck at `pending` because they registered with no room key. */
const pending = ref<PublicUser[]>([])
const courses = ref<CourseSummary[]>([])
const loading = ref(true)
const errorKey = ref('')

const members = ref<Record<string, RoomMember[]>>({})
const openDetails = ref<string | null>(null)

// The journal is a tab of its own; a room asking for it hands over to the
// dashboard, which switches tabs with this in hand.
const emit = defineEmits<{ journal: [roomId: string] }>()
const showQr = ref<string | null>(null)
const copiedKey = ref<string | null>(null)
const renaming = ref<string | null>(null)
const renameDraft = ref('')

/** The address a student's phone will be told to open for registration. */
const baseUrl = ref(effectiveBaseUrl())
const baseReachable = computed(() => isReachableFromPhone(baseUrl.value))

/** Creating a room is a dialog: a name, any number of courses, nothing else. */
const showEditor = ref(false)
const editingRoomId = ref<string | null>(null)
const editorName = ref('')
const editorCourseIds = ref<string[]>([])
const editorPanel = ref<HTMLElement | null>(null)
const editorCancel = ref<HTMLButtonElement | null>(null)
useDialogFocus(() => showEditor.value, () => closeEditor(), editorPanel, editorCancel)

const editorTitle = computed(() =>
  editingRoomId.value === null ? t('teacher.rooms.create') : t('teacher.rooms.editTitle'),
)

async function load(): Promise<void> {
  loading.value = true
  errorKey.value = ''
  try {
    const [roomList, courseList] = await Promise.all([listRooms(), listCourses()])
    rooms.value = roomList
    courses.value = courseList
    // A failure here must not empty the tab: the rooms themselves loaded, and
    // a student waiting for approval is an inconvenience, not an outage.
    try {
      pending.value = await listPendingStudents()
    } catch {
      pending.value = []
    }
  } catch (error) {
    errorKey.value = loadErrorKey(error)
  } finally {
    loading.value = false
  }
}

/**
 * What to tell the teacher about a failure, as a key under `teacher.errors`.
 *
 * A 404 on this tab is not a missing room: rooms arrived in a later build, so a
 * server that answers "not found" for the whole list is older than the app and no
 * retry will fix it. Saying "something went wrong" there sends the teacher
 * looking for a network problem they do not have.
 */
function loadErrorKey(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isNetwork) return 'network'
    if (error.status === 404) return 'serverTooOld'
    if (error.status === 400) return 'validation'
  }
  return 'generic'
}

function report(error: unknown): void {
  toast.error(t(`teacher.errors.${loadErrorKey(error)}`))
}

function openCreate(): void {
  editingRoomId.value = null
  editorName.value = ''
  editorCourseIds.value = []
  showEditor.value = true
}

function openEditor(room: Room): void {
  editingRoomId.value = room.id
  editorName.value = room.name
  editorCourseIds.value = [...room.courseIds]
  showEditor.value = true
}

function closeEditor(): void {
  showEditor.value = false
  editingRoomId.value = null
}

function toggleCourse(courseId: string): void {
  const current = editorCourseIds.value
  editorCourseIds.value = current.includes(courseId)
    ? current.filter((id) => id !== courseId)
    : [...current, courseId]
}

async function saveRoom(): Promise<void> {
  const name = editorName.value.trim()
  if (name === '') return
  try {
    if (editingRoomId.value === null) {
      await createRoom({ name, courseIds: editorCourseIds.value })
    } else {
      await updateRoom(editingRoomId.value, { name, courseIds: editorCourseIds.value })
    }
    closeEditor()
    await load()
  } catch (error) {
    report(error)
  }
}

function startRename(room: Room): void {
  renaming.value = room.id
  renameDraft.value = room.name
}

async function saveRename(room: Room): Promise<void> {
  const name = renameDraft.value.trim()
  if (name === '') return
  try {
    await updateRoom(room.id, { name })
    renaming.value = null
    await load()
  } catch (error) {
    report(error)
  }
}

async function toggleDetails(room: Room): Promise<void> {
  if (openDetails.value === room.id) {
    openDetails.value = null
    return
  }
  openDetails.value = room.id
  if (members.value[room.id]) return
  try {
    const detail = await getRoom(room.id)
    members.value[room.id] = detail.members
  } catch (error) {
    report(error)
  }
}

async function newKey(room: Room): Promise<void> {
  if (!(await confirm({ message: t('teacher.rooms.newKeyConfirm') }))) return
  try {
    const key = await regenerateRoomKey(room.id)
    await load()
    toast.success(t('teacher.rooms.newKeyDone', { key }))
  } catch (error) {
    report(error)
  }
}

const addressDraft = ref('')
const savingAddress = ref(false)
/** LAN addresses the server answers on, as one-tap chips. */
const suggestions = ref<string[]>([])

/**
 * The address that goes into the QR code.
 *
 * The admin sets this on the System tab, but a teacher running a lesson alone has
 * no admin to ask, and without it the code points at `localhost` — which scans
 * perfectly and then fails on every phone. So the teacher gets the same field
 * here, next to the rooms it matters for.
 */
async function saveAddress(): Promise<void> {
  const value = addressDraft.value.trim()
  savingAddress.value = true
  try {
    applySettings(await updateSettings(value === '' ? null : value))
    baseUrl.value = effectiveBaseUrl()
    toast.success(t('teacher.rooms.addressSaved'))
  } catch (error) {
    report(error)
  } finally {
    savingAddress.value = false
  }
}

/**
 * Approving is what the room key normally does. This path exists for the
 * student who typed no key: without it and without an admin they wait forever,
 * and the teacher has no way to unstick them.
 */
async function approve(student: PublicUser): Promise<void> {
  try {
    await setUserStatus(student.id, 'approved')
    pending.value = pending.value.filter((entry) => entry.id !== student.id)
    toast.success(t('teacher.rooms.waitingApprovedToast', { name: student.fullName }))
  } catch (error) {
    report(error)
  }
}

async function deny(student: PublicUser): Promise<void> {
  if (
    !(await confirm({ message: t('teacher.rooms.waitingDenyConfirm', { name: student.fullName }) }))
  )
    return
  try {
    await setUserStatus(student.id, 'blocked')
    pending.value = pending.value.filter((entry) => entry.id !== student.id)
    toast.success(t('teacher.rooms.waitingDeniedToast', { name: student.fullName }))
  } catch (error) {
    report(error)
  }
}

async function revoke(room: Room): Promise<void> {
  if (!(await confirm({ message: t('teacher.rooms.revokeConfirm', { name: room.name }) }))) return
  try {
    await revokeRoom(room.id)
    await load()
  } catch (error) {
    report(error)
  }
}

async function remove(room: Room): Promise<void> {
  if (!(await confirm({ message: t('teacher.rooms.deleteConfirm', { name: room.name }) }))) return
  try {
    await deleteRoom(room.id)
    await load()
  } catch (error) {
    report(error)
  }
}

/** Clipboard writes fail in some contexts; the key is on screen either way. */
async function copyKey(room: Room): Promise<void> {
  try {
    await navigator.clipboard.writeText(room.key)
    copiedKey.value = room.id
    window.setTimeout(() => {
      if (copiedKey.value === room.id) copiedKey.value = null
    }, 1500)
  } catch {
    toast.error(t('teacher.live.copyFailed'))
  }
}

function registrationQr(room: Room): string {
  return registrationLink(baseUrl.value, room.key)
}

function courseTitles(room: Room): Array<{ id: string; title: string }> {
  return room.courseIds.flatMap((id) => {
    const course = courses.value.find((entry) => entry.id === id)
    return course ? [{ id: course.id, title: course.title }] : []
  })
}

onMounted(() => {
  void load()
  void loadSettings().then((state) => {
    baseUrl.value = effectiveBaseUrl()
    addressDraft.value = state.settings?.publicBaseUrl ?? ''
    suggestions.value = state.settings?.suggestions ?? []
  })
})
</script>

<template>
  <section class="space-y-4">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h3 class="text-sm font-semibold text-on-surface">{{ t('teacher.rooms.title') }}</h3>
        <p class="mt-1 text-xs text-on-surface-variant">
          {{ t('teacher.rooms.hint') }}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <AppButton variant="secondary" size="sm" :aria-label="t('common.refresh')" @click="load">
          <RefreshCw class="size-4" aria-hidden="true" />
        </AppButton>
        <AppButton variant="primary" size="sm" @click="openCreate">
          <Plus class="size-3.5" aria-hidden="true" />
          {{ t('teacher.rooms.create') }}
        </AppButton>
      </div>
    </div>

    <!-- The address every QR code on this tab is built from -->
    <AppCard as="section">
      <h3 class="text-sm font-semibold text-on-surface">
        {{ t('teacher.rooms.addressTitle') }}
      </h3>
      <p class="mt-1 text-xs text-on-surface-variant">
        {{ t('teacher.rooms.addressHint') }}
      </p>
      <ul v-if="suggestions.length" class="mt-2 flex flex-wrap gap-1.5">
        <li v-for="suggestion in suggestions" :key="suggestion">
          <AppButton
            variant="secondaryPlain"
            size="sm"
            class="font-mono"
            :aria-pressed="addressDraft === suggestion"
            @click="addressDraft = suggestion"
          >
            {{ suggestion }}
          </AppButton>
        </li>
      </ul>
      <div class="mt-3 flex flex-wrap items-end gap-2">
        <AppInput
          id="public-address"
          v-model="addressDraft"
          class="min-w-48 flex-1"
          placeholder="http://192.168.1.65:3300"
          inputmode="url"
        />
        <AppButton :disabled="savingAddress" @click="saveAddress">
          {{ t('teacher.rooms.addressSave') }}
        </AppButton>
      </div>
    </AppCard>

    <!--
      Not a red line: a server that cannot answer this tab at all needs an
      instruction, not an apology. Anything smaller keeps the red line.
    -->
    <div
      v-if="errorKey === 'serverTooOld'"
      role="alert"
      class="rounded-xl border border-outline-variant bg-surface-container p-4"
    >
      <p class="text-sm font-semibold text-on-surface">
        {{ t('teacher.errors.serverTooOld') }}
      </p>
      <p class="mt-1 text-xs text-on-surface-variant">
        {{ t('teacher.errors.serverTooOldHint') }}
      </p>
    </div>

    <p
      v-else-if="errorKey"
      role="alert"
      class="rounded-lg bg-error-container px-3 py-2 text-sm text-on-error-container"
    >
      {{ t(`teacher.errors.${errorKey}`) }}
    </p>

    <SkeletonList v-else-if="loading" :rows="2" />

    <EmptyState
      v-else-if="rooms.length === 0"
      :icon="Users"
      :title="t('teacher.rooms.emptyTitle')"
      :description="t('teacher.rooms.emptyHint')"
      :action-label="t('teacher.rooms.create')"
      @action="openCreate"
    />

    <ul v-else class="space-y-3">
      <li v-for="room in rooms" :key="room.id">
        <AppCard as="article">
          <!-- Header: name (or inline rename) and status -->
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <div v-if="renaming === room.id" class="flex items-center gap-2">
                <AppInput
                  v-model="renameDraft"
                  class="flex-1"
                  :aria-label="t('teacher.rooms.rename')"
                  @keyup.enter="saveRename(room)"
                />
                <AppButton
                  variant="primary"
                  size="sm"
                  @click="saveRename(room)"
                >
                  {{ t('common.save') }}
                </AppButton>
                <AppButton
                  variant="ghost"
                  size="sm"
                  @click="renaming = null"
                >
                  {{ t('common.cancel') }}
                </AppButton>
              </div>
              <template v-else>
                <p class="truncate text-sm font-semibold text-on-surface">
                  {{ room.name }}
                </p>
                <div class="mt-1 flex flex-wrap items-center gap-1.5">
                  <span
                    class="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                    :class="
                      room.status === 'active'
                        ? 'bg-success-container text-on-success-container'
                        : 'bg-surface-container-high text-on-surface-variant'
                    "
                  >
                    {{ room.status === 'active' ? t('teacher.rooms.active') : t('teacher.rooms.revoked') }}
                  </span>
                  <span class="inline-flex items-center gap-1 text-[11px] text-on-surface-variant">
                    <Users class="size-3" aria-hidden="true" />
                    {{ room.membersCount }}
                  </span>
                </div>
              </template>
            </div>
            <AppButton
              variant="ghost"
              icon
              size="sm"
              class="shrink-0"
              :aria-label="t('teacher.rooms.courses')"
              v-tip="t('teacher.rooms.coursesHint')"
              @click="openEditor(room)"
            >
              <BookOpen class="size-4" aria-hidden="true" />
            </AppButton>
          </div>

          <!-- The courses this room studies: arriving through the key enrols
               somebody in all of them, now and later. -->
          <div v-if="courseTitles(room).length" class="mt-2 flex flex-wrap items-center gap-1.5">
            <span
              v-for="course in courseTitles(room)"
              :key="course.id"
              class="inline-flex items-center gap-1 rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-semibold text-on-surface-variant"
            >
              <BookOpen class="size-3" aria-hidden="true" />
              {{ course.title }}
            </span>
          </div>
          <p v-else class="mt-2 text-[11px] text-on-surface-variant">
            {{ t('teacher.rooms.noCourses') }}
          </p>

          <!-- The key itself: the one thing a student needs -->
          <div class="mt-3 flex items-center gap-2">
            <code
              class="flex h-12 flex-1 items-center justify-center rounded-[var(--radius-control)] bg-surface-container font-mono text-xl font-bold tracking-[0.3em] text-on-surface"
            >
              {{ room.key }}
            </code>
            <AppButton
              variant="secondaryMuted"
              size="md"
              :disabled="room.status === 'revoked'"
              :aria-label="t('teacher.rooms.copyKey')"
              @click="copyKey(room)"
            >
              <CircleCheck v-if="copiedKey === room.id" class="size-4" aria-hidden="true" />
              <Copy v-else class="size-4" aria-hidden="true" />
            </AppButton>
          </div>

          <!-- A QR that scans to the sign-up form with the key filled in -->
          <div v-if="showQr === room.id" class="mt-3">
            <QrCodeCard
              :text="registrationQr(room)"
              :caption="t('teacher.rooms.qrCaption')"
            />
            <p
              v-if="!baseReachable"
              class="mt-2 rounded-[var(--radius-control)] bg-warning-container px-3 py-2 text-xs text-on-warning-container"
            >
              {{ t('teacher.live.unreachableHint') }}
              <span class="break-all font-mono">{{ baseUrl }}</span>
            </p>
          </div>

          <!-- Actions: the two reading actions as words, the rare or destructive
               ones as icons with a tooltip, matching the Tests and Courses rows. -->
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <AppButton
              variant="secondary"
              size="sm"
              :disabled="room.status === 'revoked'"
              :aria-pressed="showQr === room.id"
              @click="showQr = showQr === room.id ? null : room.id"
            >
              <QrCode class="size-3.5" aria-hidden="true" />
              {{ showQr === room.id ? t('teacher.rooms.hideQr') : t('teacher.rooms.showQr') }}
            </AppButton>
            <AppButton
              variant="secondaryPlain"
              size="sm"
              :aria-expanded="openDetails === room.id"
              @click="toggleDetails(room)"
            >
              <Users class="size-3.5" aria-hidden="true" />
              {{ t('teacher.rooms.students') }}
            </AppButton>
            <AppButton variant="secondaryPlain" size="sm" @click="emit('journal', room.id)">
              <Grid3x3 class="size-3.5" aria-hidden="true" />
              {{ t('teacher.tabs.journal') }}
            </AppButton>
            <AppButton
              v-if="renaming !== room.id"
              variant="ghost"
              icon
              size="sm"
              :disabled="room.status === 'revoked'"
              :aria-label="t('teacher.rooms.rename')"
              v-tip="t('teacher.rooms.rename')"
              @click="startRename(room)"
            >
              <Pencil class="size-4" aria-hidden="true" />
            </AppButton>
            <AppButton
              v-if="room.status === 'active'"
              variant="ghost"
              icon
              size="sm"
              :aria-label="t('teacher.rooms.newKey')"
              v-tip="t('teacher.rooms.newKey')"
              @click="newKey(room)"
            >
              <KeyRound class="size-4" aria-hidden="true" />
            </AppButton>
            <AppButton
              v-if="room.status === 'active'"
              variant="ghost"
              icon
              size="sm"
              :disabled="room.membersCount > 0"
              :aria-label="t('teacher.rooms.revoke')"
              v-tip="
                room.membersCount > 0
                  ? t('teacher.rooms.revokeBlocked')
                  : t('teacher.rooms.revokeConfirm', { name: room.name })
              "
              @click="revoke(room)"
            >
              <Ban class="size-4" aria-hidden="true" />
            </AppButton>
            <AppButton
              variant="ghostDanger"
              icon
              size="sm"
              :aria-label="t('teacher.rooms.delete')"
              v-tip="t('teacher.rooms.delete')"
              @click="remove(room)"
            >
              <Trash2 class="size-4" aria-hidden="true" />
            </AppButton>
          </div>

          <!-- Members -->
          <div v-if="openDetails === room.id" class="mt-3 border-t border-outline-variant pt-3">
            <ul v-if="members[room.id]?.length" class="space-y-1.5">
              <li
                v-for="member in members[room.id]"
                :key="member.userId"
                class="flex items-center justify-between gap-3 rounded-xl bg-surface px-3 py-2 text-sm"
              >
                <span class="min-w-0 truncate text-on-surface">{{ member.fullName }}</span>
                <span class="shrink-0 text-xs text-on-surface-variant">{{ member.username }}</span>
              </li>
            </ul>
            <p v-else class="text-xs text-on-surface-variant">
              {{ t('teacher.rooms.noStudents') }}
            </p>
          </div>
        </AppCard>
      </li>
    </ul>

    <!-- Students who registered without a room key. Without this they sit at
         "awaiting approval" with nobody able to let them in, which is the whole
         reason the seed is a teacher now. -->
    <AppCard v-if="pending.length" as="section" class="mt-4">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="text-sm font-semibold text-on-surface">
            {{ t('teacher.rooms.waitingTitle') }}
          </h3>
          <p class="mt-1 text-xs text-on-surface-variant">
            {{ t('teacher.rooms.waitingHint') }}
          </p>
        </div>
        <span
          class="shrink-0 rounded-full bg-secondary-container px-2.5 py-1 text-xs font-medium text-on-secondary-container"
        >
          {{ pending.length }}
        </span>
      </div>

      <ul class="mt-3 space-y-2">
        <li
          v-for="student in pending"
          :key="student.id"
          class="flex items-center justify-between gap-3"
        >
          <div class="min-w-0">
            <p class="truncate text-sm text-on-surface">{{ student.fullName }}</p>
            <p class="truncate text-xs text-on-surface-variant">{{ student.username }}</p>
          </div>
          <div class="flex shrink-0 gap-2">
            <AppButton
              variant="ghostDanger"
              size="sm"
              :aria-label="t('teacher.rooms.waitingDeny', { name: student.fullName })"
              @click="deny(student)"
            >
              {{ t('teacher.rooms.waitingDenyShort') }}
            </AppButton>
            <AppButton
              variant="primary"
              size="sm"
              :aria-label="t('teacher.rooms.waitingApprove', { name: student.fullName })"
              @click="approve(student)"
            >
              {{ t('teacher.rooms.waitingApproveShort') }}
            </AppButton>
          </div>
        </li>
      </ul>
    </AppCard>

    <AppDialog
      v-if="showEditor"
      :label="editorTitle"
      max-width="max-w-lg"
      @close="closeEditor"
    >
      <form ref="editorPanel" class="flex max-h-[92dvh] flex-col" @submit.prevent="saveRoom">
        <header class="flex items-start justify-between gap-3 border-b border-outline-variant p-4">
          <div class="min-w-0">
            <h3 class="text-base font-semibold text-on-surface">{{ editorTitle }}</h3>
            <p class="mt-0.5 text-sm text-on-surface-variant">
              {{ t('teacher.rooms.emptyHint') }}
            </p>
          </div>
          <AppButton
            variant="ghost"
            class="shrink-0"
            :aria-label="t('common.close')"
            @click="closeEditor"
          >
            <X class="size-4" aria-hidden="true" />
          </AppButton>
        </header>

        <div class="flex-1 space-y-4 overflow-y-auto p-4">
          <label class="block">
            <span class="text-xs font-semibold text-on-surface-variant">
              {{ t('teacher.rooms.name') }}
            </span>
            <AppInput
              v-model="editorName"
              :placeholder="t('teacher.rooms.namePlaceholder')"
              class="mt-1"
            />
          </label>

          <!-- Optional, and any number: a room can take several subjects, and
               everyone who arrives through the key joins all of them. -->
          <div>
            <p class="text-xs font-semibold text-on-surface-variant">
              {{ t('teacher.rooms.courses') }}
            </p>
            <p class="mt-0.5 text-[11px] text-on-surface-variant">
              {{ t('teacher.rooms.coursesHint') }}
            </p>
            <ul v-if="courses.length" class="mt-2 flex flex-wrap gap-1.5">
              <li v-for="course in courses" :key="course.id">
                <AppButton
                  variant="secondaryPlain"
                  size="sm"
                  :aria-pressed="editorCourseIds.includes(course.id)"
                  :class="editorCourseIds.includes(course.id) ? 'bg-secondary-container text-on-secondary-container' : ''"
                  @click="toggleCourse(course.id)"
                >
                  <CircleCheck
                    v-if="editorCourseIds.includes(course.id)"
                    class="size-3.5"
                    aria-hidden="true"
                  />
                  <BookOpen v-else class="size-3.5" aria-hidden="true" />
                  {{ course.title }}
                </AppButton>
              </li>
            </ul>
            <p v-else class="mt-2 text-[11px] text-on-surface-variant">
              {{ t('teacher.rooms.noCoursesYet') }}
            </p>
          </div>
        </div>

        <footer class="flex justify-end gap-2 border-t border-outline-variant p-4">
          <AppButton variant="secondary" ref="editorCancel" @click="closeEditor">
            {{ t('common.cancel') }}
          </AppButton>
          <AppButton variant="primary" type="submit" :disabled="editorName.trim() === ''">
            <Plus v-if="editingRoomId === null" class="size-4" aria-hidden="true" />
            {{ editingRoomId === null ? t('teacher.rooms.create') : t('common.save') }}
          </AppButton>
        </footer>
      </form>
    </AppDialog>
  </section>
</template>