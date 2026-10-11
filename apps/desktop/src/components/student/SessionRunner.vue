<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Clock, Send, TriangleAlert } from '@lucide/vue'
import { ApiError } from '../../api/client'
import { submitSession, type SessionState, type StudentQuestion } from '../../api/sessions'
import {
  answeredCount,
  buildAnswers,
  emptyResponses,
  formatClock,
  matchingChoices,
  paperOptions,
  remainingMs,
  type PaperOption,
  type QuestionResponse,
  type Responses,
} from '../../student/sessionLogic'
import { useConfirm } from '../../composables/confirm'
import { useQuestionTiming } from '../../composables/useQuestionTiming'
import { useToast } from '../../composables/toast'
import QuestionAnswerInput from './QuestionAnswerInput.vue'
import AppButton from '../../components/common/AppButton.vue'
import AppCard from '../../components/common/AppCard.vue'

const props = defineProps<{
  state: SessionState
  /** True once the student has looked away; the paper says so, it does not scold. */
  leftOnce?: boolean
  /** Tells the room how far the student is; the teacher's board shows it. */
  reportProgress?: (questionIndex: number, answered: number) => void
}>()

const emit = defineEmits<{ submitted: [sessionId: string, released: boolean] }>()

const { t } = useI18n()
const confirm = useConfirm()
const toast = useToast()

const questions = computed<StudentQuestion[]>(() => props.state.questions)
const responses = ref<Responses>(emptyResponses(props.state.questions))

/**
 * One question at a time, or the whole paper.
 *
 * `questionsPerPage` is the teacher's choice and travels with the run, so the
 * runner has to do both. The paged mode keeps its own index; the whole-paper
 * mode ignores it.
 */
const paged = computed(() => props.state.session.settings.questionsPerPage === 'one')
const allowBack = computed(() => props.state.session.settings.allowBack)
const page = ref(0)
const current = computed(() => questions.value[page.value])
const lastPage = computed(() => Math.max(questions.value.length - 1, 0))
const onLastPage = computed(() => page.value >= lastPage.value)
const submitting = ref(false)
const now = ref(Date.now())
let ticker: number | undefined

const totalPoints = computed(() =>
  questions.value.reduce((sum, question) => sum + question.points, 0),
)
const answered = computed(() => answeredCount(questions.value, responses.value))

const deadline = computed(() =>
  // No start mark means the run is still a lobby, and a lobby has no clock.
  props.state.session.startedAt === null
    ? null
    : remainingMs(
        props.state.session.startedAt,
        props.state.session.timeLimitSec,
        props.state.session.serverNow,
        now.value,
        props.state.session.pausedAt,
      ),
)
const clock = computed(() => (deadline.value === null ? '' : formatClock(deadline.value)))
const expired = computed(() => deadline.value !== null && deadline.value <= 0)
const paused = computed(() => props.state.session.status === 'paused')
const hasLimit = computed(() => props.state.session.timeLimitSec !== null)

function optionsOf(question: StudentQuestion): PaperOption[] {
  return paperOptions(question)
}

function responseFor(question: StudentQuestion): QuestionResponse {
  const existing = responses.value[question.id]
  if (existing) return existing
  const created = emptyResponses([question])[question.id]
  if (!created) throw new Error('missing response slot')
  responses.value[question.id] = created
  return created
}

/**
 * What each answer cost: how long the question was on screen, and how many times
 * they went back on it. The teacher's detail view is the only reader.
 */
const timing = useQuestionTiming()

// The question on screen is the one the clock runs on. A paper shown all at
// once has no such question, so no time is measured at all - which the detail
// view says with a dash rather than pretending it was instant.
watch(
  [paged, page],
  () => {
    timing.setCurrent(paged.value ? (current.value?.id ?? null) : null)
  },
  { immediate: true },
)

function onAnswer(questionId: string, response: QuestionResponse): void {
  responses.value[questionId] = response
  timing.noteChange(questionId)
}

async function send(): Promise<void> {
  if (submitting.value) return
  const ok = await confirm({
    message: t('student.runner.submitConfirm', { answered: answered.value, total: questions.value.length }),
  })
  if (!ok) return
  submitting.value = true
  try {
    const outcome = await submitSession(
      props.state.session.id,
      buildAnswers(questions.value, responses.value),
      timing.snapshot(),
    )
    // `released` is false when the teacher holds the results: the paper was
    // graded, but the student is not shown how they did yet.
    emit('submitted', props.state.session.id, outcome.released)
  } catch (error) {
    toast.error(
      error instanceof ApiError && error.code === 'CONFLICT'
        ? t('student.errors.alreadySubmitted')
        : t('student.errors.submitFailed'),
    )
  } finally {
    submitting.value = false
  }
}

watch(
  () => props.state.questions,
  (next) => {
    responses.value = emptyResponses(next)
  },
)

