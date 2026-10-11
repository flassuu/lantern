<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ServerStatus from './ServerStatus.vue'
import AccountMenu from './AccountMenu.vue'
import BrandMark from './BrandMark.vue'
import BrandWordmark from './BrandWordmark.vue'
import OfflineBanner from './common/OfflineBanner.vue'
import { useAuth } from '../stores/auth'

const props = defineProps<{
  /** Desktop only: the app hosts the server, and has no frame to drag. */
  hosted?: boolean
}>()
const emit = defineEmits<{ server: [] }>()

const { t } = useI18n()
const { user } = useAuth()

const roleLabel = computed(() => t(`role.${user.value?.role ?? 'student'}`))
</script>

<template>
  <!--
    On Linux the frame is off (`tauri.linux.conf.json`), so the empty space here
    is what drags the window: `data-tauri-drag-region` is the whole of it. On the
    other platforms the platform draws its own frame and this is a bar under it.
  -->
  <header class="sticky top-0 z-30 border-b border-outline-variant bg-surface-container">
    <div class="flex h-14 items-center gap-3 px-3 sm:px-4">
      <BrandMark :size="24" class="shrink-0" data-tauri-drag-region />
      <!--
        The wordmark is the name, so the heading carries the artwork and keeps the
        name as text for screen readers and for anything reading the page - the
        letters cut out of the purple box are decoration, not information.
      -->
      <h1 class="flex min-w-0 items-center text-primary" data-tauri-drag-region>
        <BrandWordmark :height="20" class="shrink-0" aria-hidden="true" />
        <span class="sr-only">{{ t('app.name') }}</span>
      </h1>
      <!-- Only for staff: a student does not need to be told what they are. -->
      <span
        v-if="user && user.role !== 'student'"
        class="hidden shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold sm:inline"
        :class="
          user.role === 'admin'
            ? 'bg-primary-container text-on-primary-container'
            : 'bg-secondary-container text-on-secondary-container'
        "
      >
        {{ roleLabel }}
      </span>

      <!-- The empty space is the drag handle; the controls keep their own boxes. -->
      <div class="min-w-4 flex-1 self-stretch" data-tauri-drag-region />

      <!--
        `mr-3`: the block recedes 12px from the padding edge, and that 12px is
        what lines the avatar up with the sign-out button. The opened panel hangs
        off the header at the padding inset (see AccountMenu), so its sign-out
        button ends 12px left of the panel's right edge - exactly where this
        margin puts the avatar's right edge. Both are 40px, so centre meets
        centre and edge meets edge.
      -->
      <div class="mr-3 flex shrink-0 items-center gap-2">
        <ServerStatus />
        <!--
          One menu either way: the settings before signing in, the account
          afterwards. Signed out it drops the name and keeps the avatar, because
          the avatar is the button that opens it.
        -->
        <AccountMenu :hosted="props.hosted" @server="emit('server')" />

      </div>
    </div>
    <OfflineBanner />
  </header>
</template>