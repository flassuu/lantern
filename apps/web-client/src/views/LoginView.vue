<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, Eye, EyeOff, GraduationCap } from '@lucide/vue'
import AppHeader from '../components/AppHeader.vue'
import BrandWordmark from '../components/BrandWordmark.vue'
import { useAuth } from '../stores/auth'
import { ApiError } from '../api/client'
import type { UserRole } from '../api/types'
import AppButton from '../components/common/AppButton.vue'
import AppCard from '../components/common/AppCard.vue'
import AppCheckbox from '../components/common/AppCheckbox.vue'
import AppInput from '../components/common/AppInput.vue'

/**
 * Sign in as a student or as a teacher.
 *
 * The role control came out in 0.5.1 and it should not have. It sent nothing to
 * the server — `POST /api/auth/login` takes a username and a password and
 * rejects any other field — but it was not decoration either: it changed the
 * placeholder, and it decided which of the two ways into this app is being
 * described. A student arriving from a class QR needs to see that signing up is
 * one tap away; a teacher needs to see that accounts are made for them. Those
 * are different screens sharing a form, and the role is what tells them apart.
 *
 * So the role is back, minus the administrator: there is no admin in 0.5.1, and
 * one button claiming otherwise is how a student comes to believe the system is
 * about administrators.
 *
 * "Remember me" stores the password and signs in by itself next time. The token
 * is already persistent, so what it really buys is the way back in after signing
 * out and after a restart — without it you land here and type again. The
 * plaintext password is the price, and it is stated in the label rather than
 * buried: this is an offline tool on a classroom network, and the alternative
 * would be a way to sign in that the teacher has to remember.
 */
const emit = defineEmits<{ register: [] }>()

const { t } = useI18n()
const { signIn } = useAuth()

type PickableRole = Extract<UserRole, 'student' | 'teacher'>

const ROLES: Array<{ role: PickableRole; icon: typeof GraduationCap }> = [
  { role: 'student', icon: GraduationCap },
  { role: 'teacher', icon: BookOpen },
]

/** One stored name per role: a teacher and a student share this screen. */
const LAST_USERNAME_PREFIX = 'auth.lastUsername'
const LAST_ROLE_KEY = 'auth.lastRole'
const REMEMBER_KEY = 'auth.remember'

interface Remembered {
  role: PickableRole
  username: string
  password: string
}

const selectedRole = ref<PickableRole>('student')
/** One draft name per role, so a tab swap never loses what was typed. */
const names = reactive<Record<PickableRole, string>>({ student: '', teacher: '' })
const password = ref('')
const remember = ref(false)
const showPassword = ref(false)
const errorKey = ref('')
const submitting = ref(false)

const usernamePlaceholder = computed(() =>
  selectedRole.value === 'teacher' ? 'teacher' : 'student',
)

/** Bound to the field, and to whichever role is on screen. */
const username = computed({
  get: () => names[selectedRole.value],
  set: (value: string) => {
    names[selectedRole.value] = value
  },
})

const isTeacher = computed(() => selectedRole.value === 'teacher')

/**
 * The role indicator is measured, not guessed. The sliding fill is positioned in
 * the container's own pixels, so it lands on the active cell exactly, and a
 * resize re-measures it - the same shape the tab strips use, and for the same
 * reason: a fill positioned with a percentage in a transform is re-sampled as it
 * moves, which the software rendering path shows as a stutter.
 */
const roleBar = ref<HTMLElement | null>(null)
const roleIndicator = ref({ left: 0, width: 0 })
/** Snaps for the first placement and for resizes; slides only for a choice. */
const roleSnap = ref(true)

function measureRole(): void {
  const root = roleBar.value
  if (!root) return
  const active = root.querySelector<HTMLElement>('[data-active="true"]')
  if (!active) return
  const rootBox = root.getBoundingClientRect()
  const box = active.getBoundingClientRect()
  roleIndicator.value = { left: box.left - rootBox.left, width: box.width }
}

let roleObserver: ResizeObserver | null = null

onMounted(() => {
  requestAnimationFrame(measureRole)
  if (roleBar.value) {
    roleObserver = new ResizeObserver(() => {
      roleSnap.value = true
      measureRole()
    })
    roleObserver.observe(roleBar.value)
  }
})

