<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowLeft,
  BarChart3,
  ClipboardList,
  Percent,
  Printer,
  Timer,
  TrendingDown,
  TrendingUp,
  Trophy,
  Users,
} from '@lucide/vue'
import type { TestResults } from '../../api/tests'
import AppButton from '../../components/common/AppButton.vue'
import AppCard from '../../components/common/AppCard.vue'

const props = defineProps<{
  test: { id: string; title: string; passingPercent: number | null }
  results: TestResults
}>()

const emit = defineEmits<{ back: [] }>()

const { t } = useI18n()

/** Questions where at least half the class got it wrong: the teaching candidates. */
const weakQuestions = computed(() =>
  props.results.questions
    .filter((question) => question.answers > 0 && question.percent < 50)
    .sort((left, right) => left.percent - right.percent),
)

/**
 * The headline numbers, in the same tile shape the Live board uses: icon and
 * label above, the figure below, colour only where the figure itself means
 * something.
 */
const cards = computed(() => [
  {
    key: 'students',
    value: props.results.students,
    icon: Users,
    tone: 'text-on-surface',
  },
  {
    key: 'attempts',
    value: props.results.submissions,
    icon: ClipboardList,
    tone: 'text-on-surface',
  },
  {
    key: 'average',
    value: `${props.results.averagePercent}%`,
    icon: Percent,
    tone: 'text-primary',
  },
  {
    key: 'passRate',
    value: props.results.passRate === null ? '—' : `${props.results.passRate}%`,
    icon: Trophy,
    tone: props.results.passRate === null ? 'text-on-surface' : 'text-success',
  },
])

function formatType(type: string): string {
  return t(`teacher.types.${type}`)
}

/**
 * How long the class sat on a question, or nothing at all: a paper shown all at
 * once has no single question on screen, so there is no time to average and the
 * row says so rather than showing a zero.
 */
function formatAverage(ms: number | null): string {
  if (ms === null) return ''
  if (ms < 1000) return t('teacher.participantDetail.underASecond')
  if (ms < 60_000) {
    return t('teacher.participantDetail.seconds', { seconds: Math.round(ms / 1000) })
  }
  return t('teacher.participantDetail.minutesSeconds', {
    minutes: Math.floor(ms / 60_000),
    seconds: Math.round((ms % 60_000) / 1000),
  })
}

