<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeftRight, Check, X } from '@lucide/vue'
import { buildQuestions, type QuestionForm } from './questionForm'
import { useDialogFocus } from '../../composables/focusTrap'
import type { QuestionInput } from '../../api/types'
import AppButton from '../../components/common/AppButton.vue'
import MediaFigure from '../common/MediaFigure.vue'

const props = defineProps<{
  open: boolean
  title: string
  description: string
  timeLimitMin: string
  passingPercent: string
  forms: QuestionForm[]
}>()

const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const panelRef = ref<HTMLElement | null>(null)
const closeRef = ref<HTMLButtonElement | null>(null)

useDialogFocus(
  () => props.open,
  () => emit('close'),
  panelRef,
  closeRef,
)

const built = computed(() => buildQuestions(props.forms))
const questions = computed<QuestionInput[]>(() =>
  typeof built.value === 'string' ? [] : built.value,
)
const buildError = computed(() =>
  typeof built.value === 'string' ? t(`teacher.form.err.${built.value}`) : '',
)
const totalPoints = computed(() =>
  questions.value.reduce((sum, question) => sum + question.points, 0),
)

interface PreviewMedia {
  assetId?: string
}

interface PreviewOption {
  key: string
  text: string
  image?: PreviewMedia
}

interface PreviewPair {
  left: string
  right: string
  leftImage?: PreviewMedia
  rightImage?: PreviewMedia
}

interface PreviewPayload {
  media?: PreviewMedia
  options?: PreviewOption[]
  correct?: string | string[] | boolean
  accepted?: string[]
  pairs?: PreviewPair[]
}

function payloadOf(question: QuestionInput): PreviewPayload {
  return question.payload as PreviewPayload
}

/** The id out of a media reference, or null where there is no picture. */
function mediaId(value: PreviewMedia | undefined): string | null {
  return typeof value?.assetId === 'string' && value.assetId !== '' ? value.assetId : null
}

function optionsOf(question: QuestionInput): PreviewOption[] {
  return payloadOf(question).options ?? []
}

function isCorrectOption(question: QuestionInput, key: string): boolean {
  const correct = payloadOf(question).correct
  if (Array.isArray(correct)) return correct.includes(key)
  return correct === key
}

function isCorrectBoolean(question: QuestionInput, value: boolean): boolean {
  return payloadOf(question).correct === value
}

function acceptedOf(question: QuestionInput): string[] {
  return payloadOf(question).accepted ?? []
}

function pairsOf(question: QuestionInput): PreviewPair[] {
  return payloadOf(question).pairs ?? []
}

const chipClass =
  'rounded-full bg-primary-container px-2.5 py-0.5 text-xs font-semibold text-on-primary-container'
const optionBaseClass = 'flex items-center gap-2 rounded-xl px-3 py-2 text-sm'
const correctClass = 'bg-success-container font-semibold text-on-success-container'
const plainClass = 'bg-surface-container-high text-on-surface'
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      :aria-label="t('teacher.tests.previewTitle')"
    >
      <div class="absolute inset-0 bg-scrim" @click="emit('close')" />
      <div
        ref="panelRef"
        class="relative flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-surface-container shadow-xl"
      >
        <header class="flex items-start justify-between gap-3 border-b border-outline-variant p-4">
          <div class="min-w-0">
            <h3 class="truncate text-base font-semibold text-on-surface">
              {{ title || t('teacher.tests.previewUntitled') }}
            </h3>
            <p v-if="description" class="mt-0.5 text-sm text-on-surface-variant">
              {{ description }}
            </p>
          </div>
          <AppButton
  variant="ghost"
  class="shrink-0"
  ref="closeRef"
  :aria-label="t('common.close')"
  @click="emit('close')"
