<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Clock,
  EyeOff,
  History,
  Pencil,
  Timer,
  Trophy,
  X,
} from '@lucide/vue'
import { ApiError } from '../../api/client'
import {
  getAttemptDetail,
  type AttemptDetail,
  type AttemptQuestion,
} from '../../api/sessions'
import AppButton from '../common/AppButton.vue'
import AppDialog from '../common/AppDialog.vue'
import SkeletonList from '../common/SkeletonList.vue'
import { useDialogFocus } from '../../composables/focusTrap'

/**
 * One student's run, opened from a row on the board.
 *
 * The board tells a teacher how a class did; this tells them how one person did.
 * It answers the questions the score cannot: which question they sat on, how
 * often they changed their mind, and whether the window went away while they
 * worked. The answer key is on screen here - this is the teacher's own run,
 * looked at after the fact, and the student was never shown it.
 *
 * Timings and change counts are the client's word for it. Where no timing was
 * measured the view says so with a dash rather than a zero, because a paper shown
 * all at once has no single question on screen to time.
 */
const props = defineProps<{
  sessionId: string
  userId: string
}>()

const emit = defineEmits<{ close: [] }>()

const { t, locale } = useI18n()

const panel = ref<HTMLElement | null>(null)
const cancelRef = ref<HTMLButtonElement | null>(null)
useDialogFocus(() => true, () => emit('close'), panel, cancelRef)

const detail = ref<AttemptDetail | null>(null)
const loading = ref(true)
const errorKey = ref('')

watch(
  () => [props.sessionId, props.userId],
  () => {
    void load()
  },
  { immediate: true },
)

async function load(): Promise<void> {
  loading.value = true
  errorKey.value = ''
  detail.value = null
  try {
    detail.value = await getAttemptDetail(props.sessionId, props.userId)
  } catch (error) {
    errorKey.value =
      error instanceof ApiError && error.code === 'FORBIDDEN'
        ? 'teacher.errors.forbidden'
        : error instanceof ApiError && error.code === 'NOT_FOUND'
          ? 'teacher.errors.notFound'
          : 'teacher.errors.generic'
  } finally {
    loading.value = false
  }
}

interface PreviewOption {
  key: string
  text: string
}

interface PreviewPair {
  left: string
  right: string
}

/** The question's own payload, read defensively: a payload from a future version
 *  must not be able to break the view that is showing it. */
interface Payload {
  options?: PreviewOption[]
  correct?: string | string[] | boolean
  accepted?: string[]
  pairs?: PreviewPair[]
}

function payloadOf(question: AttemptQuestion): Payload {
  return (question.correct ?? {}) as Payload
}

function optionsOf(question: AttemptQuestion): PreviewOption[] {
  return payloadOf(question).options ?? []
}

/** The option's own text, so a row shows the answer and not the letter it was stored under. */
function optionText(question: AttemptQuestion, key: string | undefined): string {
  if (key === undefined) return t('teacher.participantDetail.empty')
  const option = optionsOf(question).find((entry) => entry.key === key)
  return option?.text ?? key
}

/** What the student gave for this question, in words. */
function givenOf(question: AttemptQuestion): string {
  const answer = question.answer
  if (answer === null) return t('teacher.participantDetail.untouched')
  if (answer.key !== undefined) return optionText(question, answer.key)
  if (answer.keys !== undefined && answer.keys.length > 0) {
    return answer.keys.map((key) => optionText(question, key)).join(', ')
  }
  if (answer.boolean !== undefined) {
    return answer.boolean
      ? t('teacher.editor.trueValue')
      : t('teacher.editor.falseValue')
  }
  if (answer.text !== undefined && answer.text.trim() !== '') return answer.text
  if (answer.pairs !== undefined && answer.pairs.length > 0) {
    return answer.pairs.map((pair) => `${pair.left} → ${pair.right}`).join(', ')
  }
  return t('teacher.participantDetail.empty')
}

