<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleCheck, Eye, EyeOff } from '@lucide/vue'
import AppHeader from '../components/AppHeader.vue'
import { register } from '../api/auth'
import { previewRoomKey } from '../api/rooms'
import { ApiError } from '../api/client'
import type { RoomPreview } from '../api/types'
import AppButton from '../components/common/AppButton.vue'
import AppCard from '../components/common/AppCard.vue'
import AppInput from '../components/common/AppInput.vue'

/**
 * Creating a student account, with an optional class key.
 *
 * The key is the whole reason a teacher can run a class alone: it approves the
 * account without an admin in the room. It is optional and it is checked before
 * the password is typed, so a student learns "9A · Olena M." - or that
 * the code is wrong - before they have committed to anything.
 */
const emit = defineEmits<{ back: []; server: [] }>()

const { t } = useI18n()

const fullName = ref('')
const username = ref('')
const password = ref('')
const confirmPassword = ref('')
/** One toggle per field: the same show/hide button the sign-in form carries. */
const showPassword = ref(false)
const showConfirmPassword = ref(false)
const roomKey = ref('')
const errorKey = ref('')
const submitting = ref(false)

/** null = nothing typed yet; false = the code is not usable. */
const roomPreview = ref<RoomPreview | null>(null)
const classChecked = ref(false)
const classErrorKey = ref('')
const checkingRoom = ref(false)

/** What happened to the account: approved through a key, or waiting for an admin. */
const created = ref<{ approved: boolean; roomName?: string } | null>(null)

function validate(): string {
  if (!fullName.value.trim()) return 'fullNameRequired'
  if (username.value.trim().length < 3) return 'usernameTooShort'
  if (password.value.length < 8) return 'passwordMin'
  if (password.value !== confirmPassword.value) return 'passwordMismatch'
  return ''
}

const FORM_ERROR_KEYS = ['fullNameRequired', 'usernameTooShort', 'passwordMin', 'passwordMismatch'] as const

function errorMessage(key: string): string {
  if ((FORM_ERROR_KEYS as readonly string[]).includes(key)) {
    return t(`auth.form.${key}`)
  }
  switch (key) {
    case 'CONFLICT':
      return t('auth.errors.usernameTaken')
    case 'INVALID_CLASS_KEY':
      return t('auth.errors.roomKeyWrong')
    case 'VALIDATION':
      return t('auth.errors.validation')
    case 'NETWORK':
      return t('auth.errors.network')
    default:
      return t('auth.errors.generic')
  }
}

/**
 * Asks the server what the code leads to. Runs on blur rather than on every
 * keystroke: a lookup per character would be both rude to the server and
 * useless, since nobody finishes typing a six-character code in under a second.
 */
async function checkRoom(): Promise<void> {
  const key = roomKey.value.trim()
  if (key === '') {
    classChecked.value = false
    roomPreview.value = null
    classErrorKey.value = ''
    return
  }
  checkingRoom.value = true
  classErrorKey.value = ''
  try {
    roomPreview.value = await previewRoomKey(key)
    classChecked.value = true
  } catch (error) {
    roomPreview.value = null
    classChecked.value = true
    classErrorKey.value = error instanceof ApiError && error.code === 'NETWORK' ? 'network' : 'wrong'
  } finally {
    checkingRoom.value = false
  }
}

async function submit() {
  errorKey.value = ''
  const invalid = validate()
  if (invalid) {
    errorKey.value = invalid
    return
  }
  submitting.value = true
  try {
    const result = await register({
      fullName: fullName.value.trim(),
      username: username.value.trim(),
      password: password.value,
      ...(roomKey.value.trim() === '' ? {} : { roomKey: roomKey.value.trim() }),
    })
    created.value = {
      approved: result.user.status === 'approved',
      roomName: result.viaRoom?.roomName,
    }
  } catch (error) {
    errorKey.value = error instanceof ApiError ? error.code : ''
  } finally {
    submitting.value = false
  }
}

function back() {
  created.value = null
  emit('back')
}

// A QR code of the class link carries the key in the URL; pick it up on arrival.
onMounted(() => {
  const key = new URLSearchParams(window.location.search).get('class')
  if (!key) return
  roomKey.value = key.trim().toUpperCase()
  void checkRoom()
})
</script>

