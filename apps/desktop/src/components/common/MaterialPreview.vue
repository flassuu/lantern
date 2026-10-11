<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ImageOff, X } from '@lucide/vue'
import { fetchBlob } from '../../api/client'
import AppButton from './AppButton.vue'

/**
 * A picture that is looked at rather than only downloaded.
 *
 * A course material is served inline for images, so the browser could draw it
 * from an `<img src>` - except the API authenticates with a header, not a
 * cookie, and a plain URL is turned away at the door. So the bytes are fetched
 * here, with the token, and held as an object URL - which also makes this its
 * owner: the URL is revoked when the material changes and when the view goes
 * away, because a blob URL nobody revokes is a lesson kept in memory for the
 * life of the tab.
 *
 * Only images are previewed. A GIF is one of them and animates, which is the
 * point of putting one in a lesson rather than in a slide.
 */
const props = defineProps<{
  courseId: string
  materialId: string
  title: string
  mimeType: string
}>()

const { t } = useI18n()

const url = ref<string | null>(null)
const loading = ref(false)
const failed = ref(false)
const zoomed = ref(false)
let held: string | null = null

const isImage = computed(() => props.mimeType.startsWith('image/'))

function release(): void {
  if (held !== null) URL.revokeObjectURL(held)
  held = null
  url.value = null
}

watch(
  () => [props.courseId, props.materialId] as const,
  async ([courseId, materialId]) => {
    release()
    failed.value = false
    if (!isImage.value) return
    loading.value = true
    try {
      const blob = await fetchBlob(`/api/courses/${courseId}/materials/${materialId}/file`)
      const objectUrl = URL.createObjectURL(blob)
      // The id that changed last is the one that counts: a slow fetch for a
      // material nobody is looking at any more must not win.
      if (props.materialId !== materialId) {
        URL.revokeObjectURL(objectUrl)
        return
      }
      held = objectUrl
      url.value = objectUrl
    } catch {
      failed.value = true
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)

onScopeDispose(release)
</script>

<template>
  <span v-if="isImage" class="inline-flex shrink-0">
    <button
      v-if="url !== null"
      type="button"
      class="block cursor-zoom-in overflow-hidden rounded-lg border border-outline-variant"
      :aria-label="t('common.image.enlarge')"
      @click="zoomed = true"
    >
      <img :src="url" :alt="title" class="size-14 object-cover" />
    </button>
    <span
      v-else-if="loading"
      class="block size-14 animate-pulse rounded-lg bg-surface-container-highest"
      role="status"
      :aria-label="t('common.image.loading')"
    />
    <!-- A gap, not an error: a material the server no longer holds is nothing
         the person looking at it can do anything about. -->
    <span
      v-else-if="failed"
      class="grid size-14 place-items-center rounded-lg border border-dashed border-outline-variant text-on-surface-variant"
    >
      <ImageOff class="size-4" aria-hidden="true" />
    </span>

    <Teleport to="body">
      <div
        v-if="zoomed && url !== null"
        class="fixed inset-0 z-[60] flex flex-col bg-scrim p-4"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        @click.self="zoomed = false"
        @keydown.esc="zoomed = false"
      >
        <div class="flex justify-end">
          <AppButton
            variant="ghost"
            :aria-label="t('common.close')"
            @click="zoomed = false"
          >
            <X class="size-5" aria-hidden="true" />
          </AppButton>
        </div>
        <div class="flex min-h-0 flex-1 items-center justify-center">
          <img :src="url" :alt="title" class="max-h-full max-w-full rounded-xl object-contain" />
        </div>
      </div>
    </Teleport>
  </span>
</template>
