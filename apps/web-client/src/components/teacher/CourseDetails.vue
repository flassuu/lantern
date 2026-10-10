<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, ClipboardList, Paperclip, Upload, Users } from '@lucide/vue'
import { ApiError } from '../../api/client'
import MaterialBadge from '../common/MaterialBadge.vue'
import SkeletonList from '../common/SkeletonList.vue'
import {
  attachTest,
  deleteCourse,
  detachTest,
  downloadMaterial,
  enrollStudent,
  getCourse,
  unenrollStudent,
  uploadMaterial,
} from '../../api/courses'
import { listTests } from '../../api/tests'
import type { CourseDetails, Material, TestSummary } from '../../api/types'
import TestPicker from './TestPicker.vue'
import { useConfirm } from '../../composables/confirm'
import { useToast } from '../../composables/toast'
import AppButton from '../../components/common/AppButton.vue'
import AppCard from '../../components/common/AppCard.vue'

const props = defineProps<{
  courseId: string
}>()

const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const confirm = useConfirm()
const toast = useToast()

const course = ref<CourseDetails | null>(null)
const loading = ref(false)
const errorKey = ref('')

const availableTests = ref<TestSummary[]>([])
const enrollUsername = ref('')
const attaching = ref(false)
const actionError = ref('')

function apiErrorKey(error: unknown): string {
  if (!(error instanceof ApiError)) return 'generic'
  if (error.code === 'NETWORK') return 'network'
  if (error.code === 'VALIDATION' || error.code === 'INVALID_OPERATION') return 'validation'
  if (error.code === 'CONFLICT') return 'conflict'
  if (error.code === 'NOT_FOUND') return 'notFound'
  return 'generic'
}

function showError(key: string): string {
  return key === 'generic' ? t('teacher.errors.generic') : t(`teacher.errors.${key}`)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function load() {
  loading.value = true
  errorKey.value = ''
  try {
    course.value = await getCourse(props.courseId)
    const tests = await listTests()
    const attached = new Set(course.value.tests.map((test) => test.id))
    availableTests.value = tests.filter((test) => !attached.has(test.id))
  } catch (error) {
    errorKey.value = apiErrorKey(error)
  } finally {
    loading.value = false
  }
}

async function run(action: () => Promise<unknown>) {
  actionError.value = ''
  try {
    await action()
    await load()
  } catch (error) {
    const key = apiErrorKey(error)
    actionError.value =
      key === 'validation' && error instanceof ApiError && error.status === 400
        ? t('teacher.courses.studentNotFound')
        : showError(key)
  }
}

async function enroll() {
  const username = enrollUsername.value.trim()
  if (!username) return
  await run(() => enrollStudent(props.courseId, username))
  if (!actionError.value) toast.success(t('teacher.courses.enrolled', { name: username }))
  enrollUsername.value = ''
}

async function detach(testId: string, testTitle: string) {
  if (!(await confirm({ message: t('teacher.courses.detachConfirm', { title: testTitle }) }))) return
  await run(() => detachTest(props.courseId, testId))
  if (!actionError.value) toast.success(t('teacher.courses.testDetached'))
}

async function unenroll(student: { id: string; fullName: string }) {
  if (!(await confirm({ message: t('teacher.courses.unenrollConfirm', { name: student.fullName }) }))) return
  await run(() => unenrollStudent(props.courseId, student.id))
  if (!actionError.value) toast.success(t('teacher.courses.unenrolled', { name: student.fullName }))
}

async function attach(testId: string) {
  attaching.value = true
  await run(() => attachTest(props.courseId, testId))
  if (!actionError.value) toast.success(t('teacher.courses.testAttached'))
  attaching.value = false
}

async function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  await run(() => uploadMaterial(props.courseId, file))
  if (!actionError.value) toast.success(t('teacher.courses.materialUploaded'))
  input.value = ''
}

async function download(material: Material) {
  try {
    await downloadMaterial(props.courseId, material.id, material.title)
  } catch {
    actionError.value = showError('network')
  }
}

async function removeCourse() {
  if (!(await confirm({ message: t('teacher.courses.deleteConfirm') }))) return
  await run(() => deleteCourse(props.courseId))
  if (!actionError.value) toast.success(t('teacher.courses.deleted'))
  emit('close')
}

onMounted(load)
</script>

