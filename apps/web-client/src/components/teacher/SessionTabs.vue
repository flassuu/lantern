<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Library } from '@lucide/vue'
import type { LiveSessionStatus, SessionSummary } from '../../api/sessions'

/**
 * The sessions as browser tabs: as many as fit across the top of the board, the
 * rest behind the library button beside them.
 *
 * How many fit cannot be a constant - it depends on the names, the language and
 * the width of the phone - so the strip measures itself. All the tabs render
 * once, their widths are read, and the ones that do not fit are hidden; the row
 * clips its overflow, so showing them for that one measurement frame is invisible
 * even if the browser paints it.
 *
 * The library button is always there rather than only when something overflows.
 * A teacher looking for an older run should not have to notice that the strip is
 * full first, and a control that appears and disappears under the finger is
 * worse than one that stays put.
 */
const props = defineProps<{
  sessions: SessionSummary[]
  selectedId: string
}>()

const emit = defineEmits<{ select: [string]; library: [] }>()

const { t } = useI18n()

const strip = ref<HTMLElement | null>(null)
const row = ref<HTMLElement | null>(null)
const libraryButton = ref<HTMLElement | null>(null)
const visibleCount = ref(props.sessions.length)
/** Set only for the measurement pass, so every tab has a width to read. */
const measuring = ref(false)

const GAP = 8

function labelOf(session: SessionSummary): string {
  return session.name ?? session.title
}

const dot: Record<LiveSessionStatus, string> = {
  active: 'bg-success',
  paused: 'bg-warning',
  finished: 'bg-on-surface-variant',
}

async function measure(): Promise<void> {
  const container = strip.value
  const line = row.value
  if (!container || !line) return

  measuring.value = true
  await nextTick()
  const tabs = Array.from(line.children) as HTMLElement[]
  const widths = tabs.map((tab) => tab.offsetWidth)
  // The library button is part of the strip, so its room is booked before the
  // tabs are placed - otherwise the last tab would sit underneath it.
  const reserved = (libraryButton.value?.offsetWidth ?? 0) + GAP
  const available = container.clientWidth

  let used = reserved
  let fits = 0
  for (const width of widths) {
    if (fits > 0 && used + width + GAP > available) break
    used += width + GAP
    fits += 1
  }
  // At least one tab always shows: a strip of nothing but a library button
  // would hide the very session the teacher is watching.
  visibleCount.value = Math.min(Math.max(fits, 1), props.sessions.length)
  measuring.value = false
}

let observer: ResizeObserver | undefined
let frame = 0

function scheduleMeasure(): void {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => void measure())
}

onMounted(() => {
  observer = new ResizeObserver(scheduleMeasure)
  if (strip.value) observer.observe(strip.value)
  void nextTick(() => void measure())
})

onBeforeUnmount(() => {
  observer?.disconnect()
  cancelAnimationFrame(frame)
})

watch(
  () => props.sessions,
  () => {
    visibleCount.value = props.sessions.length
    void nextTick(() => void measure())
  },
)
</script>

<template>
  <div
    ref="strip"
    class="flex items-center gap-2 overflow-hidden border-b border-outline-variant px-1.5 pt-1.5"
  >
    <div ref="row" class="flex min-w-0 items-end gap-2">
      <button
        v-for="(session, index) in sessions"
        :key="session.id"
        type="button"
        role="tab"
        :aria-selected="session.id === selectedId"
        class="state-layer inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-t-xl border border-b-0 px-3 py-2 text-xs font-semibold transition-colors"
        :class="[
          session.id === selectedId
            ? 'border-outline-variant bg-surface-container-high text-on-surface'
            : 'border-transparent text-on-surface-variant hover:bg-surface-container',
          !measuring && index >= visibleCount ? 'hidden' : '',
        ]"
        @click="emit('select', session.id)"
      >
        <span class="size-2 rounded-full" :class="dot[session.status]" />
        <span class="max-w-40 truncate">{{ labelOf(session) }}</span>
        <span class="font-mono tracking-wide opacity-70">{{ session.joinCode }}</span>
      </button>
    </div>

    <button
      ref="libraryButton"
      type="button"
      class="state-layer ml-auto inline-flex min-h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[11px] font-semibold text-primary"
      :aria-label="t('teacher.live.tabs.all')"
      @click="emit('library')"
    >
      <Library class="size-3.5" aria-hidden="true" />
      <span class="hidden sm:inline">{{ t('teacher.live.tabs.all') }}</span>
      <span class="rounded-full bg-primary-container px-1.5 text-[11px] text-on-primary-container">
        {{ sessions.length }}
      </span>
    </button>
  </div>
</template>