onBeforeUnmount(() => roleObserver?.disconnect())

watch(selectedRole, () => requestAnimationFrame(measureRole))

/**
 * The stored name for one role.
 *
 * Per role, not one shared name: the two roles are two people on one machine as
 * often as not - a teacher checking a student's account on their own phone -
 * and a single field that carried the last name across both would put the wrong
 * one in front of the wrong person.
 */
function usernameKey(role: PickableRole): string {
  return `${LAST_USERNAME_PREFIX}.${role}`
}

function selectRole(role: PickableRole): void {
  if (selectedRole.value === role) return
  roleSnap.value = false
  selectedRole.value = role
  localStorage.setItem(LAST_ROLE_KEY, role)
  // The field above now reads the other role's draft through the computed, so a
  // teacher name cannot follow the reader onto the student tab. The error goes
  // with it: it described the name that was just typed over.
  errorKey.value = ''
}

function readRemembered(): Remembered | null {
  const raw = localStorage.getItem(REMEMBER_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<Remembered>
    if (!parsed.username || !parsed.password) return null
    const role: PickableRole = parsed.role === 'teacher' ? 'teacher' : 'student'
    return { role, username: parsed.username, password: parsed.password }
  } catch {
    // A stored value that is not ours — an older build, or a hand-edited one.
    return null
  }
}

function errorMessage(key: string): string {
  switch (key) {
    case 'INVALID_CREDENTIALS':
      return t('auth.errors.invalidCredentials')
    case 'PENDING_APPROVAL':
      return t('auth.errors.pendingApproval')
    case 'BLOCKED':
      return t('auth.errors.blocked')
    case 'NETWORK':
      return t('auth.errors.network')
    default:
      return t('auth.errors.generic')
  }
}

onMounted(async () => {
  const savedRole = localStorage.getItem(LAST_ROLE_KEY)
  if (savedRole === 'teacher' || savedRole === 'student') selectedRole.value = savedRole

  const remembered = readRemembered()
  if (remembered) {
    selectedRole.value = remembered.role
    names[remembered.role] = remembered.username
    password.value = remembered.password
    remember.value = true
    // The whole point of the box: no typing, no click. A failure lands on the
    // filled-in form with no message — a wrong password here is not something
    // the reader did wrong, and saying so would just be noise on launch.
    try {
      await signIn(remembered.username, remembered.password)
      return
    } catch {
      password.value = ''
      remember.value = false
      localStorage.removeItem(REMEMBER_KEY)
    }
  }

  const saved = localStorage.getItem(usernameKey(selectedRole.value)) ?? ''
  names[selectedRole.value] =
    saved || (isTeacher.value ? 'teacher' : '')
})

