<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { TestSettings } from '../../api/types'

/**
 * The switches and segments a test's defaults and a run's options are made of.
 *
 * One component for both places, because they are the same six decisions: a test
 * stores its defaults, a run snapshots them, and the teacher may change the run
 * in the lobby. Two copies would drift the moment a seventh decision appeared.
 *
 * The switches are real `role="switch"` buttons rather than styled checkboxes:
 * a checkbox that is 14px tall is the one thing on the screen nobody can hit,
 * and the accessibility tree should say "switch", which is what it is.
 */
const props = defineProps<{
  modelValue: TestSettings
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [TestSettings] }>()

const { t } = useI18n()

function set<K extends keyof TestSettings>(key: K, value: TestSettings[K]): void {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}
</script>

<template>
  <div class="space-y-3">
    <!-- Booleans: a row each, with the switch on the right. -->
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-sm text-on-surface">{{ t('teacher.sessionSettings.shuffleQuestions') }}</p>
        <p class="mt-0.5 text-xs text-on-surface-variant">
          {{ t('teacher.sessionSettings.shuffleQuestionsHint') }}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        :aria-checked="modelValue.shuffleQuestions"
        :aria-label="t('teacher.sessionSettings.shuffleQuestions')"
        :disabled="disabled"
        class="state-layer mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border px-0.5 transition-colors duration-200 disabled:opacity-60"
        :class="
          modelValue.shuffleQuestions
            ? 'justify-end border-transparent bg-primary'
            : 'justify-start border-outline-variant bg-surface-container-high'
        "
        @click="set('shuffleQuestions', !modelValue.shuffleQuestions)"
      >
        <span
          class="size-5 rounded-full transition-transform duration-200"
          :class="modelValue.shuffleQuestions ? 'bg-on-primary' : 'bg-on-surface-variant'"
        />
      </button>
    </div>

    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-sm text-on-surface">{{ t('teacher.sessionSettings.shuffleOptions') }}</p>
        <p class="mt-0.5 text-xs text-on-surface-variant">
          {{ t('teacher.sessionSettings.shuffleOptionsHint') }}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        :aria-checked="modelValue.shuffleOptions"
        :aria-label="t('teacher.sessionSettings.shuffleOptions')"
        :disabled="disabled"
        class="state-layer mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border px-0.5 transition-colors duration-200 disabled:opacity-60"
        :class="
          modelValue.shuffleOptions
            ? 'justify-end border-transparent bg-primary'
            : 'justify-start border-outline-variant bg-surface-container-high'
        "
        @click="set('shuffleOptions', !modelValue.shuffleOptions)"
      >
        <span
          class="size-5 rounded-full transition-transform duration-200"
          :class="modelValue.shuffleOptions ? 'bg-on-primary' : 'bg-on-surface-variant'"
        />
      </button>
    </div>

    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-sm text-on-surface">{{ t('teacher.sessionSettings.allowBack') }}</p>
        <p class="mt-0.5 text-xs text-on-surface-variant">
          {{ t('teacher.sessionSettings.allowBackHint') }}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        :aria-checked="modelValue.allowBack"
        :aria-label="t('teacher.sessionSettings.allowBack')"
        :disabled="disabled || modelValue.questionsPerPage === 'all'"
        class="state-layer mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border px-0.5 transition-colors duration-200 disabled:opacity-60"
        :class="
          modelValue.allowBack && modelValue.questionsPerPage === 'one'
            ? 'justify-end border-transparent bg-primary'
            : 'justify-start border-outline-variant bg-surface-container-high'
        "
        @click="set('allowBack', !modelValue.allowBack)"
      >
        <span
          class="size-5 rounded-full transition-transform duration-200"
          :class="
            modelValue.allowBack && modelValue.questionsPerPage === 'one'
              ? 'bg-on-primary'
              : 'bg-on-surface-variant'
          "
        />
      </button>
    </div>

    <!-- Segments: two answers, one each. -->
    <div>
      <p class="text-sm text-on-surface">{{ t('teacher.sessionSettings.reveal') }}</p>
      <div class="mt-1.5 flex flex-wrap gap-1.5">
        <button
          v-for="option in (['after_submit', 'never'] as const)"
          :key="option"
          type="button"
          :disabled="disabled"
          class="inline-flex h-8 items-center rounded-full border px-3 text-xs font-semibold transition-colors duration-200 disabled:opacity-60"
          :class="
            modelValue.showCorrectAnswers === option
              ? 'border-transparent bg-primary text-on-primary'
              : 'border-outline-variant bg-surface-container-high text-on-surface-variant'
          "
          @click="set('showCorrectAnswers', option)"
        >
          {{ t(`teacher.sessionSettings.reveal${option === 'never' ? 'Never' : 'AfterSubmit'}`) }}
        </button>
      </div>
    </div>

    <div>
      <p class="text-sm text-on-surface">{{ t('teacher.sessionSettings.release') }}</p>
      <div class="mt-1.5 flex flex-wrap gap-1.5">
        <button
          v-for="option in (['immediate', 'teacher'] as const)"
          :key="option"
          type="button"
          :disabled="disabled"
          class="inline-flex h-8 items-center rounded-full border px-3 text-xs font-semibold transition-colors duration-200 disabled:opacity-60"
          :class="
            modelValue.releaseResults === option
              ? 'border-transparent bg-primary text-on-primary'
              : 'border-outline-variant bg-surface-container-high text-on-surface-variant'
          "
          @click="set('releaseResults', option)"
        >
          {{ t(`teacher.sessionSettings.release${option === 'teacher' ? 'Teacher' : 'Immediate'}`) }}
        </button>
      </div>
    </div>

    <div>
      <p class="text-sm text-on-surface">{{ t('teacher.sessionSettings.pages') }}</p>
      <div class="mt-1.5 flex flex-wrap gap-1.5">
        <button
          v-for="option in (['all', 'one'] as const)"
          :key="option"
          type="button"
          :disabled="disabled"
          class="inline-flex h-8 items-center rounded-full border px-3 text-xs font-semibold transition-colors duration-200 disabled:opacity-60"
          :class="
            modelValue.questionsPerPage === option
              ? 'border-transparent bg-primary text-on-primary'
              : 'border-outline-variant bg-surface-container-high text-on-surface-variant'
          "
          @click="set('questionsPerPage', option)"
        >
          {{ t(`teacher.sessionSettings.pages${option === 'one' ? 'One' : 'All'}`) }}
        </button>
      </div>
    </div>
  </div>
</template>