<template>
  <div class="flex min-h-dvh flex-col bg-surface">
    <AppHeader hosted @server="emit('server')" />
    <main class="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-10">
    <section
      v-if="created"
      class="rounded-2xl border border-outline-variant bg-success-container p-6 text-center shadow-sm"
    >
      <p class="text-lg font-semibold text-success">
        {{ created.approved ? t('auth.readyTitle') : t('auth.pendingTitle') }}
      </p>
      <p class="mt-2 text-sm text-success">
        <template v-if="created.approved">
          {{ t('auth.readyNote', { roomName: created.roomName ?? '' }) }}
        </template>
        <template v-else>{{ t('auth.pendingNote') }}</template>
      </p>
      <AppButton variant="success" class="mt-5" @click="back">
        {{ t('auth.backToLogin') }}
      </AppButton>
    </section>

    <AppCard as="section" padding="lg" v-else class="shadow-sm">
      <h2 class="text-lg font-semibold text-on-surface">
        {{ t('auth.registerHeading') }}
      </h2>
      <p class="mt-1 text-sm text-on-surface-variant">
        {{ t('auth.registerHint') }}
      </p>

      <form class="mt-5 space-y-4" @submit.prevent="submit">
        <!--
          Optional on purpose: a student without a code registers exactly as
          before and waits for an admin. A student with one is in immediately.
          First in the form: the key decides whether the account is approved at
          all, so it is the first question - the name and the password read the
          same either way.
        -->
        <div>
          <label class="block">
            <span class="flex items-baseline gap-2 text-xs font-medium text-on-surface-variant">
              {{ t('auth.roomKey') }}
              <span class="font-normal text-on-surface-variant/80">{{ t('auth.roomKeyOptional') }}</span>
            </span>
            <AppInput
              v-model="roomKey"
              type="text"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck="false"
              maxlength="7"
              placeholder="ABC234"
              class="mt-1 font-mono uppercase tracking-[0.2em]"
              @blur="checkRoom"
            />
          </label>

          <p
            v-if="checkingRoom"
            class="mt-1.5 text-xs text-on-surface-variant"
          >
            {{ t('common.loading') }}
          </p>
          <p
            v-else-if="roomPreview"
            class="mt-1.5 flex items-start gap-2 rounded-[var(--radius-control)] bg-success-container px-3 py-2 text-xs text-on-success-container"
          >
            <CircleCheck class="mt-px size-4 shrink-0" aria-hidden="true" />
            <span>
              {{ t('auth.roomKeyFound') }}
              <span class="font-semibold">{{ roomPreview.roomName }}</span>
              <template v-if="roomPreview.teacherName">
                · {{ roomPreview.teacherName }}
              </template>
            </span>
          </p>
          <p
            v-else-if="classErrorKey"
            class="mt-1.5 rounded-[var(--radius-control)] bg-error-container px-3 py-2 text-xs text-on-error-container"
          >
            {{
              classErrorKey === 'network'
                ? t('auth.errors.network')
                : t('auth.errors.roomKeyWrong')
            }}
          </p>
        </div>

        <label class="block">
          <span class="text-xs font-medium text-on-surface-variant">
            {{ t('auth.username') }}
          </span>
          <AppInput v-model="username" type="text" autocomplete="username" class="mt-1" />
        </label>

        <label class="block">
          <span class="text-xs font-medium text-on-surface-variant">
            {{ t('auth.fullName') }}
          </span>
          <AppInput v-model="fullName" type="text" autocomplete="name" class="mt-1" />
        </label>

        <label class="block">
          <span class="text-xs font-medium text-on-surface-variant">
            {{ t('auth.password') }}
          </span>
          <div class="relative mt-1.5">
            <AppInput
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="new-password"
              class="pr-12"
            />
            <!--
              A plain button, not AppButton: the ghost variant paints a hover
              fill, and a fill painted over the field's own box covers the text
              underneath it. This one sits on the input and has to stay out of
              its way - the hover state is the icon changing colour. The same
              toggle the sign-in field carries.
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

        <label class="block">
          <span class="text-xs font-medium text-on-surface-variant">
            {{ t('auth.confirmPassword') }}
          </span>
          <div class="relative mt-1.5">
            <AppInput
              v-model="confirmPassword"
              :type="showConfirmPassword ? 'text' : 'password'"
              autocomplete="new-password"
              class="pr-12"
            />
            <button
              type="button"
              class="absolute right-0 top-1/2 mr-0.5 flex size-9 -translate-y-1/2 items-center justify-center rounded-[var(--radius-control)] text-on-surface-variant hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              :aria-label="showConfirmPassword ? t('auth.hidePassword') : t('auth.showPassword')"
              v-tip="showConfirmPassword ? t('auth.hidePassword') : t('auth.showPassword')"
              @mousedown.prevent
              @click="showConfirmPassword = !showConfirmPassword"
            >
              <EyeOff v-if="showConfirmPassword" class="size-4" aria-hidden="true" />
              <Eye v-else class="size-4" aria-hidden="true" />
            </button>
          </div>
        </label>

        <p
          v-if="errorKey"
          role="alert"
          class="rounded-lg bg-error-container px-3 py-2 text-sm text-on-error-container"
        >
          {{ errorMessage(errorKey) }}
        </p>

        <AppButton variant="primary" type="submit" :disabled="submitting" class="w-full">
          {{ submitting ? t('common.loading') : t('auth.register') }}
        </AppButton>

        <!--
          Back to sign in: under the primary action, where the eye ends up
          after the form, instead of floating above the card it belongs to.
          Same box and label size as the submit button above, only quieter
          in colour.
        -->
        <AppButton type="button" @click="back" variant="secondaryMuted" class="w-full">
          {{ t('auth.backToLogin') }}
        </AppButton>
      </form>
    </AppCard>
    </main>
  </div>
</template>