<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowDown, ArrowUp, Check, FilterX, KeyRound, UserX } from '@lucide/vue'
import { listUsers, setUserStatus, setUserPassword, createUser } from '../../api/users'
import { ApiError } from '../../api/client'
import EmptyState from '../common/EmptyState.vue'
import SkeletonList from '../common/SkeletonList.vue'
import { useConfirm } from '../../composables/confirm'
import { useToast } from '../../composables/toast'
import { useTableSort } from '../../composables/tableSort'
import type { PublicUser, UserRole, UserStatus } from '../../api/types'
import AppButton from '../../components/common/AppButton.vue'
import AppCard from '../../components/common/AppCard.vue'
import AppInput from '../../components/common/AppInput.vue'
import AppDialog from '../../components/common/AppDialog.vue'

const props = defineProps<{
  focusStatus?: UserStatus | ''
}>()

const emit = defineEmits<{ changed: [] }>()

const { t } = useI18n()
const confirm = useConfirm()
const toast = useToast()

/** The account whose password is being set, and what it is being set to. */
const passwordFor = ref<PublicUser | null>(null)
const passwordDraft = ref('')
const passwordError = ref('')
const passwordBusy = ref(false)

const users = ref<PublicUser[]>([])
const loading = ref(false)
const errorKey = ref('')
const query = ref('')
const roleFilter = ref<'all' | UserRole>('all')
const statusFilter = ref<'all' | UserStatus>('all')
const busyId = ref('')
const showCreateForm = ref(false)
const creating = ref(false)
const formError = ref('')
const form = ref({ username: '', password: '', fullName: '' })
const selected = ref<string[]>([])

const roleBadgeClass: Record<UserRole, string> = {
  admin: 'bg-primary-container text-on-primary-container',
  teacher: 'bg-secondary-container text-on-secondary-container',
  student: 'bg-warning-container text-on-warning-container',
}

const statusBadgeClass: Record<UserStatus, string> = {
  pending: 'bg-warning-container text-on-warning-container',
  approved: 'bg-success-container text-on-success-container',
  blocked: 'bg-error-container text-on-error-container',
}

const statusRank: Record<UserStatus, number> = { pending: 0, approved: 1, blocked: 2 }

const { sorted, toggle, ariaSort } = useTableSort(
  users,
  {
    name: (user) => user.fullName,
    username: (user) => user.username,
    role: (user) => user.role,
    status: (user) => statusRank[user.status],
  },
  'name',
)

const pendingUsers = computed(() => users.value.filter((user) => user.status === 'pending'))
const filtersActive = computed(
  () =>
    query.value.trim().length > 0 ||
    roleFilter.value !== 'all' ||
    statusFilter.value !== 'all',
)

function resetFilters(): void {
  query.value = ''
  roleFilter.value = 'all'
  statusFilter.value = 'all'
}
const selectableIds = computed(() => pendingUsers.value.map((user) => user.id))
const allPendingSelected = computed(
  () => selectableIds.value.length > 0 && selectableIds.value.every((id) => selected.value.includes(id)),
)

async function load() {
  loading.value = true
  errorKey.value = ''
  try {
    users.value = await listUsers({
      role: roleFilter.value === 'all' ? undefined : roleFilter.value,
      status: statusFilter.value === 'all' ? undefined : statusFilter.value,
      q: query.value.trim() || undefined,
    })
    // Drop selections that no longer exist after filtering or status changes.
    selected.value = selected.value.filter((id) => users.value.some((user) => user.id === id))
  } catch (error) {
    errorKey.value = error instanceof ApiError ? error.code : ''
  } finally {
    loading.value = false
  }
}

async function changeStatus(user: PublicUser, status: UserStatus) {
  if (status === 'blocked') {
    const ok = await confirm({
      message: t('admin.blockConfirm', { username: user.username }),
    })
    if (!ok) return
  }
  busyId.value = user.id
  try {
    await setUserStatus(user.id, status)
    toast.success(
      status === 'approved' ? t('admin.toastApproved') : t('admin.toastBlocked'),
    )
    await load()
    emit('changed')
  } finally {
    busyId.value = ''
  }
}

