<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
const visibleCount = ref(props.sessions.length)
/** Set only for the measurement pass, so every tab has a width to read. */
const measuring = ref(false)

const GAP = 8

function labelOf(session: SessionSummary): string {
  return session.name ?? session.title
}

/**
 * The tabs that are actually rendered.
 *
 * Not a `hidden` class on the extra ones: Tailwind emits `.inline-flex` after
 * `.hidden`, so a tab that is `inline-flex` can never be hidden that way - it
 * stayed on screen and slid under the library button. Rendering only the ones
 * that fit removes the question. Every tab is rendered for the measurement
 * pass, which is the only moment all of them exist.
 */
const visibleSessions = computed(() =>
  measuring.value ? props.sessions : props.sessions.slice(0, visibleCount.value),
)

const dot: Record<LiveSessionStatus, string> = {
  lobby: 'bg-primary',
  active: 'bg-success',
  paused: 'bg-warning',
  finished: 'bg-on-surface-variant',
}

async function measure(): Promise<void> {
  const line = row.value
  if (!line) return

  // Every tab is shown for one frame so each has a width to read; the row clips
  // its overflow, so that frame is invisible even if the browser paints it.
  measuring.value = true
  await nextTick()
  const widths = (Array.from(line.children) as HTMLElement[]).map((tab) => tab.offsetWidth)
  // The row is `flex-1`, so its width is the space left after the library
  // button - measured, not guessed, and stable whatever is hidden inside it.
  // Reading the strip instead would count the button twice.
  const available = line.clientWidth

  let used = 0
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
    class="flex items-end gap-2 overflow-hidden px-3 pt-1.5"
  >
    <!-- `flex-1` with `overflow-hidden`: the tabs own whatever is left after the
         library button, and the ones that do not fit are clipped rather than
         sliding under it. -->
    <div ref="row" class="flex min-w-0 flex-1 items-end gap-2 overflow-hidden">
      <!--
        `-mb-3` is what joins a tab to the board below it: the strip's divider
        sits 12px above the card, so every tab hangs into that gap, its own fill
        covering the divider line under it. Square bottom corners, same fill as
        the card underneath - the tab reads as the top of the panel rather than a
        label floating over it. `px-3` on the strip is the other half: it is the
        card's padding, so the first tab's left border lines up with the card's.
      -->
      <button
        v-for="session in visibleSessions"
        :key="session.id"
        type="button"
        role="tab"
        :aria-selected="session.id === selectedId"
        class="state-layer -mb-3 inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-t-xl border border-b-0 px-3 py-2 text-xs font-semibold transition-colors duration-200 ease-[var(--ease-standard)]"
        :class="
          session.id === selectedId
            ? 'border-outline-variant bg-surface-container text-on-surface'
            : 'border-transparent text-on-surface-variant hover:bg-surface-container'
        "
        @click="emit('select', session.id)"
      >
        <span class="size-2 rounded-full transition-colors duration-200" :class="dot[session.status]" />
        <span class="max-w-40 truncate">{{ labelOf(session) }}</span>
        <span class="font-mono tracking-wide opacity-70">{{ session.joinCode }}</span>
      </button>
    </div>

    <!--
      The library button is a tab that opens a list rather than a run, so it is
      built like one: same height, same square bottom, same hang over the
      divider, and the strip's right padding so it lines up with the card. The
      tonal fill is what keeps it from being mistaken for the open tab.
    -->
    <button
      type="button"
      class="state-layer -mb-3 inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-xl border border-b-0 border-outline-variant bg-secondary-container px-3 text-xs font-semibold text-on-secondary-container transition-colors duration-200"
      :aria-label="t('teacher.live.tabs.all')"
      @click="emit('library')"
    >
      <Library class="size-3.5" aria-hidden="true" />
      <span class="hidden sm:inline">{{ t('teacher.live.tabs.all') }}</span>
      <span class="tabular-nums opacity-80">{{ sessions.length }}</span>
    </button>
  </div>
</template>
