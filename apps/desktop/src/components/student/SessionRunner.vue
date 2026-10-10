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
  remainingMs,
  type QuestionResponse,
  type Responses,
} from '../../student/sessionLogic'
import { useConfirm } from '../../composables/confirm'
import { useToast } from '../../composables/toast'
import QuestionAnswerInput from './QuestionAnswerInput.vue'
import AppButton from '../../components/common/AppButton.vue'
import AppCard from '../../components/common/AppCard.vue'

const props = defineProps<{
  state: SessionState
}>()

const emit = defineEmits<{ submitted: [sessionId: string] }>()

const { t } = useI18n()
const confirm = useConfirm()
const toast = useToast()

const questions = computed<StudentQuestion[]>(() => props.state.questions)
const responses = ref<Responses>(emptyResponses(props.state.questions))
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
      ),
)
const clock = computed(() => (deadline.value === null ? '' : formatClock(deadline.value)))
const expired = computed(() => deadline.value !== null && deadline.value <= 0)
const paused = computed(() => props.state.session.status === 'paused')
const hasLimit = computed(() => props.state.session.timeLimitSec !== null)

function optionsOf(question: StudentQuestion): Array<{ key: string; text: string }> {
  const options = Array.isArray(question.payload.options) ? question.payload.options : []
  return options.flatMap((option) =>
    typeof option === 'object' && option !== null && 'key' in option && 'text' in option
      ? [{ key: String(option.key), text: String(option.text) }]
      : [],
  )
}

function responseFor(question: StudentQuestion): QuestionResponse {
  const existing = responses.value[question.id]
  if (existing) return existing
  const created = emptyResponses([question])[question.id]
  if (!created) throw new Error('missing response slot')
  responses.value[question.id] = created
  return created
}

async function send(): Promise<void> {
  if (submitting.value) return
  const ok = await confirm({
    message: t('student.runner.submitConfirm', { answered: answered.value, total: questions.value.length }),
  })
  if (!ok) return
  submitting.value = true
  try {
    await submitSession(
      props.state.session.id,
      buildAnswers(questions.value, responses.value),
    )
    emit('submitted', props.state.session.id)
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

    <ol class="space-y-3">
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
          @update:model-value="responses[question.id] = $event"
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
