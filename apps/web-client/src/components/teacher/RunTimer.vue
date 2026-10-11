<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Timer } from '@lucide/vue'
import type { LiveSessionStatus } from '../../api/sessions'

/**
 * The run's clock: how long it has been going, or how long is left of it.
 *
 * It keeps its own second, on purpose. Held in the tab above it, that second
 * re-rendered the whole board - every tile, every participant row, the code
 * block - once a second, and a window that repaints that much is a window that
 * stutters. Two lines of text are cheap to repaint; the rest of the board is
 * not, and none of it changes with the clock.
 */
const props = defineProps<{
  startedAt: string | null
  finishedAt: string | null
  timeLimitSec: number | null
  status: LiveSessionStatus
  /** Set while the run is on hold; the clock reads this instead of now. */
  pausedAt: string | null
}>()

const { t } = useI18n()

const now = ref(Date.now())
let ticker: number | undefined

onMounted(() => {
  ticker = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onBeforeUnmount(() => {
  if (ticker !== undefined) window.clearInterval(ticker)
})

/** Time since the run started, frozen at the finish mark once it is over. */
const elapsedSeconds = computed(() => {
  // A lobby has no start mark yet, so it has no elapsed time either.
  if (props.startedAt === null) return 0
  const start = Date.parse(props.startedAt)
  if (Number.isNaN(start)) return 0
  // On hold, the clock reads the moment it was put on hold and stops there:
  // the second hand is not a counter to be frozen, it is a deadline to look at.
  // Resuming has already moved `startedAt` past the hold, so the next tick
  // picks up exactly where this left off.
  const end =
    props.finishedAt !== null
      ? Date.parse(props.finishedAt)
      : props.status === 'paused' && props.pausedAt !== null
        ? Date.parse(props.pausedAt)
        : now.value
  return Math.max(0, Math.floor((end - start) / 1000))
})

const remainingSeconds = computed(() =>
  props.timeLimitSec == null ? null : props.timeLimitSec - elapsedSeconds.value,
)

const isShort = computed(() => remainingSeconds.value !== null && remainingSeconds.value <= 60)

const label = computed(() => {
  const remaining = remainingSeconds.value
  if (remaining !== null && remaining <= 0) return t('teacher.live.timeUp')
  return formatClock(remaining ?? elapsedSeconds.value)
})

const caption = computed(() => {
  if (props.status === 'finished') return t('teacher.live.duration')
  return remainingSeconds.value !== null ? t('teacher.live.timeLeft') : t('teacher.live.elapsed')
})

function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const seconds = safe % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}
</script>

<template>
  <div
    class="flex shrink-0 items-center gap-2 rounded-2xl border border-outline-variant bg-surface-container-high px-3 py-2"
  >
    <span class="grid size-9 place-items-center rounded-full bg-surface-container-highest text-on-surface-variant">
      <Timer class="size-4" aria-hidden="true" />
    </span>
    <span class="leading-tight">
      <span
        class="block text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant"
      >
        {{ caption }}
      </span>
      <span
        class="block font-mono text-base font-semibold tabular-nums"
        :class="isShort ? 'text-error' : 'text-on-surface'"
      >
        {{ label }}
      </span>
    </span>
  </div>
</template>