<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ImagePlus, Loader2, Trash2 } from '@lucide/vue'
import { ApiError } from '../../api/client'
import { uploadAsset } from '../../api/assets'
import MediaFigure from '../common/MediaFigure.vue'
import AppButton from '../common/AppButton.vue'

/**
 * Attach a picture to a question, an option, or one side of a pair.
 *
 * The control is a drop target and a file button at once, because a teacher
 * building a paper has the diagram in a folder and the window open side by side.
 * The file input stays on the page rather than being restyled into a fake button:
 * a label that pretends to be a button loses the keyboard, the focus ring and
 * the "choose a file" title, all of which are what this control is for.
 */
const props = defineProps<{
  /** The asset id already attached, or null. */
  assetId: string | null
  /** What the picture is of; shown as its alternative text. */
  label?: string
  size?: 'sm' | 'md'
}>()

const emit = defineEmits<{ change: [string | null] }>()

const { t } = useI18n()

const input = ref<HTMLInputElement | null>(null)
const busy = ref(false)
const failed = ref(false)

async function pick(event: Event): Promise<void> {
  const files = (event.target as HTMLInputElement).files
  const file = files?.[0]
  // The same file twice would not fire a change event otherwise, and a teacher
  // who replaced a diagram wants the replacement, not the old one.
  if (event.target) (event.target as HTMLInputElement).value = ''
  if (!file) return
  busy.value = true
  failed.value = false
  try {
    const asset = await uploadAsset(file)
    emit('change', asset.id)
  } catch (error) {
    failed.value = error instanceof ApiError && error.status === 413
  } finally {
    busy.value = false
  }
}

async function onDrop(event: DragEvent): Promise<void> {
  const file = event.dataTransfer?.files?.[0]
  if (!file) return
  busy.value = true
  failed.value = false
  try {
    const asset = await uploadAsset(file)
    emit('change', asset.id)
  } catch {
    failed.value = true
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="min-w-0">
    <div class="flex items-center gap-2">
      <input
        ref="input"
        type="file"
        accept="image/*"
        class="sr-only"
        :aria-label="t('teacher.editor.media.choose')"
        @change="pick"
      />
      <AppButton
        variant="secondaryPlain"
        size="sm"
        :disabled="busy"
        @click="input?.click()"
      >
        <Loader2 v-if="busy" class="size-4 animate-spin" aria-hidden="true" />
        <ImagePlus v-else class="size-4" aria-hidden="true" />
        {{ busy ? t('teacher.editor.media.uploading') : t('teacher.editor.media.choose') }}
      </AppButton>
      <AppButton
        v-if="assetId !== null"
        variant="ghost"
        size="sm"
        :aria-label="t('teacher.editor.media.remove')"
        @click="emit('change', null)"
      >
        <Trash2 class="size-4" aria-hidden="true" />
      </AppButton>
    </div>

    <p v-if="failed" role="alert" class="mt-1 text-xs text-error">
      {{ t('teacher.editor.media.failed') }}
    </p>

    <!-- The drop target is the picture's own space when there is one, so a
         teacher aiming at the diagram finds it. -->
    <div
      v-if="assetId !== null"
      class="mt-2 rounded-xl border border-dashed border-outline-variant p-2"
      @dragover.prevent
      @drop.prevent="onDrop"
    >
      <MediaFigure :asset-id="assetId" :label="label" :size="size ?? 'md'" />
    </div>
  </div>
</template>