// How far the student is, for the teacher's board: the page in paged mode, and
// how many were answered either way.
watch(
  [answered, page],
  ([count, index]) => props.reportProgress?.(paged.value ? index : 0, count),
  { immediate: true },
)

onMounted(() => {
  ticker = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

// A zero on the clock submits whatever is on the paper, exactly like the
// server-side sweep does when the teacher forgets to end the session.
watch(expired, (isExpired) => {
  if (isExpired && !submitting.value) void send()
})

onBeforeUnmount(() => {
  if (ticker !== undefined) window.clearInterval(ticker)
})
</script>

<template>
  <section class="space-y-4">
    <div
      class="sticky top-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-2 border-b border-outline-variant bg-surface-container px-4 py-3 sm:-mx-0 sm:rounded-2xl sm:border"
    >
      <div class="min-w-0">
        <p class="truncate text-sm font-semibold text-on-surface">
          {{ t('student.runner.progress', { answered, total: questions.length }) }}
        </p>
        <p class="text-xs text-on-surface-variant">
          {{ t('student.runner.points', { points: totalPoints }) }}
        </p>
      </div>
      <p
        v-if="hasLimit"
        class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-sm font-bold tabular-nums"
        :class="
          expired
            ? 'bg-error-container text-on-error-container'
            : deadline !== null && deadline < 60_000
              ? 'bg-warning-container text-on-warning-container'
              : 'bg-surface-container-highest text-on-surface'
        "
        :aria-label="t('student.runner.timeLeft')"
      >
        <Clock class="size-3.5" aria-hidden="true" />
        {{ clock }}
      </p>
    </div>

    <p
      v-if="paused"
      role="status"
      class="flex items-center gap-2 rounded-xl bg-warning-container px-3 py-2 text-sm text-on-warning-container"
    >
      <TriangleAlert class="size-4 shrink-0" aria-hidden="true" />
      {{ t('student.runner.paused') }}
    </p>

    <p
      v-if="props.leftOnce"
      role="status"
      class="flex items-center gap-2 rounded-xl bg-surface-container-high px-3 py-2 text-xs text-on-surface-variant"
    >
      <TriangleAlert class="size-3.5 shrink-0" aria-hidden="true" />
      {{ t('student.runner.leftWarning') }}
    </p>

    <!-- One question at a time: a pager above, a single card below. -->
    <template v-if="paged && current">
      <p class="text-xs text-on-surface-variant" role="status">
        {{ t('student.paged.of', { current: page + 1, total: questions.length }) }}
      </p>
      <AppCard as="section">
        <div class="flex items-start justify-between gap-3">
          <p class="text-sm font-semibold text-on-surface">
            {{ page + 1 }}. {{ current.body }}
          </p>
          <span
            class="shrink-0 rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-semibold text-on-surface-variant"
          >
            {{ t('teacher.editor.points') }}: {{ current.points }}
          </span>
        </div>
        <QuestionAnswerInput
          class="mt-3"
          :question="current"
          :options="optionsOf(current)"
          :choices="matchingChoices(current)"
          :model-value="responseFor(current)"
          @update:model-value="onAnswer(current.id, $event)"
        />
      </AppCard>

      <div class="flex flex-wrap items-center gap-2">
        <AppButton v-if="allowBack && page > 0" variant="secondary" @click="page -= 1">
          {{ t('student.paged.back') }}
        </AppButton>
        <AppButton v-if="!onLastPage" variant="primary" class="ml-auto" @click="page += 1">
          {{ t('student.paged.next') }}
        </AppButton>
      </div>
    </template>

    <ol v-else class="space-y-3">
      <AppCard as="li" v-for="(question, index) in questions" :key="question.id">
        <div class="flex items-start justify-between gap-3">
          <p class="text-sm font-semibold text-on-surface">
            {{ index + 1 }}. {{ question.body }}
          </p>
          <span
            class="shrink-0 rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-semibold text-on-surface-variant"
          >
            {{ t('teacher.editor.points') }}: {{ question.points }}
          </span>
        </div>
        <QuestionAnswerInput
          class="mt-3"
          :question="question"
          :options="optionsOf(question)"
          :choices="matchingChoices(question)"
          :model-value="responseFor(question)"
          @update:model-value="onAnswer(question.id, $event)"
        />
      </AppCard>
    </ol>

    <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p class="text-xs text-on-surface-variant">
        {{ t('student.runner.hint') }}
      </p>
      <AppButton variant="success" class="rounded-xl" :disabled="submitting" @click="send">
        <Check v-if="expired" class="size-4" aria-hidden="true" />
        <Send v-else class="size-4" aria-hidden="true" />
        {{ submitting ? t('common.loading') : t('student.runner.submit') }}
      </AppButton>
    </div>
  </section>
</template>
