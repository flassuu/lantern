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
    /**
     * Drops the top corners and the top border, so the card can sit directly
     * under a tab strip: the open tab hangs into the gap and its fill runs into
     * the card's, which is what makes the tab read as the top of the panel
     * rather than a label floating above it. A border across that seam is what
     * made the two look like separate boxes.
     */
    flushTop?: boolean
    class?: string
  }>(),
  { tone: 'surface', padding: 'md', interactive: false, as: 'div', flushTop: false },
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
    props.flushTop ? 'rounded-b-2xl border-t-0' : 'rounded-2xl',
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