<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ClipboardList, Download, Printer } from '@lucide/vue'
import { ApiError } from '../../api/client'
import { listCourses } from '../../api/courses'
import { downloadJournalCsv, getCourseJournal, getRoomJournal } from '../../api/journals'
import { listRooms } from '../../api/rooms'
import type { CourseSummary, Journal, Room } from '../../api/types'
import EmptyState from '../common/EmptyState.vue'
import SkeletonList from '../common/SkeletonList.vue'
import JournalTable from './JournalTable.vue'
import ParticipantDetailDialog from './ParticipantDetailDialog.vue'
import AppButton from '../../components/common/AppButton.vue'

/**
 * The journal: students against tests, for one room or one course.
 *
 * The scope switch is the whole of the screen's chrome. A room is *who* and a
 * course is *what*, and a teacher arriving at this screen has one of the two in
 * mind - not both - so the list is a choice between them rather than two lists
 * to scroll past. Whichever is picked first becomes the one that opens: a
 * teacher with a single room should not have to choose.
 */
const props = defineProps<{
  /**
   * Where the teacher came from: a room or a course that asked for its journal.
   *
   * The dashboard remounts this screen on every tab change, so the prop is
   * read once, at mount, which is also when the lists start loading.
   */
  target?: { scope: 'room' | 'course'; id: string } | null
}>()

const { t } = useI18n()

const rooms = ref<Room[]>([])
const courses = ref<CourseSummary[]>([])
const scope = ref<'room' | 'course'>('room')
const selectedId = ref('')
const journal = ref<Journal | null>(null)
const loading = ref(false)
const errorKey = ref('')
/** The attempt behind a cell, open on top of the table that led to it. */
const attempt = ref<{ sessionId: string; userId: string } | null>(null)

const choices = computed(() =>
  scope.value === 'room'
    ? rooms.value.map((room) => ({ id: room.id, label: room.name, count: room.membersCount }))
    : courses.value.map((course) => ({ id: course.id, label: course.title, count: course.studentsCount })),
)

function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return t('teacher.errors.generic')
  if (error.code === 'NETWORK') return t('teacher.errors.network')
  if (error.code === 'FORBIDDEN') return t('teacher.errors.generic')
  if (error.code === 'NOT_FOUND') return t('teacher.errors.notFound')
  return t('teacher.errors.generic')
}

async function loadJournal(): Promise<void> {
  if (selectedId.value === '') {
    journal.value = null
    return
  }
  loading.value = true
  errorKey.value = ''
  try {
    journal.value =
      scope.value === 'room'
        ? await getRoomJournal(selectedId.value)
        : await getCourseJournal(selectedId.value)
  } catch (error) {
    errorKey.value = errorMessage(error)
    journal.value = null
  } finally {
    loading.value = false
  }
}

/**
 * Switching scope picks the first thing in the new list, unless something is
 * already chosen there. A teacher with one room and one course opens straight
 * into the room's table rather than being asked which they meant.
 */
watch(scope, () => {
  const stillThere = choices.value.some((choice) => choice.id === selectedId.value)
  if (stillThere) return
  selectedId.value = choices.value[0]?.id ?? ''
  void loadJournal()
})

async function exportCsv(): Promise<void> {
  if (!journal.value) return
  try {
    await downloadJournalCsv(journal.value.scope, selectedId.value, journal.value.title)
  } catch {
    errorKey.value = errorMessage(new ApiError(0, 'NETWORK', ''))
  }
}

/** A cell was clicked: the number stays, and the attempt under it opens. */
function openAttempt(sessionId: string, userId: string): void {
  attempt.value = { sessionId, userId }
}

/** The browser's own print dialog: no PDF dependency, and it prints what is on screen. */
function printJournal(): void {
  window.print()
}

onMounted(async () => {
  try {
    const [ownRooms, ownCourses] = await Promise.all([listRooms(), listCourses()])
    rooms.value = ownRooms
    courses.value = ownCourses
  } catch (error) {
    errorKey.value = errorMessage(error)
    return
  }
  // Checked against the list the target names, not against whichever scope is
  // showing: a course asked for, with the room scope on by default, is not in
  // the list on screen - it is the reason the scope is about to change.
  const target = props.target ?? null
  const targetList = target === null ? [] : target.scope === 'room' ? rooms.value : courses.value
  const arrived = target !== null && targetList.some((item) => item.id === target.id)
  if (arrived && target !== null) {
    scope.value = target.scope
    selectedId.value = target.id
  } else {
    selectedId.value = choices.value[0]?.id ?? ''
  }
  await loadJournal()
})
</script>

<template>
  <section>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2" role="group" :aria-label="t('teacher.journal.scope')">
        <AppButton
          :variant="scope === 'room' ? 'primary' : 'secondaryPlain'"
          size="sm"
          :aria-pressed="scope === 'room'"
          @click="scope = 'room'"
        >
          {{ t('teacher.journal.byRoom') }}
        </AppButton>
        <AppButton
          :variant="scope === 'course' ? 'primary' : 'secondaryPlain'"
          size="sm"
          :aria-pressed="scope === 'course'"
          @click="scope = 'course'"
        >
          {{ t('teacher.journal.byCourse') }}
        </AppButton>
      </div>

      <div class="flex items-center gap-2">
        <AppButton variant="secondary" size="sm" :disabled="journal === null" @click="exportCsv">
          <Download class="size-3.5" aria-hidden="true" />
          {{ t('teacher.journal.export') }}
        </AppButton>
        <AppButton variant="secondary" size="sm" :disabled="journal === null" @click="printJournal">
          <Printer class="size-3.5" aria-hidden="true" />
          {{ t('teacher.journal.print') }}
        </AppButton>
      </div>
    </div>

    <p
      v-if="errorKey"
      role="alert"
      class="mt-3 rounded-xl bg-error-container px-3 py-2 text-sm text-on-error-container"
    >
      {{ errorKey }}
    </p>

    <SkeletonList v-if="loading" class="mt-3" :rows="3" />

    <EmptyState
      v-else-if="choices.length === 0"
      class="mt-3"
      :icon="ClipboardList"
      :title="t('teacher.journal.nothingTitle')"
      :description="t('teacher.journal.nothingHint')"
    />

    <template v-else>
      <div class="mt-3 flex flex-wrap gap-1.5">
        <button
          v-for="choice in choices"
          :key="choice.id"
          type="button"
          class="state-layer rounded-full px-3 py-1.5 text-xs font-semibold"
          :class="
            selectedId === choice.id
              ? 'bg-primary-container text-on-primary-container'
              : 'bg-surface-container-highest text-on-surface-variant'
          "
          :aria-pressed="selectedId === choice.id"
          @click="selectedId = choice.id; loadJournal()"
        >
          {{ choice.label }}
          <span class="tabular-nums">{{ choice.count }}</span>
        </button>
      </div>

      <div v-if="journal" class="mt-4">
        <p
          v-if="journal.tests.length === 0"
          class="rounded-xl bg-surface-container p-3 text-sm text-on-surface-variant"
        >
          {{ t('teacher.journal.noTests', { title: journal.title }) }}
        </p>
        <p
          v-else-if="journal.students.length === 0"
          class="rounded-xl bg-surface-container p-3 text-sm text-on-surface-variant"
        >
          {{ t('teacher.journal.noStudents', { title: journal.title }) }}
        </p>
        <JournalTable v-else :journal="journal" @open="openAttempt" />
      </div>
    </template>
    <ParticipantDetailDialog
      v-if="attempt"
      :session-id="attempt.sessionId"
      :user-id="attempt.userId"
      @close="attempt = null"
    />
  </section>
</template>
