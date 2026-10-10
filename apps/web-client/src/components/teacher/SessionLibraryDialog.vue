<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowDownAZ, ArrowLeft, ArrowRight, ArrowUpAZ, ChevronDown, Search, X } from '@lucide/vue'
import { ApiError } from '../../api/client'
import {
  listSessionPage,
  type LiveSessionStatus,
  type SessionSort,
  type SessionSummary,
} from '../../api/sessions'
import { listTags } from '../../api/tags'
import type { Tag, TestSummary } from '../../api/types'
import SkeletonList from '../common/SkeletonList.vue'
import AppButton from '../../components/common/AppButton.vue'
import AppDialog from '../../components/common/AppDialog.vue'
import AppInput from '../../components/common/AppInput.vue'
import { useDialogFocus } from '../../composables/focusTrap'
import { getRoomsState, loadRooms } from '../../composables/rooms'

/**
 * Every session the teacher has ever run, with the tools to find one.
 *
 * The Live tab can only show a handful of tabs; this is where the rest live. It
 * is a no-frills picker on purpose - search, the filters a teacher actually
 * thinks in (which test, which class, when, what topic), a sort, and a list that
 * answers with the run's name and code. Picking one hands it back and closes.
 *
 * Paging is server-side and counted: the list asks for a page and the total at
 * once, so "showing 1-20 of 137" is a fact and not an estimate from the page.
 */
const props = defineProps<{
  tests: TestSummary[]
  selectedId: string
}>()

const emit = defineEmits<{ select: [string]; close: [] }>()

const { t } = useI18n()

const PAGE = 20

/**
 * The chrome the library's own controls share.
 *
 * A bare `<select>` keeps the browser's dark fill, which on a container surface
 * reads as a black hole with no edge - so the fields here are drawn like the
 * app's inputs, and the arrow is ours so it is the same in every browser.
 */
const FIELD =
  'h-[var(--control-md)] w-full rounded-[var(--radius-control)] border border-outline-variant bg-surface-container-high px-3 text-sm text-on-surface'
const SELECT = `${FIELD} appearance-none pr-9`

const panel = ref<HTMLElement | null>(null)
const cancelRef = ref<HTMLButtonElement | null>(null)
useDialogFocus(() => true, () => emit('close'), panel, cancelRef)

const rooms = getRoomsState()
const tags = ref<Tag[]>([])

const query = ref('')
const testId = ref('')
const status = ref<'' | LiveSessionStatus>('')
const roomId = ref('')
const tagId = ref('')
const from = ref('')
const to = ref('')
const sort = ref<SessionSort>('created')
const dir = ref<'asc' | 'desc'>('desc')
const offset = ref(0)

const sessions = ref<SessionSummary[]>([])
const total = ref(0)
const loading = ref(true)
const errorKey = ref('')

const range = computed(() => {
  if (total.value === 0) return ''
  const first = offset.value + 1
  const last = Math.min(offset.value + PAGE, total.value)
  return t('teacher.live.library.range', { first, last, total: total.value })
})

const hasFilters = computed(
  () =>
    query.value.trim() !== '' ||
    testId.value !== '' ||
    status.value !== '' ||
    roomId.value !== '' ||
    tagId.value !== '' ||
    from.value !== '' ||
    to.value !== '',
)

function errorKeyOf(error: unknown): string {
  if (!(error instanceof ApiError)) return 'generic'
  if (error.code === 'NETWORK') return 'network'
  return 'generic'
}

