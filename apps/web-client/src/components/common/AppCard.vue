<script setup lang="ts">
import { computed } from 'vue'

/**
 * The one card in the system. `rounded-2xl border border-outline-variant
 * bg-surface-container p-4` was written out 24 times, half of them with
 * `rounded-xl` instead, which is not a difference anyone chose on purpose.
 */
const props = withDefaults(
  defineProps<{
    /** surface: the standard raised card · plain: no border, for a card inside a card */
    tone?: 'surface' | 'plain' | 'dashed'
    /** md is the standard padding; sm is for dense rows; none leaves it to the caller. */
    padding?: 'md' | 'sm' | 'lg' | 'none'
    /** Lifts the card on hover - used where the whole card is the click target. */
    interactive?: boolean
    /** Set when the card itself is the control, so it must be a real button. */
    as?: string
    class?: string
  }>(),
  { tone: 'surface', padding: 'md', interactive: false, as: 'div' },
)

const TONES = {
  surface: 'border border-outline-variant bg-surface-container',
  plain: 'bg-surface',
  dashed: 'border border-dashed border-outline-variant bg-surface-container',
} as const

const PADDING = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
} as const

const classes = computed(() =>
  [
    'rounded-2xl',
    TONES[props.tone],
    PADDING[props.padding],
    // Interactive cards lift a little: M3 Expressive uses motion to point at
    // the thing that responds, and the spring makes the return feel physical.
    props.interactive
      ? 'state-layer cursor-pointer'
      : '',
    props.class ?? '',
  ]
    .filter(Boolean)
    .join(' '),
)
</script>

<template>
  <component :is="as" :class="classes">
    <slot />
  </component>
</template>