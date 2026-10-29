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
 * When the caller knows the labels already in use, typing narrows them into a
 * list under the field: a vocabulary reused by hand drifts into "Python",
 * "python" and "Пайтон" within a week.
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
    /** Labels the teacher already has; the field narrows them as they type. */
    suggestions?: string[]
  }>(),
  { placeholder: '', label: '', suggestions: () => [] },
)

const emit = defineEmits<{ 'update:modelValue': [string[]] }>()

const { t } = useI18n()
const draft = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
/** The list is open only while the field has focus, so it cannot cover a form. */
const focused = ref(false)
const active = ref(-1)

const names = computed(() => props.modelValue)

/** Existing labels that still fit the text, minus the ones already on. */
const matches = computed(() => {
  const chosen = new Set(names.value.map((name) => name.toLowerCase()))
  const needle = draft.value.trim().toLowerCase()
  return props.suggestions
    .filter((name) => !chosen.has(name.toLowerCase()))
    .filter((name) => needle === '' || name.toLowerCase().includes(needle))
    .filter((name) => name.toLowerCase() !== needle)
    .slice(0, 6)
})

const showSuggestions = computed(() => focused.value && matches.value.length > 0)

function add(): void {
  const value = draft.value.trim().replace(/,+$/, '')
  draft.value = ''
  active.value = -1
  if (value === '') return
  // One label is one label: "Algebra" typed twice is still one.
  if (names.value.some((name) => name.toLowerCase() === value.toLowerCase())) return
  emit('update:modelValue', [...names.value, value])
}

function pick(name: string): void {
  draft.value = ''
  active.value = -1
  if (names.value.some((entry) => entry.toLowerCase() === name.toLowerCase())) return
  emit('update:modelValue', [...names.value, name])
}

function remove(name: string): void {
  emit('update:modelValue', names.value.filter((entry) => entry !== name))
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' && showSuggestions.value) {
    event.preventDefault()
    active.value = (active.value + 1) % matches.value.length
    return
  }
  if (event.key === 'ArrowUp' && showSuggestions.value) {
    event.preventDefault()
    active.value = active.value <= 0 ? matches.value.length - 1 : active.value - 1
    return
  }
  if (event.key === 'Escape') {
    focused.value = false
    return
  }
  if (event.key === 'Enter' || event.key === ',') {
    // Enter must not submit the form this field happens to sit in.
    event.preventDefault()
    const highlighted = showSuggestions.value ? matches.value[active.value] : undefined
    if (highlighted) pick(highlighted)
    else add()
  } else if (event.key === 'Backspace' && draft.value === '' && names.value.length > 0) {
    // Backspace on an empty field removes the last label, as everywhere else.
    names.value.slice(-1).forEach((name) => remove(name))
  }
}

async function focusInput(): Promise<void> {
  await nextTick()
  inputRef.value?.focus()
}

/** Leaving the field commits what was typed; the list closes with it. */
function onBlur(): void {
  focused.value = false
  add()
}
</script>

<template>
  <div class="relative">
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
        @focus="focused = true"
        @blur="onBlur"
      />
    </div>

    <!-- The list sits under the field, not over the form: it is a shortcut for
         the field, and the field is what the teacher is looking at. -->
    <ul
      v-if="showSuggestions"
      :aria-label="t('teacher.tags.suggestions')"
      class="absolute inset-x-0 top-full z-20 mt-1 max-h-44 overflow-y-auto rounded-xl border border-outline-variant bg-surface-container-high py-1"
    >
      <li v-for="(name, index) in matches" :key="name">
        <button
          type="button"
          class="state-layer block w-full px-3 py-1.5 text-left text-sm text-on-surface"
          :class="index === active ? 'bg-surface-container-highest' : ''"
          @mousedown.prevent="pick(name)"
          @mouseenter="active = index"
        >
          {{ name }}
        </button>
      </li>
    </ul>
  </div>
</template>