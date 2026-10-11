<script setup lang="ts">
/**
 * The crest: the lantern, drawn from the artwork in `DESIGN/`.
 *
 * It is the mark on its own, without the purple tile - the tile is the app icon
 * (`DESIGN/logo-icon.svg`), and this is what sits in the header, the About dialog
 * and the server screen. `DESIGN/logo-full-dark.svg` and `-light.svg` are the same
 * geometry in the two theme colours, and both of those are the theme's `primary`,
 * so one copy with `currentColor` covers both: the caller colours it, and the
 * theme does the switching.
 *
 * The artwork's own grid is 93x128, portrait. It is placed inside a square viewBox
 * so every call site keeps the box it had - `size` is still the box, and the crest
 * is centred in it.
 */
const props = withDefaults(defineProps<{ size?: number; class?: string }>(), { size: 24 })
</script>

<template>
  <svg
    viewBox="0 0 128 128"
    :width="props.size"
    :height="props.size"
    :class="props.class"
    fill="none"
    role="img"
    aria-label="LANtern"
  >
    <g transform="translate(17.5 0)" stroke="currentColor" stroke-width="5" stroke-linecap="round">
      <!-- the base -->
      <path d="M45.821 83.5V101.5C47.821 107 50.821 108.5 59.821 108.5C64.621 108.5 70.821 108.5 73.321 108.5" />
      <!-- the frame, both shoulders -->
      <path
        d="M70.8211 64.5C70.8211 64.5 73.321 78.5 71.821 86.5C70.321 94.5 56.321 95.5 56.321 95.5M20.321 82.5C20.321 82.5 22.321 52.5 25.821 47.5C29.321 42.5 34.821 43 40.321 43C45.821 43 58.321 43 58.321 43"
      />
      <!-- the glass: left and right walls, roof and floor -->
      <path
        d="M46.321 2.5C58.321 2.5 58.321 20.5 46.321 20.5C47.121 20.4653 59.821 20.5 59.821 20.5C59.821 20.5 66.821 21.5 66.821 30.5C66.821 30.5 80.821 33.5 83.321 46C85.821 58.5 91.5544 88 89.821 94.5C88.0877 101 81.321 104 74.321 108.5C74.321 108.5 76.821 118 74.821 121.5C72.821 125 46.321 125 46.321 125"
      />
      <path
        d="M46.321 2.5C34.321 2.5 34.321 20.5 46.321 20.5C45.521 20.4653 32.821 20.5 32.821 20.5C32.821 20.5 25.821 21.5 25.821 30.5C25.821 30.5 11.821 33.5 9.32104 46C6.82104 58.5 1.08771 88 2.82104 94.5C4.55438 101 11.321 104 18.321 108.5C18.321 108.5 15.821 118 17.821 121.5C19.821 125 46.321 125 46.321 125"
      />
      <!-- the lamp itself -->
      <circle cx="45.821" cy="73" r="9" />
      <path d="M54.321 65.5C57.8358 61.9853 59.8063 60.0147 63.321 56.5" />
      <path d="M39.321 80.5L30.321 89.5" />
    </g>
    <!-- the two beads, filled rather than stroked -->
    <g transform="translate(17.5 0)" fill="currentColor" stroke="currentColor" stroke-width="5">
      <circle cx="26.321" cy="93.5" r="3.5" />
      <circle cx="67.321" cy="52.5" r="3.5" />
    </g>
  </svg>
</template>
