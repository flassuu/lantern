<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowDown, ArrowUp } from '@lucide/vue'
import type { Journal } from '../../api/types'

/**
 * Students against tests: the table a teacher wants *before* a lesson.
 *
 * Three decisions worth writing down:
 *
 * **The name column is sticky.** A journal is wide, and a row whose name has
 * scrolled off the left is a row nobody can say anything about.
 *
 * **An empty cell is a dash, not a zero.** "Never attempted" and "attempted and
 * scored nothing" are different facts, and a `0%` would say the second about a
 * student who did the first.
 *
 * **The attempts and the date are in the tooltip, not in the cell.** The cell is
 * scanned down a column of numbers; the details belong to the one cell someone
 * has stopped on.
 */
const props = defineProps<{ journal: Journal }>()

// A cell is a number; the teacher who stops on it wants the attempt behind it,
// which lives on a run - so opening one needs the run as well as the student.
const emit = defineEmits<{ open: [sessionId: string, userId: string] }>()

const { t } = useI18n()

const sortBy = ref<'name' | 'last'>('name')

const rows = computed(() =>
  props.journal.students.map((student, index) => ({
    student,
    cells: props.journal.cells[index] ?? [],
  })),
)

/**
 * Sorted by name by default; "last" is by the most recent thing anywhere in the
 * row, which is the column a teacher opens this screen to find.
 */
const ordered = computed(() => {
  const copy = [...rows.value]
  if (sortBy.value === 'name') {
    return copy.sort((a, b) => a.student.fullName.localeCompare(b.student.fullName))
  }
  const lastOf = (row: (typeof copy)[number]): number => {
    const times = row.cells
      .map((cell) => (cell.lastSubmittedAt === null ? 0 : Date.parse(cell.lastSubmittedAt)))
      .filter((time) => time > 0)
    return times.length === 0 ? 0 : Math.max(...times)
  }
  return copy.sort((a, b) => lastOf(b) - lastOf(a) || a.student.fullName.localeCompare(b.student.fullName))
})

/** A short date, in the reader's own locale and time zone. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

/** What a cell says when read out: attempts, then when it was last done. */
function cellDetail(attempts: number, lastSubmittedAt: string | null): string {
  const count = t('teacher.journal.attempts', { count: attempts })
  return lastSubmittedAt === null
    ? count
    : `${count} · ${formatDate(lastSubmittedAt)}`
}

/** The colour of a mark: it is a score, and a score has a direction. */
function percentClass(percent: number): string {
  if (percent >= 70) return 'text-success'
  if (percent >= 40) return 'text-warning'
  return 'text-error'
}
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full min-w-max border-collapse text-sm">
      <caption class="sr-only">
        {{ t('teacher.journal.caption', { title: journal.title }) }}
      </caption>
      <thead>
        <tr>
          <th
            scope="col"
            class="sticky left-0 z-10 bg-surface-container px-3 py-2 text-left"
          >
            <button
              type="button"
              class="flex items-center gap-1 text-xs font-semibold text-on-surface"
              :aria-pressed="sortBy === 'name'"
              @click="sortBy = 'name'"
            >
              {{ t('teacher.journal.student') }}
              <ArrowUp v-if="sortBy === 'name'" class="size-3.5" aria-hidden="true" />
              <ArrowDown v-else class="size-3.5 opacity-40" aria-hidden="true" />
            </button>
          </th>
          <th
            v-for="test in journal.tests"
            :key="test.id"
            scope="col"
            class="max-w-40 px-3 py-2 text-left align-bottom"
          >
            <span class="block text-xs font-semibold text-on-surface">{{ test.title }}</span>
          </th>
        </tr>
        <tr>
          <th
            scope="col"
            class="sticky left-0 z-10 bg-surface-container px-3 pb-2 text-left"
          >
            <button
              type="button"
              class="flex items-center gap-1 text-[11px] text-on-surface-variant"
              :aria-pressed="sortBy === 'last'"
              @click="sortBy = 'last'"
            >
              {{ t('teacher.journal.sortByLast') }}
              <ArrowDown v-if="sortBy === 'last'" class="size-3" aria-hidden="true" />
            </button>
          </th>
          <th v-for="test in journal.tests" :key="`${test.id}-count`" class="px-3 pb-2" />
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in ordered" :key="row.student.userId" class="border-t border-outline-variant">
          <th
            scope="row"
            class="sticky left-0 z-10 bg-surface-container px-3 py-2 text-left font-normal"
          >
            <span class="block truncate font-medium text-on-surface">
              {{ row.student.fullName }}
            </span>
            <span class="block truncate text-[11px] text-on-surface-variant">
              @{{ row.student.username }}
            </span>
          </th>
          <td
            v-for="(cell, index) in row.cells"
            :key="`${row.student.userId}-${index}`"
            class="px-3 py-2 tabular-nums"
          >
            <!-- A dash, not a zero: this student has never attempted this test. -->
            <span v-if="cell.percent === null" class="text-on-surface-variant">—</span>
            <button
              v-else
              type="button"
              class="state-layer rounded-lg px-2 py-1 font-semibold"
              :class="percentClass(cell.percent)"
              :title="cellDetail(cell.attempts, cell.lastSubmittedAt)"
              @click="
                cell.sessionId !== null && emit('open', cell.sessionId, row.student.userId)
              "
            >
              {{ cell.percent }}%
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