async function load(): Promise<void> {
  loading.value = true
  errorKey.value = ''
  try {
    const page = await listSessionPage({
      query: query.value.trim() === '' ? null : query.value.trim(),
      testId: testId.value === '' ? null : testId.value,
      status: status.value === '' ? null : status.value,
      roomId: roomId.value === '' ? null : roomId.value,
      tagId: tagId.value === '' ? null : tagId.value,
      from: from.value === '' ? null : from.value,
      // A date input gives a day, and a session on that day has a time; without
      // the end of the day the "to" filter would exclude the day it names.
      to: to.value === '' ? null : `${to.value}T23:59:59.999Z`,
      sort: sort.value,
      dir: dir.value,
      limit: PAGE,
      offset: offset.value,
    })
    sessions.value = page.sessions
    total.value = page.total
  } catch (error) {
    errorKey.value = errorKeyOf(error)
    sessions.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

/** Any filter change restarts at the first page: page 3 of a new filter is nowhere. */
let debounce = 0
function reload(): void {
  offset.value = 0
  window.clearTimeout(debounce)
  debounce = window.setTimeout(() => void load(), 200)
}

watch([query, testId, status, roomId, tagId, from, to, sort, dir], reload)

function clearFilters(): void {
  query.value = ''
  testId.value = ''
  status.value = ''
  roomId.value = ''
  tagId.value = ''
  from.value = ''
  to.value = ''
}

function toggleDir(): void {
  dir.value = dir.value === 'asc' ? 'desc' : 'asc'
}

function page(delta: number): void {
  const next = offset.value + delta * PAGE
  if (next < 0 || next >= total.value) return
  offset.value = next
  void load()
}

function pick(id: string): void {
  emit('select', id)
  emit('close')
}

function labelOf(session: SessionSummary): string {
  return session.name ?? session.title
}

function roomNameOf(id: string | null): string {
  return rooms.rooms.find((room) => room.id === id)?.name ?? ''
}

onMounted(async () => {
  void loadRooms()
  // Labels are the teacher's own; a failure leaves the filter empty rather than
  // failing the whole library, because a tag is a nice-to-have on this screen.
  try {
    tags.value = await listTags()
  } catch {
    tags.value = []
  }
  await load()
})

defineExpose({ load })
</script>

<template>
  <AppDialog :label="t('teacher.live.library.title')" max-width="max-w-2xl" @close="emit('close')">
    <form ref="panel" class="flex max-h-[92dvh] flex-col" @submit.prevent>
      <header class="flex items-start justify-between gap-3 border-b border-outline-variant p-4">
        <div class="min-w-0">
          <h3 class="text-base font-semibold text-on-surface">
            {{ t('teacher.live.library.title') }}
          </h3>
          <p class="mt-0.5 text-sm text-on-surface-variant">
            {{ range || t('teacher.live.library.hint') }}
          </p>
        </div>
        <AppButton
          variant="ghost"
          class="shrink-0"
          :aria-label="t('common.close')"
          @click="emit('close')"
        >
          <X class="size-4" aria-hidden="true" />
        </AppButton>
      </header>

      <div class="space-y-3 border-b border-outline-variant p-4">
        <div class="relative">
          <Search
            class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-on-surface-variant"
            aria-hidden="true"
          />
          <AppInput
            v-model="query"
            type="search"
            class="pl-9"
            :placeholder="t('teacher.live.library.search')"
            :aria-label="t('teacher.live.library.search')"
          />
        </div>

        <div class="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            class="inline-flex h-8 items-center rounded-full border px-3 text-[11px] font-semibold"
            :class="
              status === ''
                ? 'border-transparent bg-primary text-on-primary'
                : 'border-outline-variant bg-surface-container-high text-on-surface-variant'
            "
            @click="status = ''"
          >
            {{ t('teacher.live.library.statusAny') }}
          </button>
          <button
            v-for="option in (['lobby', 'active', 'paused', 'finished'] as const)"
            :key="option"
            type="button"
            class="inline-flex h-8 items-center rounded-full border px-3 text-[11px] font-semibold"
            :class="
              status === option
                ? 'border-transparent bg-primary text-on-primary'
                : 'border-outline-variant bg-surface-container-high text-on-surface-variant'
            "
            @click="status = option"
          >
            {{ t(`teacher.live.status.${option}`) }}
          </button>
        </div>

        <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label class="block">
            <span class="text-[11px] font-semibold text-on-surface-variant">
              {{ t('teacher.live.library.test') }}
            </span>
            <div class="relative mt-1">
              <select v-model="testId" :class="SELECT">
                <option value="">{{ t('teacher.live.library.testAny') }}</option>
                <option v-for="test in props.tests" :key="test.id" :value="test.id">
                  {{ test.title }}
                </option>
              </select>
              <ChevronDown class="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-on-surface-variant" aria-hidden="true" />
            </div>
          </label>

          <label class="block">
            <span class="text-[11px] font-semibold text-on-surface-variant">
              {{ t('teacher.live.library.room') }}
            </span>
            <div class="relative mt-1">
              <select v-model="roomId" :class="SELECT">
                <option value="">{{ t('teacher.live.library.roomAny') }}</option>
                <option v-for="room in rooms.rooms" :key="room.id" :value="room.id">
                  {{ room.name }}
                </option>
              </select>
              <ChevronDown class="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-on-surface-variant" aria-hidden="true" />
            </div>
          </label>

          <label class="block">
            <span class="text-[11px] font-semibold text-on-surface-variant">
              {{ t('teacher.live.library.tag') }}
            </span>
            <div class="relative mt-1">
              <select v-model="tagId" :class="SELECT">
                <option value="">{{ t('teacher.live.library.tagAny') }}</option>
                <option v-for="tag in tags" :key="tag.id" :value="tag.id">{{ tag.name }}</option>
              </select>
              <ChevronDown class="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-on-surface-variant" aria-hidden="true" />
            </div>
          </label>
        </div>

        <div class="grid grid-cols-2 gap-2">
          <label class="block">
            <span class="text-[11px] font-semibold text-on-surface-variant">
              {{ t('teacher.live.library.from') }}
            </span>
            <input v-model="from" type="date" :class="FIELD" class="mt-1" />
          </label>
          <label class="block">
            <span class="text-[11px] font-semibold text-on-surface-variant">
              {{ t('teacher.live.library.to') }}
            </span>
            <input v-model="to" type="date" :class="FIELD" class="mt-1" />
          </label>
        </div>

        <div class="flex flex-wrap items-end gap-2">
          <label class="block">
            <span class="text-[11px] font-semibold text-on-surface-variant">
              {{ t('teacher.live.library.sort') }}
            </span>
            <div class="relative mt-1 w-44">
              <select v-model="sort" :class="SELECT">
                <option value="created">{{ t('teacher.live.library.sortCreated') }}</option>
                <option value="name">{{ t('teacher.live.library.sortName') }}</option>
                <option value="status">{{ t('teacher.live.library.sortStatus') }}</option>
                <option value="submitted">{{ t('teacher.live.library.sortSubmitted') }}</option>
              </select>
              <ChevronDown class="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-on-surface-variant" aria-hidden="true" />
            </div>
          </label>
          <AppButton
            variant="secondary"
            :aria-label="dir === 'asc' ? t('teacher.live.library.ascending') : t('teacher.live.library.descending')"
            @click="toggleDir"
          >
            <ArrowUpAZ v-if="dir === 'asc'" class="size-4" aria-hidden="true" />
            <ArrowDownAZ v-else class="size-4" aria-hidden="true" />
          </AppButton>
          <AppButton
            v-if="hasFilters"
            variant="ghost"
            size="sm"
            class="ml-auto"
            @click="clearFilters"
          >
            {{ t('teacher.live.library.clear') }}
          </AppButton>
        </div>
      </div>

      <div class="min-h-32 flex-1 overflow-y-auto p-2">
        <p
          v-if="errorKey"
          role="alert"
          class="m-2 rounded-xl bg-error-container px-3 py-2 text-sm text-on-error-container"
        >
          {{ t(`teacher.errors.${errorKey === 'network' ? 'network' : 'generic'}`) }}
        </p>
        <SkeletonList v-else-if="loading && sessions.length === 0" :rows="4" />
        <p v-else-if="sessions.length === 0" class="p-6 text-center text-sm text-on-surface-variant">
          {{ t('teacher.live.library.empty') }}
        </p>
        <ul v-else class="space-y-1">
          <li v-for="session in sessions" :key="session.id">
            <button
              type="button"
              class="state-layer flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left"
              :class="session.id === selectedId ? 'bg-primary-container text-on-primary-container' : 'hover:bg-surface-container'"
              @click="pick(session.id)"
            >
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-semibold">{{ labelOf(session) }}</span>
                <span class="mt-0.5 block truncate text-xs text-on-surface-variant">
                  {{ session.title }}<template v-if="roomNameOf(session.roomId)"> · {{ roomNameOf(session.roomId) }}</template>
                </span>
                <span v-if="session.tags.length" class="mt-1 flex flex-wrap gap-1">
                  <span
                    v-for="tag in session.tags"
                    :key="tag.id"
                    class="rounded-full bg-secondary-container px-2 py-0.5 text-[10px] font-semibold text-on-secondary-container"
                  >
                    {{ tag.name }}
                  </span>
                </span>
              </span>
              <span class="shrink-0 text-right">
                <span class="block font-mono text-xs tracking-wide">{{ session.joinCode }}</span>
                <span class="mt-0.5 block text-[11px] text-on-surface-variant">
                  {{ t(`teacher.live.status.${session.status}`) }}
                </span>
              </span>
            </button>
          </li>
        </ul>
      </div>

      <footer class="flex items-center justify-between gap-2 border-t border-outline-variant p-4">
        <span class="text-xs text-on-surface-variant">{{ range }}</span>
        <div class="flex gap-2">
          <AppButton
            variant="secondary"
            size="sm"
            :disabled="offset === 0"
            :aria-label="t('teacher.live.library.previous')"
            @click="page(-1)"
          >
            <ArrowLeft class="size-4" aria-hidden="true" />
          </AppButton>
          <AppButton
            variant="secondary"
            size="sm"
            :disabled="offset + PAGE >= total"
            :aria-label="t('teacher.live.library.next')"
            @click="page(1)"
          >
            <ArrowRight class="size-4" aria-hidden="true" />
          </AppButton>
        </div>
      </footer>
    </form>
  </AppDialog>
</template>
