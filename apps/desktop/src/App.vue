<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuth } from './stores/auth'
import LoginView from './views/LoginView.vue'
import ServerView from './views/ServerView.vue'
import RegisterView from './views/RegisterView.vue'
import AdminDashboard from './views/AdminDashboard.vue'
import TeacherDashboard from './views/TeacherDashboard.vue'
import StudentDashboard from './views/StudentDashboard.vue'
import ConfirmDialog from './components/common/ConfirmDialog.vue'
import ToastHost from './components/common/ToastHost.vue'
import { getHealthState, startHealthPolling, stopHealthPolling } from './composables/health'
import { useToast } from './composables/toast'

const { t } = useI18n()
const { status, user, initialize } = useAuth()
const { info } = useToast()
const health = getHealthState()

const mode = ref<'login' | 'register' | 'server'>('login')

// A class QR carries `?class=KEY`: the student came here to register, so open
// the sign-up form rather than making them find "Create account" themselves.
if (new URLSearchParams(window.location.search).has('class')) mode.value = 'register'

let wasOffline = false
watch(
  () => health.status,
  (healthStatus) => {
    if (healthStatus === 'offline') wasOffline = true
    if (healthStatus === 'online' && wasOffline) {
      wasOffline = false
      info(t('server.backOnline'))
    }
  },
)

onMounted(() => {
  void initialize()
  startHealthPolling()
})
onBeforeUnmount(stopHealthPolling)

type Screen = 'loading' | 'login' | 'register' | 'server' | 'admin' | 'teacher' | 'student'

const screen = computed<Screen>(() => {
  // The server screen is reachable without signing in: the first thing a teacher
  // may need is to start the server the sign-in talks to.
  // The panel is opened from the sign-in screen and from both desks. Which way
  // Back goes is the screen's own business: signed in, `mode` is ignored and
  // the user lands back on the desk they came from, so a teacher who opened the
  // panel to check on a running server does not end up at the sign-in form.
  if (mode.value === 'server') return 'server'
  if (status.value !== 'authenticated' || !user.value) {
    if (status.value === 'initializing') return 'loading'
    return mode.value === 'register' ? 'register' : 'login'
  }
  return user.value.role
})
</script>

<template>
  <div v-if="screen === 'loading'" class="flex min-h-dvh items-center justify-center p-6">
    <div role="status" class="w-full max-w-xs space-y-3">
      <span class="sr-only">{{ t('common.loading') }}</span>
      <div class="h-4 w-1/2 rounded-full bg-surface-container-highest" aria-hidden="true" />
      <div class="h-3 w-3/4 rounded-full bg-surface-container-highest" aria-hidden="true" />
      <div class="h-3 w-2/3 rounded-full bg-surface-container-highest" aria-hidden="true" />
    </div>
  </div>

  <LoginView
    v-else-if="screen === 'login'"
    @register="mode = 'register'"
    @server="mode = 'server'"
  />
  <RegisterView
    v-else-if="screen === 'register'"
    @back="mode = 'login'"
    @server="mode = 'server'"
  />
  <ServerView v-else-if="screen === 'server'" @back="mode = 'login'" />
  <AdminDashboard v-else-if="screen === 'admin'" @server="mode = 'server'" />
  <TeacherDashboard v-else-if="screen === 'teacher'" @server="mode = 'server'" />
  <StudentDashboard v-else-if="screen === 'student'" />
  <ConfirmDialog />
  <ToastHost />
</template>