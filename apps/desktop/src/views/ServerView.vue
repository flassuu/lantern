<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Activity,
  ArrowUpRight,
  CircleCheck,
  CircleX,
  Play,
  Power,
  RotateCw,
  ScrollText,
  Settings,
  Square,
  TriangleAlert,
} from '@lucide/vue'
import { changePassword } from '../api/auth'
import { ApiError, setApiBase } from '../api/client'
import { getSettings, updateSettings } from '../api/settings'
import {
  adoptExternalServer,
  getHostSettings,
  getServerStatus,
  isDesktop,
  onServerExit,
  onServerLog,
  restartServer,
  saveHostSettings,
  startServer,
  stopServer,
  type HostSettings,
  type ServerLogLine,
  type ServerStatus,
} from '../composables/desktop'
import { fetchHealth } from '../api/client'
import { useAuth } from '../stores/auth'
import { useToast } from '../composables/toast'
import AppButton from '../components/common/AppButton.vue'
import AppCard from '../components/common/AppCard.vue'
import TabStrip from '../components/common/TabStrip.vue'
import AppInput from '../components/common/AppInput.vue'
import BrandMark from '../components/BrandMark.vue'

/**
 * The server, and the settings that start it.
 *
 * This screen is the desktop app's own reason to exist: nothing here exists in
 * the browser build, because there is no process to start and no settings file
 * to keep. What it must get right is the first five seconds — a teacher who has
 * just double-clicked the app needs to see that the server is stopped, why, and
 * one button that fixes it.
 */
const emit = defineEmits<{ back: [] }>()

const { t } = useI18n()
const toast = useToast()
const { user } = useAuth()

const MAX_LINES = 500

/** The port the app falls back to when the settings have not been read yet. */
const DEFAULT_PORT = 3300

/** Status, settings, console: what a teacher is here to do, one at a time. */
const activeTab = ref<'status' | 'settings' | 'console'>('status')

const status = ref<ServerStatus | null>(null)
/** What the answering server calls itself; the host does not know the version. */
const health = ref<{ version: string } | null>(null)
const settings = ref<HostSettings | null>(null)
const lines = ref<ServerLogLine[]>([])
const busy = ref(false)
const loadError = ref('')
const level = ref<ServerLogLine['level'] | null>(null)
const logBox = ref<HTMLElement | null>(null)

const portDraft = ref('')
const publicAddressDraft = ref('')
const suggestions = ref<string[]>([])
const copied = ref(false)
const dataDirDraft = ref('')
const webRootDraft = ref('')
const binaryDraft = ref('')
const teacherPasswordDraft = ref('')
const currentPasswordDraft = ref('')
const newPasswordDraft = ref('')
const changingPassword = ref(false)

let unlistenLog: (() => void) | undefined
let unlistenExit: (() => void) | undefined

const LEVELS: Array<ServerLogLine['level'] | null> = ['error', 'warn', 'info', null]

const shown = computed(() =>
  level.value === null ? lines.value : lines.value.filter((line) => line.level === level.value),
)

/** Only an admin may change the public address; a teacher may read it. */
const addressWritable = computed(() => user.value?.role === 'admin')

/**
 * The address a student's phone can open, which is not necessarily the one this
 * window is served from. The server reports the addresses it answers on.
 */
const lanAddress = computed(() => suggestions.value[0] ?? `http://localhost:${portDraft.value || '3300'}`)

/** A run this app started, as opposed to one it found already listening. */
const adopted = computed(() => status.value?.running === true && status.value.managed === false)

/** How long it has been up, as a duration a person reads. */
const uptime = computed(() => {
  const ms = status.value?.uptimeMs
  if (ms === null || ms === undefined || ms < 0) return ''
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
})

const missingBinary = computed(
  () => status.value !== null && !status.value.running && status.value.searched.length > 0 && status.value.binaryPath === null,
)

function clock(atMs: number): string {
  return new Date(atMs).toLocaleTimeString(undefined, { hour12: false })
}

/** The same shape the terminal formatter prints: a request is one arrow line. */
function text(line: ServerLogLine): string {
  return line.msg || line.raw
}