/**
 * Sets a password for somebody who cannot change their own.
 *
 * The only way back into a locked-out account: the holder cannot change it
 * without the old one, and the admin has it. The dialog says what the change
 * does - every session that user held ends - because an admin who sets a
 * password and watches the class stay signed in has been told nothing.
 */
function openPassword(user: PublicUser): void {
  passwordDraft.value = ''
  passwordError.value = ''
  passwordFor.value = user
}

async function applyPassword(): Promise<void> {
  const user = passwordFor.value
  if (!user || passwordBusy.value) return
  if (passwordDraft.value.length < 8) {
    passwordError.value = t('admin.users.passwordTooShort')
    return
  }
  passwordBusy.value = true
  passwordError.value = ''
  try {
    await setUserPassword(user.id, passwordDraft.value)
    passwordFor.value = null
    toast.success(t('admin.users.passwordChanged', { username: user.username }))
  } catch (error) {
    passwordError.value =
      error instanceof ApiError && error.code === 'NOT_FOUND'
        ? t('admin.users.passwordFailed')
        : t('admin.users.passwordFailed')
  } finally {
    passwordBusy.value = false
  }
}

function isSelected(id: string): boolean {
  return selected.value.includes(id)
}

function toggleSelected(id: string): void {
  selected.value = isSelected(id)
    ? selected.value.filter((entry) => entry !== id)
    : [...selected.value, id]
}

function toggleAllPending(): void {
  selected.value = allPendingSelected.value ? [] : [...selectableIds.value]
}

async function approveSelected(): Promise<void> {
  const ids = [...selected.value]
  if (ids.length === 0) return
  busyId.value = 'bulk'
  try {
    for (const id of ids) await setUserStatus(id, 'approved')
    toast.success(t('admin.bulk.approved', { count: ids.length }))
    selected.value = []
    await load()
    emit('changed')
  } finally {
    busyId.value = ''
  }
}

async function createTeacher() {
  formError.value = ''
  const username = form.value.username.trim()
  const fullName = form.value.fullName.trim()
  if (!fullName) {
    formError.value = t('auth.form.fullNameRequired')
    return
  }
  if (username.length < 3) {
    formError.value = t('auth.form.usernameTooShort')
    return
  }
  if (form.value.password.length < 8) {
    formError.value = t('auth.form.passwordMin')
    return
  }
  creating.value = true
  try {
    await createUser({ username, password: form.value.password, fullName })
    toast.success(t('admin.toastTeacherCreated'))
    showCreateForm.value = false
    form.value = { username: '', password: '', fullName: '' }
    await load()
    emit('changed')
  } catch (error) {
    if (error instanceof ApiError) {
      formError.value =
        error.code === 'CONFLICT'
          ? t('auth.errors.usernameTaken')
          : error.code === 'NETWORK'
            ? t('auth.errors.network')
            : t('auth.errors.generic')
    } else {
      formError.value = t('auth.errors.generic')
    }
  } finally {
    creating.value = false
  }
}

onMounted(load)
watch([query, roleFilter, statusFilter], () => void load())
// The dashboard can ask the tab to jump straight to a status filter.
watch(
  () => props.focusStatus,
  (status) => {
    if (status) statusFilter.value = status
  },
  { immediate: true },
)
</script>

