<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Activity, HardDrive, Server, UserCheck, Users } from '@lucide/vue'
import AppHeader from '../components/AppHeader.vue'
import UsersTab from '../components/admin/UsersTab.vue'
import ParticipantsTab from '../components/admin/ParticipantsTab.vue'
import ServerTab from '../components/admin/ServerTab.vue'
import SystemTab from '../components/admin/SystemTab.vue'
import { listUsers } from '../api/users'
import type { UserStatus } from '../api/types'
import AppButton from '../components/common/AppButton.vue'
import TabStrip from '../components/common/TabStrip.vue'

// The desktop app hosts the server, so the admin can hand over to the panel that
// starts and stops it - the same way the teacher screen does.
const emit = defineEmits<{ server: [] }>()

const { t } = useI18n()

type AdminTab = 'users' | 'participants' | 'system' | 'server'
const activeTab = ref<AdminTab>('users')
const focusStatus = ref<UserStatus | ''>('')
const pendingCount = ref(0)

async function countPending(): Promise<void> {
  try {
    pendingCount.value = (await listUsers({ status: 'pending' })).length
  } catch {
    // The users tab surfaces its own error; a stale badge is not worth an alert.
    pendingCount.value = 0
  }
}

function reviewPending(): void {
  focusStatus.value = 'pending'
  activeTab.value = 'users'
}

onMounted(countPending)
</script>

<template>
  <div class="flex h-dvh flex-col overflow-hidden bg-surface">
    <AppHeader hosted @server="emit('server')" />

    <div class="min-h-0 flex-1 overflow-y-auto">
      <main class="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
        <h2 class="text-xl font-semibold text-on-surface">
          {{ t('admin.heading') }}
        </h2>
        <p class="mt-1 text-sm text-on-surface-variant">{{ t('admin.subheading') }}</p>

        <div
          v-if="pendingCount > 0"
          class="mt-4 flex flex-col gap-3 rounded-2xl border border-outline-variant bg-warning-container p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <p class="flex items-center gap-2 text-sm font-semibold text-on-warning-container">
            <UserCheck class="size-4 shrink-0" aria-hidden="true" />
            {{ t('admin.pendingBanner', { count: pendingCount }) }}
          </p>
          <AppButton variant="warning" class="shrink-0 self-start sm:self-auto" @click="reviewPending">
            {{ t('admin.pendingReview') }}
          </AppButton>
        </div>

        <TabStrip
          v-model="activeTab"
          class="mt-5"
          :aria-label="t('admin.heading')"
          :items="[
            { value: 'users', label: t('admin.tabs.users'), icon: Users, badge: pendingCount || null },
            { value: 'participants', label: t('admin.tabs.participants'), icon: Activity },
            { value: 'system', label: t('admin.tabs.system'), icon: HardDrive },
            { value: 'server', label: t('admin.tabs.server'), icon: Server },
          ]"
        />

        <!--
          `:key` remounts the sheet on a tab change and the transition fades it
          in and out: a swap that teleports reads as a glitch, one that fades
          reads as a page turning.
        -->
        <Transition mode="out-in" name="view">
          <div :key="activeTab" class="mt-5">
            <UsersTab
              v-if="activeTab === 'users'"
              :focus-status="focusStatus"
              @changed="countPending"
            />
            <ParticipantsTab v-else-if="activeTab === 'participants'" />
            <SystemTab v-else-if="activeTab === 'system'" />
            <ServerTab v-else />
          </div>
        </Transition>

      </main>
    </div>
  </div>
</template>
