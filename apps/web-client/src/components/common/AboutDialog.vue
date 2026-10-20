<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from '@lucide/vue'
import AppDialog from './AppDialog.vue'
import BrandMark from '../BrandMark.vue'
import { effectiveBaseUrl } from '../../composables/settings'
import { appVersion } from '../../composables/desktop'
import { isSecureContext } from '../../pwa/secure'
import AppButton from './AppButton.vue'
import { useDialogFocus } from '../../composables/focusTrap'

const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const panelRef = ref<HTMLElement | null>(null)
const closeRef = ref<HTMLButtonElement | null>(null)
const version = ref('')
// A worker, and therefore an installable copy, needs https; the page knows.
const secure = isSecureContext()

useDialogFocus(
  () => props.open,
  () => emit('close'),
  panelRef,
  closeRef,
)

onMounted(async () => {
  version.value = appVersion() || t('common.about.versionUnknown')
})
</script>

<template>
  <AppDialog v-if="open" :label="t('common.about.title')" @close="emit('close')">
    <div ref="panelRef" class="p-5">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="flex items-center gap-2 text-base font-semibold text-on-surface">
            <BrandMark :size="24" class="shrink-0" />
            {{ t('app.name') }}
          </h3>
          <p class="mt-0.5 text-xs text-on-surface-variant">{{ t('common.about.tagline') }}</p>
        </div>
        <AppButton
          variant="ghost"
          icon
          class="shrink-0"
          ref="closeRef"
          :aria-label="t('common.close')"
          @click="emit('close')"
        >
          <X class="size-4" aria-hidden="true" />
        </AppButton>
      </div>

      <dl class="mt-4 space-y-3 text-sm">
        <div class="flex items-baseline justify-between gap-3">
          <dt class="text-on-surface-variant">{{ t('common.about.version') }}</dt>
          <dd class="font-semibold tabular-nums text-on-surface">{{ version }}</dd>
        </div>
        <div class="flex items-baseline justify-between gap-3">
          <dt class="text-on-surface-variant">{{ t('common.about.server') }}</dt>
          <dd class="min-w-0 truncate font-mono text-xs text-on-surface">
            {{ effectiveBaseUrl() }}
          </dd>
        </div>
        <div class="flex items-baseline justify-between gap-3">
          <dt class="text-on-surface-variant">{{ t('common.about.offlineCopy') }}</dt>
          <dd class="font-semibold text-on-surface">
            {{ secure ? t('common.about.installable') : t('common.about.needsHttps') }}
          </dd>
        </div>
      </dl>

      <p class="mt-4 border-t border-outline-variant pt-4 text-xs text-on-surface-variant">
        {{ t('common.about.offline') }}
      </p>

      <div class="mt-4 flex justify-end">
        <AppButton variant="primary" @click="emit('close')">{{ t('common.close') }}</AppButton>
      </div>
    </div>
  </AppDialog>
</template>