<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ImageOff, X } from '@lucide/vue'
import { useAssetImage } from '../../composables/assetImage'
import AppButton from '../common/AppButton.vue'

/**
 * A picture, at the size its container wants, with a lightbox for when the
 * detail matters.
 *
 * The tap target is the picture itself rather than a button drawn over it: a
 * diagram in a question is something a student looks at closely, and a frame
 * around it with a caption would push the question it belongs to down the page.
 */
const props = withDefaults(
  defineProps<{
    /** The asset id, or null where there is nothing to show. */
    assetId: string | null
    label?: string
    /** Small inside an editor row, full width in a paper. */
    size?: 'sm' | 'md'
  }>(),
  { label: '', size: 'md' },
)

const { t } = useI18n()

const id = computed(() => props.assetId)
const { url, loading } = useAssetImage(id)
const zoomed = ref(false)

/**
 * The picture at the size it wants, up to a ceiling.
 *
 * `w-full` is deliberately absent: it resolves against the button, and a
 * button is an inline-block that sizes to its content - so a `width: 100%` image
 * makes the question's width depend on the question's width. What is left is the
 * natural size, which is what a teacher drew, capped so a tall diagram cannot
 * push the answer off a phone.
 */
const frame = computed(() =>
  props.size === 'sm'
    ? 'size-14 rounded-lg object-cover'
    : 'max-h-72 max-w-full rounded-xl object-contain',
)
</script>

<template>
  <div v-if="assetId !== null" class="min-w-0">
    <button
      v-if="url !== null"
      type="button"
      class="block max-w-full cursor-zoom-in overflow-hidden border border-outline-variant bg-surface-container-lowest"
      :class="size === 'sm' ? 'rounded-lg' : 'rounded-xl'"
      :aria-label="t('common.image.enlarge')"
      @click="zoomed = true"
    >
      <img :src="url" :alt="label" :class="frame" />
    </button>

    <div
      v-else-if="loading"
      :class="[
        'animate-pulse bg-surface-container-highest',
        size === 'sm' ? 'size-14 rounded-lg' : 'h-24 w-full rounded-xl',
      ]"
      role="status"
      :aria-label="t('common.image.loading')"
    />

    <!-- A gap where the picture was. An image the server does not hold is not an
         error the student can do anything about. -->
    <div
      v-else
      :class="[
        'flex items-center justify-center gap-1.5 border border-dashed border-outline-variant text-on-surface-variant',
        size === 'sm' ? 'size-14 rounded-lg' : 'h-20 w-full rounded-xl',
      ]"
    >
      <ImageOff class="size-4" aria-hidden="true" />
      <span v-if="size !== 'sm'" class="text-xs">{{ t('common.image.missing') }}</span>
    </div>

    <Teleport to="body">
      <div
        v-if="zoomed && url !== null"
        class="fixed inset-0 z-[60] flex flex-col bg-scrim p-4"
        role="dialog"
        aria-modal="true"
        :aria-label="label || t('common.image.enlarge')"
        @click.self="zoomed = false"
        @keydown.esc="zoomed = false"
      >
        <div class="flex justify-end">
          <AppButton variant="ghost" class="text-on-surface" :aria-label="t('common.close')" @click="zoomed = false">
            <X class="size-5" aria-hidden="true" />
          </AppButton>
        </div>
        <div class="flex min-h-0 flex-1 items-center justify-center">
          <img :src="url" :alt="label" class="max-h-full max-w-full rounded-xl object-contain" />
        </div>
      </div>
    </Teleport>
  </div>
</template>