/** What would have been right, in the same words. */
function correctOf(question: AttemptQuestion): string {
  const payload = payloadOf(question)
  if (payload.correct !== undefined) {
    if (Array.isArray(payload.correct)) {
      return payload.correct.map((key) => optionText(question, key)).join(', ')
    }
    if (typeof payload.correct === 'boolean') {
      return payload.correct
        ? t('teacher.editor.trueValue')
        : t('teacher.editor.falseValue')
    }
    return optionText(question, payload.correct)
  }
  if (payload.accepted !== undefined && payload.accepted.length > 0) {
    return payload.accepted.join(', ')
  }
  if (payload.pairs !== undefined && payload.pairs.length > 0) {
    return payload.pairs.map((pair) => `${pair.left} → ${pair.right}`).join(', ')
  }
  return t('teacher.participantDetail.empty')
}

const METER = 0.4

/** Milliseconds as a length of time, or a dash when nothing was measured. */
function formatMs(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < METER * 1000) return t('teacher.participantDetail.underASecond')
  if (ms < 60_000) {
    return t('teacher.participantDetail.seconds', { seconds: Math.round(ms / 1000) })
  }
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return t('teacher.participantDetail.minutesSeconds', { minutes, seconds })
}

function formatClockTime(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale.value, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)
}

const score = computed(() => {
  const value = detail.value
  if (value === null) return '—'
  if (value.percent === null) return '—'
  return `${value.score ?? 0} / ${value.maxScore ?? 0} · ${value.percent}%`
})

/** The four figures worth reading first, in the board's tile shape. */
const cards = computed(() => {
  const value = detail.value
  if (value === null) return []
  return [
    {
      key: 'score',
      value: score.value,
      icon: Trophy,
      tone:
        value.passed === true
          ? 'text-success'
          : value.passed === false
            ? 'text-error'
            : 'text-on-surface',
    },
    {
      key: 'total',
      value: formatMs(value.totalTimeMs),
      icon: Clock,
      tone: 'text-on-surface',
    },
    {
      key: 'average',
      value: formatMs(value.averageMs),
      icon: Timer,
      tone: 'text-on-surface',
    },
    {
      key: 'focus',
      value: String(value.focusLost),
      icon: EyeOff,
      // Focus lost is not a fault by itself, so it only takes colour when it
      // happened; zero is not good news and not bad news either.
      tone: value.focusLost > 0 ? 'text-warning' : 'text-on-surface',
    },
  ]
})

const longest = computed(() => {
  const value = detail.value
  if (value === null || value.slowest === null) return ''
  return t('teacher.participantDetail.slowest', {
    body: value.slowest.body,
    time: formatMs(value.slowest.timeMs),
  })
})

/** The activity log, newest last, in the order it happened. */
const timeline = computed(() => detail.value?.events ?? [])
</script>

