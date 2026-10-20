<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Award, CircleCheck, CircleX, Trophy } from '@lucide/vue'
import type { GradedQuestion, SessionResultBody } from '../../api/sessions'
import AppCard from '../../components/common/AppCard.vue'

const props = defineProps<{
  result: SessionResultBody
}>()

const { t } = useI18n()

const participation = computed(() => props.result.participation)
const percent = computed(() => participation.value.percent ?? 0)
const hasPassMark = computed(() => (props.result.test?.passingPercent ?? null) !== null)
// Without a pass mark the server sends passed: null - that is "no verdict", not a fail.
const verdict = computed<'passed' | 'failed' | 'none'>(() => {
  if (!hasPassMark.value) return 'none'
  return participation.value.passed === true ? 'passed' : 'failed'
})
const panelClass = computed(() =>
  verdict.value === 'passed'
    ? 'bg-success-container'
    : verdict.value === 'failed'
      ? 'bg-error-container'
      : 'bg-primary-container',
)
const textClass = computed(() =>
  verdict.value === 'passed'
    ? 'text-on-success-container'
    : verdict.value === 'failed'
      ? 'text-on-error-container'
      : 'text-on-primary-container',
)

function optionsOf(question: GradedQuestion): Array<{ key: string; text: string }> {
  const options = Array.isArray(question.payload.options) ? question.payload.options : []
  return options.flatMap((option) =>
    typeof option === 'object' && option !== null && 'key' in option && 'text' in option
      ? [{ key: String(option.key), text: String(option.text) }]
      : [],
  )
}

function correctKeys(question: GradedQuestion): string[] {
  const correct = question.payload.correct
  if (typeof correct === 'string') return [correct]
  if (Array.isArray(correct)) return correct.filter((entry): entry is string => typeof entry === 'string')
  return []
}

function isChosen(question: GradedQuestion, key: string): boolean {
  const correct = correctKeys(question)
  return correct.includes(key)
}

function acceptedOf(question: GradedQuestion): string[] {
  const accepted = question.payload.accepted
  return Array.isArray(accepted) ? accepted.filter((entry): entry is string => typeof entry === 'string') : []
}

function trueFalseAnswer(question: GradedQuestion): boolean | null {
  return typeof question.payload.correct === 'boolean' ? question.payload.correct : null
}
</script>

<template>
  <section class="space-y-4">
    <div
      class="rounded-2xl border border-outline-variant p-4"
      :class="panelClass"
    >
      <div class="flex items-center gap-2">
        <Trophy v-if="verdict === 'passed'" class="size-5 shrink-0" aria-hidden="true" />
        <Award v-else-if="verdict === 'failed'" class="size-5 shrink-0" aria-hidden="true" />
        <CircleCheck v-else class="size-5 shrink-0" aria-hidden="true" />
        <h3 class="text-base font-semibold" :class="textClass">
          {{ t(`student.result.${verdict}`) }}
        </h3>
      </div>
      <p class="mt-2 text-3xl font-bold tabular-nums" :class="textClass">
        {{ percent }}%
      </p>
      <p class="mt-1 text-sm" :class="textClass">
        {{ t('student.result.score', { score: participation.score ?? 0, max: participation.maxScore ?? 0 }) }}
        <span v-if="hasPassMark && result.test">
          · {{ t('student.result.passMark', { percent: result.test.passingPercent ?? 0 }) }}
        </span>
      </p>
      <p
        v-if="participation.status === 'auto_submitted'"
        class="mt-2 rounded-xl bg-surface/60 px-3 py-2 text-xs"
        :class="textClass"
      >
        {{ t('student.result.autoSubmitted') }}
      </p>
    </div>

    <ol class="space-y-3">
      <AppCard as="li" v-for="(question, index) in result.questions" :key="question.id">
        <div class="flex items-start justify-between gap-3">
          <h3 class="min-w-0 break-words text-base font-semibold text-on-surface">
            {{ index + 1 }}. {{ question.body }}
          </h3>
          <span
            class="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
            :class="
              question.isCorrect
                ? 'bg-success-container text-on-success-container'
                : 'bg-error-container text-on-error-container'
            "
          >
            <CircleCheck v-if="question.isCorrect" class="size-3" aria-hidden="true" />
            <CircleX v-else class="size-3" aria-hidden="true" />
            {{ question.pointsAwarded }} / {{ question.points }}
          </span>
        </div>

        <ul
          v-if="question.type === 'single_choice' || question.type === 'multiple_choice'"
          class="mt-3 space-y-1.5"
        >
          <!-- Both states carry the outline: the correct option is the one that
               is filled, and the rest still have to read as options. -->
          <li
            v-for="option in optionsOf(question)"
            :key="option.key"
            class="flex items-center gap-2 rounded-xl border border-outline-variant px-3 py-2 text-sm"
            :class="
              isChosen(question, option.key)
                ? 'bg-success-container font-semibold text-on-success-container'
                : 'bg-surface text-on-surface'
            "
          >
            <CircleCheck v-if="isChosen(question, option.key)" class="size-4 shrink-0" aria-hidden="true" />
            <span class="min-w-0 flex-1">{{ option.text }}</span>
          </li>
        </ul>

        <!-- The label and the value are two spans, and Vue condenses the
             whitespace between them away: "Правда / Хиба:Правда" had no space at
             all. The gap carries it, so it survives the compiler. -->
        <p v-else-if="question.type === 'true_false'" class="mt-3 flex flex-wrap items-baseline gap-1 text-sm">
          <span class="text-on-surface-variant">{{ t('teacher.editor.trueValue') }} / {{ t('teacher.editor.falseValue') }}:</span>
          <span class="font-semibold text-on-success-container">
            {{ trueFalseAnswer(question) === null ? '—' : trueFalseAnswer(question) ? t('teacher.editor.trueValue') : t('teacher.editor.falseValue') }}
          </span>
        </p>

        <div v-else-if="question.type === 'short_answer'" class="mt-3 space-y-1">
          <p class="text-xs text-on-surface-variant">{{ t('student.result.accepted') }}</p>
          <p
            v-for="(answer, answerIndex) in acceptedOf(question)"
            :key="answerIndex"
            class="rounded-xl bg-success-container px-3 py-1.5 text-sm text-on-success-container"
          >
            {{ answer }}
          </p>
        </div>

        <ul v-else class="mt-3 space-y-1.5">
          <li
            v-for="pair in (question.payload.pairs as Array<{ left: string; right: string }> | undefined) ?? []"
            :key="pair.left"
            class="flex items-center gap-2 rounded-xl bg-success-container px-3 py-1.5 text-sm text-on-success-container"
          >
            <span class="min-w-0 flex-1 truncate">{{ pair.left }}</span>
            <span class="opacity-70">→</span>
            <span class="min-w-0 flex-1 truncate">{{ pair.right }}</span>
          </li>
        </ul>
      </AppCard>
    </ol>
  </section>
</template>