>
            <X class="size-4" aria-hidden="true" />
          </AppButton>
        </header>

        <div v-if="!buildError" class="flex flex-wrap gap-2 px-4 pt-3">
          <span :class="chipClass">
            {{ t('teacher.tests.questionCount', { count: questions.length }) }}
          </span>
          <span :class="chipClass">
            {{ t('teacher.tests.totalPoints', { count: totalPoints }) }}
          </span>
          <span v-if="timeLimitMin" :class="chipClass">
            {{ t('teacher.tests.timeLimit') }}: {{ timeLimitMin }}
            {{ t('teacher.tests.minutes') }}
          </span>
          <span v-if="passingPercent" :class="chipClass">
            {{ t('teacher.tests.passing', { percent: passingPercent }) }}
          </span>
        </div>

        <div class="flex-1 overflow-y-auto p-4">
          <p
            v-if="buildError"
            role="alert"
            class="rounded-xl bg-error-container px-3 py-2 text-sm text-on-error-container"
          >
            {{ buildError }}
          </p>

          <ol v-else class="space-y-3">
            <li
              v-for="(question, index) in questions"
              :key="index"
              class="rounded-xl bg-surface p-4"
            >
              <div class="flex items-start justify-between gap-3">
                <p class="text-sm font-semibold text-on-surface">
                  {{ index + 1 }}. {{ question.body }}
                </p>
                <span
                  class="shrink-0 rounded-full bg-warning-container px-2 py-0.5 text-[11px] font-semibold text-on-warning-container"
                >
                  {{ t('teacher.editor.points') }}: {{ question.points }}
                </span>
              </div>

              <!-- The diagram is part of the question, so it is shown with the
                   question and not folded into the answer list below it. -->
              <MediaFigure
                v-if="mediaId(payloadOf(question).media) !== null"
                class="mt-3"
                :asset-id="mediaId(payloadOf(question).media)"
                :label="question.body"
              />

              <ul v-if="question.type === 'single_choice' || question.type === 'multiple_choice'" class="mt-3 space-y-1.5">
                <li
                  v-for="option in optionsOf(question)"
                  :key="option.key"
                  :class="[optionBaseClass, isCorrectOption(question, option.key) ? correctClass : plainClass]"
                >
                  <Check v-if="isCorrectOption(question, option.key)" class="size-4 shrink-0" aria-hidden="true" />
                  <span class="min-w-0 flex-1">
                    <span class="block">{{ option.text }}</span>
                    <MediaFigure
                      v-if="mediaId(option.image) !== null"
                      class="mt-1.5"
                      :asset-id="mediaId(option.image)"
                      :label="option.text"
                      size="sm"
                    />
                  </span>
                </li>
              </ul>

              <div
                v-else-if="question.type === 'true_false'"
                class="mt-3 flex flex-wrap gap-1.5"
              >
                <span
                  v-for="value in [true, false]"
                  :key="String(value)"
                  :class="[optionBaseClass, isCorrectBoolean(question, value) ? correctClass : plainClass]"
                >
                  <Check v-if="isCorrectBoolean(question, value)" class="size-4 shrink-0" aria-hidden="true" />
                  {{ value ? t('teacher.editor.trueValue') : t('teacher.editor.falseValue') }}
                </span>
              </div>

              <div v-else-if="question.type === 'short_answer'" class="mt-3 space-y-1.5">
                <p class="text-xs font-semibold text-on-surface-variant">
                  {{ t('teacher.editor.accepted') }}
                </p>
                <p
                  v-for="(answer, answerIndex) in acceptedOf(question)"
                  :key="answerIndex"
                  :class="[optionBaseClass, correctClass]"
                >
                  <Check class="size-4 shrink-0" aria-hidden="true" />
                  {{ answer }}
                </p>
              </div>

              <ul v-else class="mt-3 space-y-1.5">
                <li
                  v-for="(pair, pairIndex) in pairsOf(question)"
                  :key="pairIndex"
                  :class="[optionBaseClass, correctClass]"
                >
                  <Check class="size-4 shrink-0" aria-hidden="true" />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate">{{ pair.left }}</span>
                    <MediaFigure
                      v-if="mediaId(pair.leftImage) !== null"
                      class="mt-1.5"
                      :asset-id="mediaId(pair.leftImage)"
                      :label="pair.left"
                      size="sm"
                    />
                  </span>
                  <ArrowLeftRight class="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate">{{ pair.right }}</span>
                    <MediaFigure
                      v-if="mediaId(pair.rightImage) !== null"
                      class="mt-1.5"
                      :asset-id="mediaId(pair.rightImage)"
                      :label="pair.right"
                      size="sm"
                    />
                  </span>
                </li>
              </ul>
            </li>
          </ol>
        </div>

        <footer class="border-t border-outline-variant p-4">
          <AppButton variant="primary" class="sm:w-auto" @click="emit('close')">
            {{ t('common.close') }}
          </AppButton>
        </footer>
      </div>
    </div>
  </Teleport>
</template>