async function submit(): Promise<void> {
  errorKey.value = ''
  const name = username.value.trim()
  submitting.value = true
  try {
    await signIn(name, password.value)
    // Only persisted on success, so a typo never overwrites a good name.
    localStorage.setItem(usernameKey(selectedRole.value), name)
    localStorage.setItem(LAST_ROLE_KEY, selectedRole.value)
    if (remember.value) {
      const payload: Remembered = {
        role: selectedRole.value,
        username: name,
        password: password.value,
      }
      localStorage.setItem(REMEMBER_KEY, JSON.stringify(payload))
    } else {
      localStorage.removeItem(REMEMBER_KEY)
    }
  } catch (error) {
    errorKey.value = error instanceof ApiError ? error.code : ''
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="flex min-h-dvh flex-col bg-surface">
    <AppHeader />
    <main class="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 pb-10">
      <!-- The brand over the box, so the screen says what it is before it asks
           anything. Decorative: the heading inside the card is the question. -->
      <BrandWordmark
        :height="30"
        class="mx-auto mb-6 shrink-0 text-primary"
        aria-hidden="true"
      />
      <AppCard as="section" padding="lg" class="shadow-sm">
        <h2 class="text-lg font-semibold text-balance text-on-surface">
          {{ t('auth.chooseRole') }}
        </h2>
        <p class="mt-1 text-sm text-balance text-on-surface-variant">
          {{ t('auth.chooseRoleHint') }}
        </p>

        <!-- Two segments, equal width, so the row does not move when the locale
             changes. Colour is the only thing that animates: the fill crossfades,
             nothing slides, and nothing scales under the pointer. -->
        <!--
          A segmented control with the same measured, sliding indicator the tab
          strips use: one fill travels between the two roles instead of each cell
          repainting its own, so a switch reads as a single piece of motion that
          lands exactly on the cell it selects.
        -->
        <div
          ref="roleBar"
          class="relative mt-5 grid grid-cols-2 gap-1 rounded-[var(--radius-card)] border border-outline-variant bg-surface-container p-1"
        >
          <span
            aria-hidden="true"
            class="tab-indicator pointer-events-none absolute inset-y-1 rounded-[var(--radius-control)] bg-primary"
            :class="{ 'tab-indicator-snap': roleSnap }"
            :style="{
              transform: `translateX(${roleIndicator.left}px)`,
              width: `${roleIndicator.width}px`,
            }"
          />
          <button
            v-for="{ role, icon } in ROLES"
            :key="role"
            type="button"
            :data-active="selectedRole === role"
            :aria-pressed="selectedRole === role"
            class="state-layer tab-label relative z-1 flex min-w-0 flex-col items-center gap-1.5 rounded-[var(--radius-control)] px-1 py-3 text-xs font-semibold"
            :class="selectedRole === role ? 'text-on-primary' : 'text-on-surface-variant'"
            @click="selectRole(role)"
          >
            <component :is="icon" class="size-5 shrink-0" aria-hidden="true" />
            <span class="max-w-full truncate">{{ t(`role.${role}`) }}</span>
          </button>
        </div>

        <form class="mt-5 space-y-4" @submit.prevent="submit">
          <label class="block">
            <span class="text-xs font-medium text-on-surface-variant">
              {{ t('auth.username') }}
            </span>
            <AppInput
              v-model="username"
              type="text"
              autocomplete="username"
              :placeholder="usernamePlaceholder"
              class="mt-1"
            />
          </label>

          <label class="block">
            <span class="text-xs font-medium text-on-surface-variant">
              {{ t('auth.password') }}
            </span>
            <div class="relative mt-1.5">
              <AppInput
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="current-password"
                placeholder="••••••••"
                class="pr-12"
              />
              <!--
                A plain button, not AppButton: the ghost variant paints a hover
                fill, and a fill painted over the field's own box covers the text
                underneath it. This one sits on the input and has to stay out of
                its way - the hover state is the icon changing colour.
              -->
              <button
                type="button"
                class="absolute right-0 top-1/2 mr-0.5 flex size-9 -translate-y-1/2 items-center justify-center rounded-[var(--radius-control)] text-on-surface-variant hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                :aria-label="showPassword ? t('auth.hidePassword') : t('auth.showPassword')"
                v-tip="showPassword ? t('auth.hidePassword') : t('auth.showPassword')"
                @mousedown.prevent
                @click="showPassword = !showPassword"
              >
                <EyeOff v-if="showPassword" class="size-4" aria-hidden="true" />
                <Eye v-else class="size-4" aria-hidden="true" />
              </button>
            </div>
          </label>

          <AppCheckbox v-model="remember" :label="t('auth.rememberMe')" />

          <p
            v-if="errorKey"
            role="alert"
            class="rounded-lg bg-error-container px-3 py-2 text-sm text-on-error-container"
          >
            {{ errorMessage(errorKey) }}
          </p>

          <AppButton
            variant="primary"
            size="lg"
            type="submit"
            class="mt-1 w-full"
            :disabled="submitting"
          >
            {{ submitting ? t('common.loading') : t('auth.signIn') }}
          </AppButton>
        </form>

        <!-- What the role decides. A student can make an account in one tap from
             a class QR; a teacher cannot, and is told who makes one. -->
        <div
          class="mt-4 flex min-h-11 items-center justify-center border-t border-outline-variant pt-4 text-center text-sm"
        >
          <template v-if="isTeacher">
            <span class="text-on-surface-variant">{{ t('auth.teacherAccountHint') }}</span>
          </template>
          <template v-else>
            <span class="text-on-surface-variant">{{ t('auth.needAccount') }}</span>
            <button
              type="button"
              class="ml-1 font-semibold text-on-surface underline underline-offset-2"
              @click="emit('register')"
            >
              {{ t('auth.register') }}
            </button>
          </template>
        </div>
      </AppCard>
    </main>
  </div>
</template>