<template>
  <section>
    <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
      <AppInput
        v-model="query"
        type="search"
        :aria-label="t('admin.searchPlaceholder')"
        :placeholder="t('admin.searchPlaceholder')"
        class="sm:max-w-56"
      />
      <select
        v-model="roleFilter"
        :aria-label="t('admin.roleFilter')"
        class="rounded-lg border border-outline bg-surface px-3 py-2 text-sm focus:border-primary"
      >
        <option value="all">{{ t('admin.anyRole') }}</option>
        <option value="student">{{ t('role.student') }}</option>
        <option value="teacher">{{ t('role.teacher') }}</option>
        <option value="admin">{{ t('role.admin') }}</option>
      </select>
      <select
        v-model="statusFilter"
        :aria-label="t('admin.statusFilter')"
        class="rounded-lg border border-outline bg-surface px-3 py-2 text-sm focus:border-primary"
      >
        <option value="all">{{ t('admin.anyStatus') }}</option>
        <option value="pending">{{ t('admin.status.pending') }}</option>
        <option value="approved">{{ t('admin.status.approved') }}</option>
        <option value="blocked">{{ t('admin.status.blocked') }}</option>
      </select>
      <AppButton variant="secondary" @click="load">
        {{ t('admin.refresh') }}
      </AppButton>
      <AppButton variant="primary" @click="showCreateForm = !showCreateForm">
        {{ t('admin.newTeacher') }}
      </AppButton>
    </div>

    <form
      v-if="showCreateForm"
      class="mt-4 rounded-2xl border border-outline-variant bg-surface-container p-4 shadow-sm"
      @submit.prevent="createTeacher"
    >
      <h3 class="text-sm font-semibold text-on-surface">
        {{ t('admin.teacherForm.title') }}
      </h3>
      <div class="mt-3 grid gap-3 sm:grid-cols-2">
        <AppInput
          v-model="form.fullName"
          type="text"
          required
          :aria-label="t('admin.teacherForm.fullName')"
          :placeholder="t('admin.teacherForm.fullName')"
        />
        <AppInput
          v-model="form.username"
          type="text"
          required
          autocomplete="username"
          :aria-label="t('admin.teacherForm.username')"
          :placeholder="t('admin.teacherForm.username')"
        />
        <input
          v-model="form.password"
          type="password"
          required
          autocomplete="new-password"
          :aria-label="t('admin.teacherForm.password')"
          :placeholder="t('admin.teacherForm.password')"
          class="w-full rounded-lg border border-outline bg-surface px-3 py-2 text-sm focus:border-primary sm:col-span-2"
        />
      </div>
      <p v-if="formError" role="alert" class="mt-3 text-sm text-error">
        {{ formError }}
      </p>
      <div class="mt-4 flex justify-end gap-2">
        <AppButton variant="secondary" @click="showCreateForm = false; formError = ''">
          {{ t('admin.cancel') }}
        </AppButton>
        <AppButton variant="success" type="submit" :disabled="creating">
          {{ t('admin.teacherForm.create') }}
        </AppButton>
      </div>
    </form>

    <p
      v-if="errorKey"
      role="alert"
      class="mt-4 rounded-lg bg-error-container px-3 py-2 text-sm text-on-error-container"
    >
      {{ errorKey === 'NETWORK' ? t('auth.errors.network') : t('auth.errors.generic') }}
    </p>

    <SkeletonList v-else-if="loading" class="mt-4" variant="table" :rows="5" />

    <EmptyState
      v-else-if="users.length === 0"
      class="mt-4"
      :icon="UserX"
      :title="t('admin.emptyTitle')"
      :description="t('admin.emptyHint')"
      :action-label="filtersActive ? t('admin.clearFilters') : ''"
      :action-icon="FilterX"
      @action="resetFilters"
    />

    <template v-else>
      <!-- bulk bar for pending accounts -->
      <div class="mt-4 flex flex-wrap items-center justify-between gap-2">
        <p class="text-xs font-semibold text-on-surface-variant">
          {{ t('admin.total', { count: users.length }) }}
        </p>
        <div v-if="pendingUsers.length" class="flex items-center gap-2">
          <AppButton variant="secondary" @click="toggleAllPending">
            <Check class="size-3.5" aria-hidden="true" />
            {{ allPendingSelected ? t('admin.bulk.clearSelection') : t('admin.bulk.selectAll') }}
          </AppButton>
          <AppButton
  variant="success"
  :disabled="selected.length === 0 || busyId === 'bulk'"
  @click="approveSelected"