<template>
  <AppDialog
    :label="t('teacher.participantDetail.title')"
    max-width="max-w-3xl"
    @close="emit('close')"
  >
    <div ref="panel" class="flex max-h-[92dvh] flex-col">
      <header class="flex items-start justify-between gap-3 border-b border-outline-variant p-4">
        <div class="min-w-0">
          <h3 class="truncate text-base font-semibold text-on-surface">
            {{ detail?.fullName || detail?.username || t('teacher.participantDetail.title') }}
          </h3>
          <p class="mt-0.5 text-sm text-on-surface-variant">
            <template v-if="detail">
              @{{ detail.username }} ·
              {{ t('teacher.participantDetail.joinedAt', { time: formatClockTime(detail.joinedAt) }) }}
              <template v-if="detail.submittedAt !== null">
                ·
                {{
                  t('teacher.participantDetail.submittedAt', {
                    time: formatClockTime(detail.submittedAt),
                  })
                }}
              </template>
            </template>
          </p>
        </div>
        <AppButton
          variant="ghost"
          class="shrink-0"
          ref="cancelRef"
          :aria-label="t('common.close')"
          @click="emit('close')"
        >
          <X class="size-4" aria-hidden="true" />
        </AppButton>
      </header>

      <div class="flex-1 space-y-4 overflow-y-auto p-4">
        <p
          v-if="errorKey"
          role="alert"
          class="rounded-xl bg-error-container px-3 py-2 text-sm text-on-error-container"
        >
          {{ t(errorKey) }}
        </p>

        <SkeletonList v-else-if="loading" :rows="4" />

        <template v-else-if="detail !== null">
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div
              v-for="card in cards"
              :key="card.key"
              class="rounded-2xl bg-surface-container-high px-3 py-2.5"
            >
              <span class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant">
                <component :is="card.icon" class="size-3.5" aria-hidden="true" />
                {{ t(`teacher.participantDetail.cards.${card.key}`) }}
              </span>
              <p class="mt-1 text-sm font-semibold tabular-nums" :class="card.tone">
                {{ card.value }}
              </p>
            </div>
          </div>

          <p v-if="longest" class="text-xs text-on-surface-variant">
            {{ longest }}
          </p>

          <section>
            <h4 class="text-sm font-semibold text-on-surface">
              {{ t('teacher.participantDetail.byQuestion') }}
            </h4>
            <ul class="mt-2 space-y-2">
              <li
                v-for="(question, index) in detail.questions"
                :key="question.questionId"
                class="rounded-2xl border border-outline-variant bg-surface-container-high p-3"
              >
                <div class="flex items-start justify-between gap-3">
                  <p class="min-w-0 flex-1 text-sm text-on-surface">
                    <span class="font-semibold text-on-surface-variant">{{ index + 1 }}.</span>
                    {{ question.body }}
                  </p>
                  <span
                    class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                    :class="
                      question.isCorrect
                        ? 'bg-success-container text-on-success-container'
                        : 'bg-error-container text-on-error-container'
                    "
                  >
                    {{ question.pointsAwarded }} / {{ question.points }}
                  </span>
                </div>

                <dl class="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                  <div class="flex gap-1.5">
                    <dt class="shrink-0 text-on-surface-variant">
                      {{ t('teacher.participantDetail.given') }}:
                    </dt>
                    <dd class="min-w-0 truncate text-on-surface">{{ givenOf(question) }}</dd>
                  </div>
                  <div class="flex gap-1.5">
                    <dt class="shrink-0 text-on-surface-variant">
                      {{ t('teacher.participantDetail.correct') }}:
                    </dt>
                    <dd class="min-w-0 truncate text-on-surface">{{ correctOf(question) }}</dd>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <dt class="flex items-center gap-1 text-on-surface-variant">
                      <Timer class="size-3" aria-hidden="true" />
                      {{ t('teacher.participantDetail.timeOn') }}:
                    </dt>
                    <dd class="tabular-nums text-on-surface">{{ formatMs(question.timeMs) }}</dd>
                  </div>
                  <div
                    v-if="question.changed > 0"
                    class="flex items-center gap-1.5"
                  >
                    <dt class="flex items-center gap-1 text-on-surface-variant">
                      <Pencil class="size-3" aria-hidden="true" />
                      {{ t('teacher.participantDetail.changed') }}:
                    </dt>
                    <dd class="tabular-nums text-on-surface">
                      {{
                        t('teacher.participantDetail.changedCount', {
                          count: question.changed,
                        })
                      }}
                    </dd>
                  </div>
                </dl>
              </li>
            </ul>
          </section>

          <section>
            <h4 class="flex items-center gap-2 text-sm font-semibold text-on-surface">
              <History class="size-4" aria-hidden="true" />
              {{ t('teacher.participantDetail.activity') }}
            </h4>
            <p v-if="timeline.length === 0" class="mt-2 text-xs text-on-surface-variant">
              {{ t('teacher.participantDetail.noActivity') }}
            </p>
            <ol v-else class="mt-2 space-y-1.5">
              <li
                v-for="(event, index) in timeline"
                :key="index"
                class="flex items-center gap-2 text-xs"
              >
                <span
                  class="size-1.5 shrink-0 rounded-full"
                  :class="event.kind === 'hidden' ? 'bg-warning' : 'bg-success'"
                  aria-hidden="true"
                />
                <span class="tabular-nums text-on-surface-variant">
                  {{ formatClockTime(event.at) }}
                </span>
                <span class="text-on-surface">
                  {{
                    event.kind === 'hidden'
                      ? t('teacher.participantDetail.leftWindow')
                      : t('teacher.participantDetail.backInWindow')
                  }}
                </span>
              </li>
            </ol>
          </section>
        </template>
      </div>
    </div>
  </AppDialog>
</template>
