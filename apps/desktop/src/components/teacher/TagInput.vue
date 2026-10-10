<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from '@lucide/vue'

/**
 * A row of labels with a field to add one.
 *
 * Typing a word and pressing Enter (or comma, or clicking away) adds a label;
 * the x on a chip removes it. There is no "create this first?" step: a label is
 * a word the teacher typed, and whether it already exists is the server's
 * business, not the teacher's.
 *
 * The component owns nothing but the text in the field. It emits the whole list
 * on every change and the parent saves it, so what is on screen and what is
 * stored cannot drift: the parent writes back what the server said it kept.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string[]
    placeholder?: string
    label?: string
  }>(),
  { placeholder: '', label: '' },
)

const emit = defineEmits<{ 'update:modelValue': [string[]] }>()

const { t } = useI18n()
const draft = ref('')
const inputRef = ref<HTMLInputElement | null>(null)

const names = computed(() => props.modelValue)

function add(): void {
  const value = draft.value.trim().replace(/,+$/, '')
  draft.value = ''
  if (value === '') return
  // One label is one label: "Algebra" typed twice is still one.
  if (names.value.some((name) => name.toLowerCase() === value.toLowerCase())) return
  emit('update:modelValue', [...names.value, value])
}

function remove(name: string): void {
  emit('update:modelValue', names.value.filter((entry) => entry !== name))
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' || event.key === ',') {
    // Enter must not submit the form this field happens to sit in.
    event.preventDefault()
    add()
  } else if (event.key === 'Backspace' && draft.value === '' && names.value.length > 0) {
    // Backspace on an empty field removes the last label, as everywhere else.
    names.value.slice(-1).forEach((name) => remove(name))
  }
}

async function focusInput(): Promise<void> {
  await nextTick()
  inputRef.value?.focus()
}
</script>

<template>
  <div>
    <p v-if="label" class="text-xs font-semibold text-on-surface-variant">{{ label }}</p>
    <div
      class="mt-1 flex flex-wrap items-center gap-1.5 rounded-xl border border-outline bg-surface px-2 py-1.5 focus-within:border-primary"
      @click="focusInput"
    >
      <span
        v-for="name in names"
        :key="name"
        class="state-layer inline-flex items-center gap-1 rounded-full bg-secondary-container py-0.5 pl-2.5 pr-1 text-[11px] font-semibold text-on-secondary-container"
      >
        {{ name }}
        <button
          type="button"
          class="grid size-4 place-items-center rounded-full"
          :aria-label="t('teacher.tags.remove', { name })"
          @click.stop="remove(name)"
        >
          <X class="size-3" aria-hidden="true" />
        </button>
      </span>
      <input
        ref="inputRef"
        v-model="draft"
        type="text"
        class="min-w-24 flex-1 bg-transparent text-sm outline-none"
        :placeholder="names.length === 0 ? (placeholder || t('teacher.tags.placeholder')) : ''"
        :aria-label="t('teacher.tags.label')"
        @keydown="onKeydown"
        @blur="add"
      />
    </div>
  </div>
</template>