>
            {{ t('admin.bulk.approveSelected', { count: selected.length }) }}
          </AppButton>
        </div>
      </div>

      <!-- wide screens: sortable table -->
      <div
        class="mt-3 hidden overflow-x-auto rounded-2xl border border-outline-variant bg-surface-container shadow-sm sm:block"
      >
        <table class="w-full border-collapse text-sm">
          <thead>
            <tr class="border-b border-outline-variant text-left text-xs uppercase tracking-wide text-on-surface-variant">
              <th v-if="pendingUsers.length" scope="col" class="w-10 px-3 py-2.5">
                <span class="sr-only">{{ t('admin.bulk.selectAll') }}</span>
              </th>
              <th scope="col" class="px-3 py-2.5" :aria-sort="ariaSort('name')">
                <button
                  type="button"
                  class="inline-flex min-h-8 items-center gap-1 px-1 font-semibold hover:text-on-surface"
                  @click="toggle('name')"
                >
                  {{ t('admin.col.name') }}
                  <ArrowDown v-if="ariaSort('name') === 'ascending'" class="size-3" aria-hidden="true" />
                  <ArrowUp v-else-if="ariaSort('name') === 'descending'" class="size-3" aria-hidden="true" />
                </button>
              </th>
              <th scope="col" class="px-3 py-2.5" :aria-sort="ariaSort('role')">
                <button
                  type="button"
                  class="inline-flex min-h-8 items-center gap-1 px-1 font-semibold hover:text-on-surface"
                  @click="toggle('role')"
                >
                  {{ t('admin.col.role') }}
                  <ArrowDown v-if="ariaSort('role') === 'ascending'" class="size-3" aria-hidden="true" />
                  <ArrowUp v-else-if="ariaSort('role') === 'descending'" class="size-3" aria-hidden="true" />
                </button>
              </th>
              <th scope="col" class="px-3 py-2.5" :aria-sort="ariaSort('status')">
                <button
                  type="button"
                  class="inline-flex min-h-8 items-center gap-1 px-1 font-semibold hover:text-on-surface"
                  @click="toggle('status')"
                >
                  {{ t('admin.col.status') }}
                  <ArrowDown v-if="ariaSort('status') === 'ascending'" class="size-3" aria-hidden="true" />
                  <ArrowUp v-else-if="ariaSort('status') === 'descending'" class="size-3" aria-hidden="true" />
                </button>
              </th>
              <th scope="col" class="px-3 py-2.5 text-right">
                {{ t('admin.col.actions') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="user in sorted"
              :key="user.id"
              class="state-layer border-b border-outline-variant last:border-0"
            >
              <td v-if="pendingUsers.length" class="px-3 py-2.5">
                <input
                  v-if="user.status === 'pending'"
                  type="checkbox"
                  :checked="isSelected(user.id)"
                  :aria-label="t('admin.bulk.selectUser', { username: user.username })"
                  class="size-4"
                  @change="toggleSelected(user.id)"
                />
              </td>
              <td class="px-3 py-2.5">
                <p class="truncate font-semibold text-on-surface">{{ user.fullName }}</p>
                <p class="truncate text-xs text-on-surface-variant">@{{ user.username }}</p>
              </td>
              <td class="px-3 py-2.5">
                <span
                  class="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  :class="roleBadgeClass[user.role]"
                >
                  {{ t(`role.${user.role}`) }}
                </span>
              </td>
              <td class="px-3 py-2.5">
                <span
                  class="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  :class="statusBadgeClass[user.status]"
                >
                  {{ t(`admin.status.${user.status}`) }}
                </span>
              </td>
              <td class="px-3 py-2.5">
                <div v-if="user.role !== 'admin'" class="flex justify-end gap-2">
                  <AppButton
  variant="success"
  v-if="user.status !== 'approved'"
  :disabled="busyId === user.id"
  @click="changeStatus(user, 'approved')"
>
                    {{ t('admin.approve') }}
                  </AppButton>
                  <AppButton
                    v-if="user.status !== 'blocked'"
                    type="button"
                    :disabled="busyId === user.id"
                    @click="changeStatus(user, 'blocked')"
                    variant="dangerSecondary" size="sm"
                  >
                    {{ t('admin.block') }}
                  </AppButton>
                  <AppButton
                    type="button"
                    :disabled="busyId === user.id"
                    :aria-label="t('admin.users.setPasswordFor', { username: user.username })"
                    @click="openPassword(user)"
                    variant="secondaryMuted" size="sm"
                  >
                    <KeyRound class="size-3.5" aria-hidden="true" />
                    {{ t('admin.users.password') }}
                  </AppButton>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- narrow screens: cards -->
      <ul class="mt-4 space-y-2 sm:hidden">
        <AppCard as="li" v-for="user in sorted" :key="user.id" class="flex flex-col gap-3 shadow-sm">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <p class="truncate text-sm font-semibold text-on-surface">
                {{ user.fullName }}
              </p>
              <span
                class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                :class="roleBadgeClass[user.role]"
              >
                {{ t(`role.${user.role}`) }}
              </span>
              <span
                class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                :class="statusBadgeClass[user.status]"
              >
                {{ t(`admin.status.${user.status}`) }}
              </span>
            </div>
            <p class="mt-0.5 text-xs text-on-surface-variant">@{{ user.username }}</p>
          </div>

          <div v-if="user.role !== 'admin'" class="flex shrink-0 items-center gap-2">
            <AppButton
              v-if="user.status === 'pending'"
              type="button"
              :checked="isSelected(user.id)"
              :aria-label="t('admin.bulk.selectUser', { username: user.username })"
              variant="secondaryMuted" size="sm"
              @click="toggleSelected(user.id)"
            >
              <Check v-if="isSelected(user.id)" class="size-3.5" aria-hidden="true" />
              {{ t('admin.bulk.select') }}
            </AppButton>
            <AppButton
  variant="success"
  v-if="user.status !== 'approved'"
  :disabled="busyId === user.id"
  @click="changeStatus(user, 'approved')"
>
              {{ t('admin.approve') }}
            </AppButton>
            <AppButton
              v-if="user.status !== 'blocked'"
              type="button"
              :disabled="busyId === user.id"
              @click="changeStatus(user, 'blocked')"
              variant="dangerSecondary" size="sm"
            >
              {{ t('admin.block') }}
            </AppButton>
            <AppButton
              type="button"
              :disabled="busyId === user.id"
              :aria-label="t('admin.users.setPasswordFor', { username: user.username })"
              @click="openPassword(user)"
              variant="secondaryMuted" size="sm"
            >
              <KeyRound class="size-3.5" aria-hidden="true" />
              {{ t('admin.users.password') }}
            </AppButton>
          </div>
        </AppCard>
      </ul>
    </template>

    <!--
      Setting a password for somebody who cannot change their own. The dialog is
      a dialog rather than a field in the row because the row is already four
      controls wide and because the consequence - every session that user held
      ends - deserves a sentence of its own.
    -->
    <AppDialog
      v-if="passwordFor"
      :label="t('admin.users.passwordTitle', { username: passwordFor.username })"
      @close="passwordFor = null"
    >
      <form class="space-y-3 p-4" @submit.prevent="applyPassword">
        <p class="text-xs text-on-surface-variant">{{ t('admin.users.passwordHint') }}</p>
        <AppInput
          v-model="passwordDraft"
          type="password"
          autocomplete="new-password"
          :placeholder="t('admin.users.passwordPlaceholder')"
        />
        <p
          v-if="passwordError"
          role="alert"
          class="rounded-xl bg-error-container px-3 py-2 text-xs text-on-error-container"
        >
          {{ passwordError }}
        </p>
        <div class="flex justify-end gap-2">
          <AppButton variant="secondary" type="button" @click="passwordFor = null">
            {{ t('common.cancel') }}
          </AppButton>
          <AppButton variant="primary" type="submit" :disabled="passwordBusy">
            {{ t('admin.users.passwordApply') }}
          </AppButton>
        </div>
      </form>
    </AppDialog>
  </section>
</template>