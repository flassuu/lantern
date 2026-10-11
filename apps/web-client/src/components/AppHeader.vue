<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ServerStatus from './ServerStatus.vue'
import AccountMenu from './AccountMenu.vue'
import BrandMark from './BrandMark.vue'
import BrandWordmark from './BrandWordmark.vue'
import OfflineBanner from './common/OfflineBanner.vue'
import { useAuth } from '../stores/auth'

const { t } = useI18n()
const { user } = useAuth()

const roleLabel = computed(() => t(`role.${user.value?.role ?? 'student'}`))
</script>

<template>
  <!--
    A status bar, edge to edge. Sticky so the server's state is on screen while
    scrolling a long course, and it never wraps: the brand takes what is left,
    the controls keep their boxes whatever the locale or the name.
  -->
  <header class="sticky top-0 z-30 bg-surface-container shadow-[0_1px_0_0_var(--outline-variant)]">
    <div class="flex h-14 items-center gap-2 px-3 sm:gap-3 sm:px-4">
      <BrandMark :size="24" class="shrink-0" />
      <!--
        The wordmark is the name, so the heading carries the artwork and keeps the
        name as text for screen readers and for anything reading the page - the
        letters cut out of the purple box are decoration, not information.
      -->
      <h1 class="flex min-w-0 items-center text-primary">
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

      <!--
        `mr-3`: the same 12px recess the desktop header gives this block. The
        opened panel hangs off the header at the padding inset (see AccountMenu),
        so its sign-out button ends 12px left of the panel's right edge -
        exactly where this margin puts the avatar's right edge; both are 40px,
        so centre meets centre.
      -->
      <div class="ml-auto mr-3 flex shrink-0 items-center gap-2">
        <ServerStatus />
        <!--
          One menu either way: the settings before signing in, the account
          afterwards. Signed out it drops the name and keeps the avatar, because
          the avatar is the button that opens it.
        -->
        <AccountMenu />
      </div>
    </div>
    <OfflineBanner />
  </header>
</template>