function push(line: ServerLogLine): void {
  lines.value = [...lines.value, line]
  if (lines.value.length > MAX_LINES) {
    lines.value = lines.value.slice(lines.value.length - MAX_LINES)
  }
  requestAnimationFrame(scrollToEnd)
}

function scrollToEnd(): void {
  const element = logBox.value
  if (!element) return
  element.scrollTop = element.scrollHeight
}

function applySettings(next: HostSettings | null): void {
  settings.value = next
  if (!next) return
  portDraft.value = String(next.port)
  dataDirDraft.value = next.dataDir
  webRootDraft.value = next.webRoot
  binaryDraft.value = next.binaryPath
  teacherPasswordDraft.value = next.teacherPassword
}

async function refresh(): Promise<void> {
  const [current, host] = await Promise.all([getServerStatus(), getHostSettings()])
  status.value = current
  applySettings(host)
  await loadAddress()
}

/**
 * Asks whether something is already serving on the port, before anything offers
 * to start. The health answer is read at the same time: a server that is up can
 * say which build it is, and the host cannot know that from a pid.
 */
async function adoptOrReport(): Promise<void> {
  const [adopted, healthAnswer] = await Promise.all([adoptExternalServer(), fetchHealth()])
  if (adopted) status.value = adopted
  health.value = healthAnswer
}

/**
 * The public address lives on the server, not here: it is what a phone opens, and
 * a phone has never heard of this window. Read for every role, written by an admin.
 */
async function loadAddress(): Promise<void> {
  try {
    const settings = await getSettings()
    publicAddressDraft.value = settings.publicBaseUrl ?? ''
    suggestions.value = settings.suggestions
  } catch {
    // Not signed in, or the server is not up yet: the field stays empty and says so.
    suggestions.value = []
  }
}

