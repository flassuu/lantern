<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { StudentQuestion } from '../../api/sessions'
import type { QuestionResponse } from '../../student/sessionLogic'
import {
  isAnswered,
  pairMedia,
  paperMedia,
  paperMediaId,
  type PaperOption,
} from '../../student/sessionLogic'
import MediaFigure from '../common/MediaFigure.vue'

const props = defineProps<{
  question: StudentQuestion
  options: PaperOption[]
  choices: string[]
}>()

const response = defineModel<QuestionResponse>({ required: true })

const { t } = useI18n()

const pairs = computed(() => response.value.pairs ?? [])

/** The diagram in the question itself, if the paper carried one. */
const media = computed(() => paperMedia(props.question))

/** The picture on the left side of one matching row, if the paper carried one. */
function mediaOfRow(index: number): string | null {
  return pairMedia(props.question, index).left
}

/**
 * The picture drawn beside a right-hand value, if it has one - looked up by the
 * value alone, never by the row it sits in, so picking an answer shows what that
 * answer looks like and not which left side it belongs to.
 */
function imageOfChoice(value: string): string | null {
  if (value === '') return null
  const rows = Array.isArray(props.question.payload.pairs) ? props.question.payload.pairs : []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const candidate = row as Record<string, unknown>
    if (candidate.right !== value) continue
    const id = paperMediaId(candidate.rightImage)
    if (id !== null) return id
  }
  return null
}

function toggleKey(key: string): void {
  if (props.question.type === 'single_choice') {
    response.value = { ...response.value, keys: [key] }
    return
  }
  const has = response.value.keys.includes(key)
  response.value = {
    ...response.value,
    keys: has ? response.value.keys.filter((entry) => entry !== key) : [...response.value.keys, key],
  }
}

function setBoolean(value: boolean): void {
  response.value = { ...response.value, boolean: value }
}

function setText(text: string): void {
  response.value = { ...response.value, text }
}

function setPair(index: number, right: string): void {
  const next = pairs.value.map((pair, position) => (position === index ? { ...pair, right } : pair))
  response.value = { ...response.value, pairs: next }
}

const controlClass =
  'mt-1 w-full rounded-xl border border-outline bg-surface px-3 py-2 text-sm focus:border-primary'
</script>

<template>
  <div>
    <!-- The diagram is part of the question: it sits above the answers, where
         the text it illustrates already is. -->
    <MediaFigure
      v-if="media !== null"
      class="mb-3"
      :asset-id="media"
      :label="question.body"
    />

    <!-- single and multiple choice -->
    <ul v-if="question.type === 'single_choice' || question.type === 'multiple_choice'" class="space-y-1.5">
      <li v-for="option in options" :key="option.key">
        <!--
          A state layer, not a faded background: this is the control a student
          answers with, often quickly, and a colour fade on it repainted the row
          on every frame of the fade.
        -->
        <label
          class="state-layer flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-sm"
          :class="
            response.keys.includes(option.key)
              ? 'bg-primary-container font-semibold text-on-primary-container'
              : 'bg-surface text-on-surface'
          "
        >
          <input
            :type="question.type === 'single_choice' ? 'radio' : 'checkbox'"
            name="choice"
            :value="option.key"
            :checked="response.keys.includes(option.key)"
            class="size-4 shrink-0"
            @change="toggleKey(option.key)"
          />
          <span class="min-w-0 flex-1">
            <span class="block">{{ option.text }}</span>
            <!-- An option can be a drawing; the picture goes inside the row the
                 student taps, not below it, so what they tap is what they see. -->
            <MediaFigure
              v-if="option.image !== null"
              class="mt-1.5"
              :asset-id="option.image"
              :label="option.text"
              size="sm"
            />
          </span>
        </label>
      </li>
    </ul>

    <!-- true / false -->
    <div v-else-if="question.type === 'true_false'" class="flex flex-wrap gap-2">
      <button
        v-for="value in [true, false]"
        :key="String(value)"
        type="button"
        :aria-pressed="response.boolean === value"
        @click="setBoolean(value)"
        class="state-layer flex-1 rounded-xl px-3 py-2 text-sm font-semibold"
        :class="
          response.boolean === value
            ? 'bg-primary-container text-on-primary-container'
            : 'bg-surface text-on-surface'
        "
      >
        {{ value ? t('teacher.editor.trueValue') : t('teacher.editor.falseValue') }}
      </button>
    </div>

    <!-- free text -->
    <label v-else-if="question.type === 'short_answer'" class="block">
      <span class="sr-only">{{ t('teacher.editor.accepted') }}</span>
      <textarea
        :value="response.text"
        rows="2"
        :placeholder="t('student.runner.answerPlaceholder')"
        :aria-label="t('student.runner.answerLabel')"
        class="resize-y"
        :class="controlClass"
        @input="setText(($event.target as HTMLTextAreaElement).value)"
      />
    </label>

    <!-- matching -->
    <ul v-else class="space-y-1.5">
      <li v-for="(pair, index) in pairs" :key="pair.left" class="flex items-center gap-2">
        <span class="min-w-0 flex-1 rounded-xl bg-surface px-3 py-2 text-sm text-on-surface">
          <span class="block truncate">{{ pair.left }}</span>
          <MediaFigure
            v-if="mediaOfRow(index) !== null"
            class="mt-1.5"
            :asset-id="mediaOfRow(index)"
            :label="pair.left"
            size="sm"
          />
        </span>
        <span class="flex shrink-0 flex-col items-end gap-1.5">
          <MediaFigure
            v-if="imageOfChoice(pair.right) !== null"
            :asset-id="imageOfChoice(pair.right)"
            :label="pair.right"
            size="sm"
          />
          <select
            :value="pair.right"
            :aria-label="t('student.runner.matchLabel', { left: pair.left })"
            class="w-40 rounded-xl border border-outline bg-surface px-3 py-2 text-sm focus:border-primary"
            @change="setPair(index, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ t('student.runner.matchChoose') }}</option>
            <option v-for="choice in choices" :key="choice" :value="choice">{{ choice }}</option>
          </select>
        </span>
      </li>
    </ul>

    <p
      v-if="!isAnswered(question, response)"
      class="mt-2 text-xs text-on-surface-variant"
    >
      {{ t('student.runner.unanswered') }}
    </p>
  </div>
</template>