/** Hands the report to the browser's own print dialog: no PDF dependency needed. */
function printReport(): void {
  window.print()
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-2">
      <AppButton variant="ghost" @click="emit('back')">
        <ArrowLeft class="size-4" aria-hidden="true" />
        {{ t('teacher.results.back') }}
      </AppButton>
      <div class="flex items-center gap-2">
        <AppButton variant="secondary" @click="printReport">
          <Printer class="size-3.5" aria-hidden="true" />
          {{ t('teacher.results.print') }}
        </AppButton>
      </div>
    </div>

    <header>
      <h3 class="flex items-center gap-2 text-base font-semibold text-on-surface">
        <BarChart3 class="size-4" aria-hidden="true" />
        {{ test.title }}
      </h3>
      <p class="mt-0.5 text-xs text-on-surface-variant">
        {{
          test.passingPercent === null
            ? t('teacher.results.noPassMark')
            : t('teacher.results.passMark', { percent: test.passingPercent })
        }}
      </p>
    </header>

    <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div
        v-for="card in cards"
        :key="card.key"
        class="rounded-xl border border-outline-variant bg-surface-container px-3 py-2.5"
      >
        <span
          class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant"
        >
          <component :is="card.icon" class="size-3.5" aria-hidden="true" />
          {{ t(`teacher.results.card.${card.key}`) }}
        </span>
        <p class="mt-1 text-2xl font-semibold tabular-nums" :class="card.tone">
          {{ card.value }}
        </p>
      </div>
    </div>

    <section v-if="weakQuestions.length > 0" class="rounded-2xl border border-outline bg-warning-container p-4">
      <h4 class="flex items-center gap-2 text-sm font-semibold text-on-warning-container">
        <TrendingDown class="size-4" aria-hidden="true" />
        {{ t('teacher.results.weakHeading') }}
      </h4>
      <ul class="mt-2 space-y-1.5">
        <li
          v-for="question in weakQuestions"
          :key="question.questionId"
          class="rounded-xl bg-surface px-3 py-2 text-sm text-on-surface"
        >
          <p class="font-semibold">{{ question.body }}</p>
          <p class="mt-0.5 text-xs text-on-surface-variant">
            {{ t('teacher.results.weakLine', {
              percent: question.percent,
              correct: question.correct,
              answers: question.answers,
            }) }}
          </p>
        </li>
      </ul>
    </section>

    <AppCard as="section">
      <h4 class="flex items-center gap-2 text-sm font-semibold text-on-surface">
        <TrendingUp class="size-4" aria-hidden="true" />
        {{ t('teacher.results.journal') }}
      </h4>

      <p v-if="results.journal.length === 0" class="mt-2 text-xs text-on-surface-variant">
        {{ t('teacher.results.emptyJournal') }}
      </p>

      <ul v-else class="mt-3 space-y-1.5">
        <li
          v-for="row in results.journal"
          :key="row.userId"
          class="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface px-3 py-2 text-sm"
        >
          <span class="min-w-0 flex-1">
            <span class="block truncate font-semibold text-on-surface">
              {{ row.fullName || row.username }}
            </span>
            <span class="block text-xs text-on-surface-variant">
              {{ t('teacher.results.journalLine', {
                attempts: row.attempts,
                best: row.bestPercent,
                average: row.averagePercent,
              }) }}
            </span>
          </span>
          <span class="flex shrink-0 items-center gap-2">
            <span
              v-if="row.lastPassed !== null"
              class="rounded-full px-2 py-0.5 text-[11px] font-semibold"
              :class="
                row.lastPassed
                  ? 'bg-success-container text-on-success-container'
                  : 'bg-error-container text-on-error-container'
              "
            >
              {{ row.lastPassed ? t('teacher.results.passed') : t('teacher.results.failed') }}
            </span>
            <span class="text-base font-bold tabular-nums text-on-surface">
              {{ row.lastPercent }}%
            </span>
          </span>
        </li>
      </ul>
    </AppCard>

    <AppCard as="section">
      <h4 class="text-sm font-semibold text-on-surface">{{ t('teacher.results.byQuestion') }}</h4>

      <p
        v-if="results.questions.length === 0"
        class="mt-2 text-xs text-on-surface-variant"
      >
        {{ t('teacher.results.emptyQuestions') }}
      </p>

      <ul v-else class="mt-3 space-y-1.5">
        <li
          v-for="question in results.questions"
          :key="question.questionId"
          class="rounded-xl bg-surface px-3 py-2 text-sm"
        >
          <div class="flex items-start justify-between gap-2">
            <p class="min-w-0 flex-1 text-on-surface">
              <span class="text-xs text-on-surface-variant">{{ formatType(question.type) }} ·</span>
              {{ question.body }}
            </p>
            <span class="shrink-0 text-xs font-semibold tabular-nums text-on-surface">
              {{ question.percent }}%
            </span>
          </div>
          <div class="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-container-highest">
            <div
              class="h-full rounded-full"
              :class="question.percent >= 50 ? 'bg-success' : 'bg-warning'"
              :style="{ width: `${question.percent}%` }"
              data-print-keep
            />
          </div>
          <div
            v-if="question.answers > 0"
            class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-on-surface-variant"
          >
            <span>
              {{ t('teacher.results.questionLine', {
                correct: question.correct,
                answers: question.answers,
                points: question.points,
              }) }}
            </span>
            <!-- A question that is both hard and slow is the one worth teaching
                 again, and the two facts only meet here. -->
            <span
              v-if="formatAverage(question.averageMs) !== ''"
              class="inline-flex items-center gap-1"
            >
              <Timer class="size-3" aria-hidden="true" />
              {{ t('teacher.results.averageTime', { time: formatAverage(question.averageMs) }) }}
            </span>
          </div>
        </li>
      </ul>
    </AppCard>
  </div>
</template>