<template>
  <SkeletonList v-if="loading" class="mt-4" :rows="3" />

  <div v-else-if="course" class="mt-4 space-y-4">
    <div class="flex items-center justify-between gap-2">
      <div class="flex min-w-0 items-center gap-1">
        <AppButton
          type="button"
          variant="ghost"
          icon
          :aria-label="t('teacher.courses.back')"
          @click="emit('close')"
        >
          <ArrowLeft class="size-4" aria-hidden="true" />
        </AppButton>
        <div class="min-w-0">
          <h4 class="truncate text-base font-semibold text-on-surface">{{ course.title }}</h4>
          <p v-if="course.description" class="mt-0.5 truncate text-sm text-on-surface-variant">
            {{ course.description }}
          </p>
          <ul v-if="course.tags.length" class="mt-1.5 flex flex-wrap gap-1.5">
            <li
              v-for="tag in course.tags"
              :key="tag.id"
              class="rounded-full bg-secondary-container px-2 py-0.5 text-[11px] font-semibold text-on-secondary-container"
            >
              {{ tag.name }}
            </li>
          </ul>
        </div>
      </div>
    </div>

    <p v-if="actionError" role="alert" class="rounded-lg bg-error-container px-3 py-2 text-sm text-on-error-container">
      {{ actionError }}
    </p>

    <!-- students -->
    <AppCard as="section">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h5 class="text-sm font-semibold text-on-surface">
          {{ t('teacher.courses.students') }}
        </h5>
        <span class="rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-semibold tabular-nums text-on-surface-variant">
          {{ course.students.length }}
        </span>
      </div>
      <ul v-if="course.students.length" class="mt-3 space-y-1.5">
        <li
          v-for="student in course.students"
          :key="student.id"
          class="flex items-center justify-between gap-2 text-sm"
        >
          <span class="min-w-0 truncate text-on-surface">
            {{ student.fullName }} <span class="text-on-surface-variant">@{{ student.username }}</span>
          </span>
          <AppButton
            type="button"
            @click="unenroll(student)"
            variant="dangerSecondary" size="sm" class="shrink-0"
          >
            {{ t('teacher.courses.unenroll') }}
          </AppButton>
        </li>
      </ul>
      <p v-else class="mt-3 flex items-center gap-1.5 text-xs text-on-surface-variant">
        <Users class="size-3.5" aria-hidden="true" />
        {{ t('teacher.courses.noStudents') }}
      </p>
      <form class="mt-3 flex gap-2" @submit.prevent="enroll">
        <input
          v-model="enrollUsername"
          type="text"
          :aria-label="t('teacher.courses.enrollPlaceholder')"
          :placeholder="t('teacher.courses.enrollPlaceholder')"
          class="w-full max-w-52 rounded-lg border border-outline bg-surface px-3 py-1.5 text-sm focus:border-primary"
        />
        <AppButton variant="primary" class="shrink-0" type="submit">
          {{ t('teacher.courses.enroll') }}
        </AppButton>
      </form>
    </AppCard>

    <!-- tests -->
    <AppCard as="section">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h5 class="text-sm font-semibold text-on-surface">
          {{ t('teacher.courses.tests') }}
        </h5>
        <span class="rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-semibold tabular-nums text-on-surface-variant">
          {{ course.tests.length }}
        </span>
      </div>
      <ul v-if="course.tests.length" class="mt-3 space-y-1.5">
        <li
          v-for="test in course.tests"
          :key="test.id"
          class="flex items-center justify-between gap-2 text-sm"
        >
          <span class="min-w-0 truncate text-on-surface">{{ test.title }}</span>
          <AppButton
            type="button"
            @click="detach(test.id, test.title)"
            variant="dangerSecondary" size="sm" class="shrink-0"
          >
            {{ t('teacher.courses.detach') }}
          </AppButton>
        </li>
      </ul>
      <p v-else class="mt-3 flex items-center gap-1.5 text-xs text-on-surface-variant">
        <ClipboardList class="size-3.5" aria-hidden="true" />
        {{ t('teacher.courses.noTests') }}
      </p>
      <TestPicker :tests="availableTests" :busy="attaching" @select="attach" />
    </AppCard>

    <!-- materials -->
    <AppCard as="section">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h5 class="text-sm font-semibold text-on-surface">
          {{ t('teacher.courses.materials') }}
        </h5>
        <span class="rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-semibold tabular-nums text-on-surface-variant">
          {{ course.materials.length }}
        </span>
      </div>
      <ul v-if="course.materials.length" class="mt-3 space-y-1.5">
        <li v-for="material in course.materials" :key="material.id" class="flex flex-wrap items-center gap-2 text-sm">
          <MaterialBadge :title="material.title" :mime-type="material.mimeType" />
          <span class="flex min-w-0 flex-1 items-center gap-1.5 truncate text-on-surface">
            {{ material.title }}
          </span>
          <span class="shrink-0 text-xs text-on-surface-variant">{{ formatBytes(material.sizeBytes) }}</span>
          <AppButton
            type="button"
            @click="download(material)"
            variant="secondaryPlain" size="sm" class="shrink-0"
          >
            {{ t('teacher.courses.download') }}
          </AppButton>
        </li>
      </ul>
      <p v-else class="mt-3 flex items-center gap-1.5 text-xs text-on-surface-variant">
        <Paperclip class="size-3.5" aria-hidden="true" />
        {{ t('teacher.courses.noMaterials') }}
      </p>
      <label
        class="state-layer mt-3 inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-outline bg-surface px-3 py-1.5 text-xs font-semibold text-on-surface-variant"
      >
        <Upload class="size-3.5" aria-hidden="true" />
        {{ t('teacher.courses.upload') }}
        <input type="file" class="hidden" @change="onFileSelected" />
      </label>
    </AppCard>

    <AppButton
      type="button"
      @click="removeCourse"
      variant="dangerSecondary" size="md"
    >
      {{ t('teacher.courses.deleteCourse') }}
    </AppButton>
  </div>

  <p v-else-if="errorKey" role="alert" class="mt-4 rounded-lg bg-error-container px-3 py-2 text-sm text-on-error-container">
    {{ showError(errorKey) }}
  </p>
</template>