async function copyLog(): Promise<void> {
  // The console's own formatting, so what lands on the clipboard is what is on
  // screen - and the timestamp, which is useless without.
  const asText = shown.value
    .map((line) => `${clock(line.atMs)} ${line.level} ${text(line)}`)
    .join('\n')
  try {
    await navigator.clipboard.writeText(asText)
    copied.value = true
    window.setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch {
    // Clipboard blocked: the console is on screen, and a teacher can select it.
  }
}

async function run(action: () => Promise<ServerStatus | null>): Promise<void> {
  if (busy.value) return
  busy.value = true
  loadError.value = ''
  try {
    const next = await action()
    if (next) status.value = next
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    busy.value = false
  }
}

/** The API base follows the port, or every request in the app misses. */
async function onStart(): Promise<void> {
  await run(startServer)
  const current = settings.value
  if (current) setApiBase(`http://localhost:${portDraft.value || current.port}`)
  await adoptOrReport()
}

async function save(): Promise<void> {
  if (!settings.value || busy.value) return
  const port = Number(portDraft.value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    loadError.value = t('desktop.server.portInvalid')
    return
  }
  busy.value = true
  loadError.value = ''
  try {
    const saved = await saveHostSettings({
      ...settings.value,
      port,
      dataDir: dataDirDraft.value.trim(),
      webRoot: webRootDraft.value.trim(),
      binaryPath: binaryDraft.value.trim(),
      teacherPassword: teacherPasswordDraft.value,
    })
    applySettings(saved)

    // The public address is the server's own setting; a teacher only reads it.
    if (addressWritable.value) {
      const address = publicAddressDraft.value.trim()
      const current = await getSettings().catch(() => null)
      if (current && (current.publicBaseUrl ?? '') !== address) {
        await updateSettings(address === '' ? null : address)
        await loadAddress()
      }
    }
    toast.success(t('desktop.server.savedToast'))
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    busy.value = false
  }
}

/**
 * Changes the admin password on the server.
 *
 * The seed variable only ever applies to a database with no admin in it, so on a
 * second launch this button is the only thing that can move the password — and
 * it needs the current one, because a borrowed session must not be able to lock
 * the owner out.
 */
async function applyNewPassword(): Promise<void> {
  if (changingPassword.value || !user.value) return
  if (newPasswordDraft.value.length < 8) {
    loadError.value = t('desktop.server.passwordTooShort')
    return
  }
  changingPassword.value = true
  loadError.value = ''
  try {
    await changePassword(currentPasswordDraft.value, newPasswordDraft.value)
    currentPasswordDraft.value = ''
    newPasswordDraft.value = ''
    teacherPasswordDraft.value = ''
    toast.success(t('desktop.server.passwordChanged'))
  } catch (error) {
    loadError.value =
      error instanceof ApiError && error.status === 401
        ? t('desktop.server.currentPasswordWrong')
        : t('desktop.server.passwordFailed')
  } finally {
    changingPassword.value = false
  }
}

/**
 * Opens the app on the address a phone could reach, not on `localhost`: this
 * window is the teacher's own machine, and showing a student `localhost` is how a
 * lesson fails to start.
 */
function openInBrowser(): void {
  window.open(lanAddress.value, '_blank', 'noopener')
}

function toggleLevel(next: ServerLogLine['level'] | null): void {
  level.value = level.value === next ? null : next
  requestAnimationFrame(scrollToEnd)
}

onMounted(async () => {
  if (!isDesktop()) {
    // The same source tree is served as a web client; there is nothing to host.
    emit('back')
    return
  }
  await refresh()
  await adoptOrReport()
  unlistenLog = await onServerLog(push)
  unlistenExit = await onServerExit((code) => {
    void refresh()
    toast.error(
      t('desktop.server.exitedToast', {
        code: code === null ? t('desktop.server.unknownExit') : String(code),
      }),
    )
  })
})

onBeforeUnmount(() => {
  unlistenLog?.()
  unlistenExit?.()
})
</script>

<template>
  <main class="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-6 py-8">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex min-w-0 items-center gap-2.5">
        <BrandMark :size="30" class="shrink-0" />
        <div class="min-w-0">
          <h1 class="truncate text-lg font-bold tracking-tight text-on-surface">
            {{ t('desktop.server.heading') }}
          </h1>
          <p class="truncate text-xs text-on-surface-variant">
            {{ t('desktop.server.subheading') }}
          </p>
        </div>
      </div>
      <AppButton variant="secondaryMuted" size="sm" @click="emit('back')">
        {{ t('desktop.server.back') }}
      </AppButton>
    </header>

    <!--
      Three tabs, because there are three different jobs here and only one of
      them is worth the screen at a time: is it up, where does it keep things,
      and what did it say. The console is the one a teacher reads while something
      is wrong, so it gets a tab of its own rather than sitting under everything
      else for the whole lesson.
    -->
    <TabStrip
      v-model="activeTab"
      class="mt-6"
      :aria-label="t('desktop.server.heading')"
      :items="[
        { value: 'status', label: t('desktop.server.tabs.status'), icon: Activity },
        { value: 'settings', label: t('desktop.server.tabs.settings'), icon: Settings },
        { value: 'console', label: t('desktop.server.tabs.console'), icon: ScrollText },
      ]"
    />

    <!--
      `:key` remounts the sheet on a tab change and the transition fades it in
      and out, the same as the workbench and the student home: a swap that
      teleports reads as a glitch, one that fades reads as a page turning.
    -->
    <Transition mode="out-in" name="view">
      <div :key="activeTab" class="mt-5">

        <template v-if="activeTab === 'status'">
          <AppCard as="section">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex flex-wrap items-center gap-2">
                <span
                  class="inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold"
                  :class="
                    status?.running
                      ? 'bg-success-container text-on-success-container'
                      : 'bg-surface-container-high text-on-surface-variant'
                  "
                >
                  <CircleCheck v-if="status?.running" class="size-4" aria-hidden="true" />
                  <CircleX v-else class="size-4" aria-hidden="true" />
                  {{ status?.running ? t('desktop.server.running') : t('desktop.server.stopped') }}
                </span>
                <!--
                  Running and started-here are two different things. A teacher who
                  finds a server already up has to know it is not this app's
                  before deciding what to do about it.
                -->
                <span
                  v-if="adopted"
                  class="inline-flex items-center gap-1.5 rounded-full bg-secondary-container px-2.5 py-1 text-[11px] font-semibold text-on-secondary-container"
                >
                  <Power class="size-3.5" aria-hidden="true" />
                  {{ t('desktop.server.adoptedChip') }}
                </span>
              </div>

              <div class="flex flex-wrap items-center gap-2">
                <AppButton
                  v-if="!status?.running"
                  variant="primary"
                  :disabled="busy || missingBinary"
                  @click="onStart"
                >
                  <Play class="size-4" aria-hidden="true" />
                  {{ t('desktop.server.start') }}
                </AppButton>
                <AppButton v-else variant="secondary" :disabled="busy" @click="run(stopServer)">
                  <Square class="size-4" aria-hidden="true" />
                  {{ t('desktop.server.stop') }}
                </AppButton>
                <AppButton
                  variant="secondaryPlain"
                  :disabled="busy || missingBinary"
                  @click="run(restartServer)"
                >
                  <RotateCw class="size-4" aria-hidden="true" />
                  {{ t('desktop.server.restart') }}
                </AppButton>
                <AppButton variant="ghost" size="sm" @click="openInBrowser">
                  <ArrowUpRight class="size-4" aria-hidden="true" />
                  {{ t('desktop.server.openInBrowser') }}
                </AppButton>
              </div>
            </div>

            <p class="mt-2 text-xs text-on-surface-variant">
              {{ t('desktop.server.tabHint.status') }}
            </p>

            <!-- The numbers, so the buttons above have something to act on. -->
            <dl class="mt-4 grid gap-x-6 gap-y-2 border-t border-outline-variant pt-4 sm:grid-cols-2">
              <div class="flex items-baseline justify-between gap-3">
                <dt class="text-xs text-on-surface-variant">{{ t('desktop.server.portLabel') }}</dt>
                <dd class="font-mono text-sm text-on-surface">{{ portDraft || DEFAULT_PORT }}</dd>
              </div>
              <div v-if="health" class="flex items-baseline justify-between gap-3">
                <dt class="text-xs text-on-surface-variant">
                  {{ t('desktop.server.versionLabel') }}
                </dt>
                <dd class="font-mono text-sm text-on-surface">{{ health.version }}</dd>
              </div>
              <div v-if="status?.pid" class="flex items-baseline justify-between gap-3">
                <dt class="text-xs text-on-surface-variant">
                  {{ t('desktop.server.processLabel') }}
                </dt>
                <dd class="font-mono text-sm text-on-surface">{{ status.pid }}</dd>
              </div>
              <div v-if="uptime" class="flex items-baseline justify-between gap-3">
                <dt class="text-xs text-on-surface-variant">
                  {{ t('desktop.server.uptimeLabel') }}
                </dt>
                <dd class="text-sm text-on-surface">{{ uptime }}</dd>
              </div>
            </dl>

            <p
              v-if="missingBinary"
              class="mt-4 rounded-[var(--radius-control)] bg-error-container px-3 py-2 text-sm text-on-error-container"
            >
              <span class="flex items-start gap-2">
                <TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  {{ t('desktop.server.missingTitle') }}
                  <span class="mt-1 block font-mono text-xs break-all">
                    {{ status?.searched.join(' · ') }}
                  </span>
                  <span class="mt-1 block text-xs">{{ t('desktop.server.missingHint') }}</span>
                </span>
              </span>
            </p>
            <p
              v-else-if="status?.error"
              class="mt-4 rounded-[var(--radius-control)] bg-error-container px-3 py-2 text-sm text-on-error-container"
            >
              {{ status.error }}
            </p>
          </AppCard>

          <!--
            A server this app did not start. The app works with it rather than
            pretending the port is free, and stopping it is a real act on
            somebody else's process - so the teacher is told exactly that before
            they press the button.
          -->
          <AppCard v-if="adopted" as="section" class="mt-4">
            <h2 class="text-sm font-semibold text-on-surface">
              {{ t('desktop.server.adoptedTitle') }}
            </h2>
            <p class="mt-1 text-xs text-on-surface-variant">
              {{ t('desktop.server.adoptedHint') }}
            </p>
            <p class="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span
                v-if="status?.externalPid"
                class="rounded-full bg-surface-container-highest px-2.5 py-0.5 font-mono font-semibold text-on-surface-variant"
              >
                {{ t('desktop.server.adoptedPid', { pid: status.externalPid }) }}
              </span>
              <span v-else class="text-on-surface-variant">
                {{ t('desktop.server.adoptedNoPid') }}
              </span>
            </p>
            <p class="mt-2 text-[11px] text-on-surface-variant">
              {{ t('desktop.server.adoptedStopHint') }}
            </p>
          </AppCard>

          <AppCard v-else-if="!status?.running" as="section" class="mt-4">
            <h2 class="text-sm font-semibold text-on-surface">
              {{ t('desktop.server.noneTitle', { port: portDraft || DEFAULT_PORT }) }}
            </h2>
            <p class="mt-1 text-xs text-on-surface-variant">
              {{ t('desktop.server.noneHint') }}
            </p>
          </AppCard>
        </template>

        <template v-else-if="activeTab === 'console'">

  <AppCard as="section">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-xs text-on-surface-variant">{{ t('desktop.server.tabHint.console') }}</p>
      <div class="flex flex-wrap items-center gap-1.5">
        <AppButton
          v-for="item in LEVELS"
          :key="String(item)"
          variant="secondaryPlain"
          size="sm"
          :aria-pressed="level === item"
          @click="toggleLevel(item)"
        >
          {{ item === null ? t('desktop.server.allLevels') : t(`desktop.server.level.${item}`) }}
        </AppButton>
        <AppButton variant="ghost" size="sm" @click="copyLog">
          {{ copied ? t('desktop.server.copied') : t('desktop.server.copy') }}
        </AppButton>
        <AppButton variant="ghost" size="sm" @click="lines = []">
          {{ t('desktop.server.clear') }}
        </AppButton>
      </div>
    </div>

    <div
      ref="logBox"
      class="mt-3 h-64 overflow-y-auto rounded-[var(--radius-control)] bg-surface-container p-3 font-mono text-xs leading-relaxed"
      role="log"
      aria-live="polite"
      :aria-label="t('desktop.server.consoleTitle')"
    >
      <p v-if="shown.length === 0" class="text-on-surface-variant">
        {{ t('desktop.server.consoleEmpty') }}
      </p>
      <p
        v-for="(line, index) in shown"
        :key="`${line.atMs}-${index}`"
        class="flex gap-2 whitespace-pre-wrap break-all"
        :class="
          line.level === 'error' || line.level === 'fatal'
            ? 'text-error'
            : line.level === 'warn'
              ? 'text-on-warning-container'
              : 'text-on-surface'
        "
      >
        <span class="shrink-0 opacity-70">{{ clock(line.atMs) }}</span>
        <span class="shrink-0 opacity-70">{{ line.level }}</span>
        <span class="min-w-0">{{ text(line) }}</span>
      </p>
    </div>
  </AppCard>

        </template>



        <template v-else>

  <AppCard as="section">
    <p class="text-xs text-on-surface-variant">
      {{ t('desktop.server.tabHint.settings') }}
    </p>

    <div class="mt-4 grid gap-4 sm:grid-cols-2">
      <div>
        <label class="text-xs font-medium text-on-surface-variant" for="host-port">
          {{ t('desktop.server.port') }}
        </label>
        <AppInput
          id="host-port"
          v-model="portDraft"
          type="number"
          min="1"
          max="65535"
          class="mt-1"
        />
      </div>
      <div>
        <label class="text-xs font-medium text-on-surface-variant" for="host-data">
          {{ t('desktop.server.dataDir') }}
        </label>
        <AppInput id="host-data" v-model="dataDirDraft" class="mt-1 font-mono text-xs" />
      </div>
      <div>
        <label class="text-xs font-medium text-on-surface-variant" for="host-address">
          {{ t('desktop.server.publicAddress') }}
        </label>
        <AppInput
          id="host-address"
          v-model="publicAddressDraft"
          class="mt-1 font-mono text-xs"
          :disabled="!addressWritable"
          :placeholder="t('desktop.server.publicAddressPlaceholder')"
        />
        <p class="mt-1 text-[11px] text-on-surface-variant">
          {{ addressWritable ? t('desktop.server.publicAddressHint') : t('desktop.server.publicAddressReadOnly') }}
        </p>
        <ul v-if="suggestions.length" class="mt-1 flex flex-wrap gap-1">
          <li v-for="address in suggestions" :key="address">
            <button
              type="button"
              class="state-layer rounded-full bg-surface-container-high px-2 py-0.5 font-mono text-[11px] text-on-surface-variant"
              :aria-pressed="publicAddressDraft === address"
              @click="publicAddressDraft = address"
            >
              {{ address }}
            </button>
          </li>
        </ul>
      </div>
      <div>
        <label class="text-xs font-medium text-on-surface-variant" for="host-webroot">
          {{ t('desktop.server.webRoot') }}
        </label>
        <AppInput
          id="host-webroot"
          v-model="webRootDraft"
          class="mt-1 font-mono text-xs"
          :placeholder="t('desktop.server.webRootPlaceholder')"
        />
      </div>
      <div>
        <label class="text-xs font-medium text-on-surface-variant" for="host-binary">
          {{ t('desktop.server.binaryPath') }}
        </label>
        <AppInput
          id="host-binary"
          v-model="binaryDraft"
          class="mt-1 font-mono text-xs"
          :placeholder="t('desktop.server.binaryPlaceholder')"
        />
      </div>
      <div>
        <label class="text-xs font-medium text-on-surface-variant" for="host-admin">
          {{ t('desktop.server.teacherPassword') }}
        </label>
        <AppInput
          id="host-admin"
          v-model="teacherPasswordDraft"
          type="password"
          autocomplete="off"
          class="mt-1"
          :placeholder="t('desktop.server.teacherPasswordPlaceholder')"
        />
        <p class="mt-1 text-[11px] text-on-surface-variant">
          {{ t('desktop.server.teacherPasswordHint') }}
        </p>
      </div>
      <div>
        <label class="text-xs font-medium text-on-surface-variant" for="host-current-password">
          {{ t('desktop.server.currentPassword') }}
        </label>
        <AppInput
          id="host-current-password"
          v-model="currentPasswordDraft"
          type="password"
          autocomplete="current-password"
          class="mt-1"
        />
        <label
          class="mt-3 block text-xs font-medium text-on-surface-variant"
          for="host-new-password"
        >
          {{ t('desktop.server.newPassword') }}
        </label>
        <AppInput
          id="host-new-password"
          v-model="newPasswordDraft"
          type="password"
          autocomplete="new-password"
          class="mt-1"
        />
        <p v-if="user" class="mt-1 text-[11px] text-on-surface-variant">
          {{ t('desktop.server.newPasswordHint') }}
        </p>
        <p v-else class="mt-1 text-[11px] text-on-surface-variant">
          {{ t('desktop.server.newPasswordSignIn') }}
        </p>
        <AppButton
          variant="secondary"
          size="sm"
          class="mt-2"
          :disabled="changingPassword || !user || newPasswordDraft === ''"
          @click="applyNewPassword"
        >
          {{ t('desktop.server.applyPassword') }}
        </AppButton>
      </div>
    </div>

    <p
      v-if="loadError"
      role="alert"
      class="mt-4 rounded-lg bg-error-container px-3 py-2 text-sm text-on-error-container"
    >
      {{ loadError }}
    </p>

    <div class="mt-4">
      <AppButton variant="primary" :disabled="busy" @click="save">
        {{ t('desktop.server.save') }}
      </AppButton>
      <p class="mt-2 text-xs text-on-surface-variant">
        {{ t('desktop.server.applyHint') }}
      </p>
    </div>
  </AppCard>

        </template>

      </div>
    </Transition>
  </main>
</template>
