<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ClipboardList,
  Grid3x3,
  Megaphone,
  Paperclip,
  Plus,
  Trash2,
  Upload,
  Users,
} from '@lucide/vue'
import { ApiError } from '../../api/client'
import MaterialBadge from '../common/MaterialBadge.vue'
import MaterialPreview from '../common/MaterialPreview.vue'
import SkeletonList from '../common/SkeletonList.vue'
import {
  attachTest,
  createAnnouncement,
  createTopic,
  deleteAnnouncement,
  deleteCourse,
  deleteTopic,
  detachTest,
  downloadMaterial,
  enrollStudent,
  getCourse,
  renameTopic,
  reorderTopics,
  setMaterialTopic,
  setTestTopic,
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

// The journal lives on its own tab, so a course asking for its own is a hand
// over rather than a view: the dashboard switches tabs with this in hand.
const emit = defineEmits<{ close: []; journal: [courseId: string] }>()

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

const newTopicTitle = ref('')
const editingTopicId = ref<string | null>(null)
const editingTopicTitle = ref('')
const announcementBody = ref('')
const announcementMaterialId = ref<string>('')

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

async function addTopic() {
  const title = newTopicTitle.value.trim()
  if (!title) return
  await run(() => createTopic(props.courseId, title))
  if (!actionError.value) toast.success(t('teacher.courses.topics.created'))
  newTopicTitle.value = ''
}

async function startRename(topicId: string, title: string) {
  editingTopicId.value = topicId
  editingTopicTitle.value = title
}

async function saveRename() {
  const id = editingTopicId.value
  const title = editingTopicTitle.value.trim()
  if (id === null || !title) return
  await run(() => renameTopic(props.courseId, id, title))
  editingTopicId.value = null
}

async function removeTopic(topicId: string, title: string) {
  const keep = await confirm({
    message: t('teacher.courses.topics.deleteConfirm', { title }),
  })
  if (!keep) return
  await run(() => deleteTopic(props.courseId, topicId))
}

/**
 * Moves a lesson one step up or down.
 *
 * A pair of arrows rather than a drag: the plan is a handful of lessons, and a
 * drag that has to be discovered costs more than a control that is simply there.
 * The server is the one that renumbers, so the order on screen after a reload is
 * the order that was saved.
 */
async function moveTopic(index: number, delta: number) {
  const ids = course.value?.topics.map((topic) => topic.id) ?? []
  const target = index + delta
  if (target < 0 || target >= ids.length) return
  const [moved] = ids.splice(index, 1)
  if (!moved) return
  ids.splice(target, 0, moved)
  await run(() => reorderTopics(props.courseId, ids))
}

async function changeTestTopic(testId: string, topicId: string) {
  await run(() => setTestTopic(props.courseId, testId, topicId === '' ? null : topicId))
}

async function changeMaterialTopic(materialId: string, topicId: string) {
  await run(() => setMaterialTopic(props.courseId, materialId, topicId === '' ? null : topicId))
}

async function postAnnouncement() {
  const body = announcementBody.value.trim()
  if (!body) return
  await run(() =>
    createAnnouncement(props.courseId, body, announcementMaterialId.value || null),
  )
  if (!actionError.value) toast.success(t('teacher.courses.announcements.posted'))
  announcementBody.value = ''
  announcementMaterialId.value = ''
}

async function removeAnnouncement(announcementId: string) {
  if (!(await confirm({ message: t('teacher.courses.announcements.deleteConfirm') }))) return
  await run(() => deleteAnnouncement(props.courseId, announcementId))
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

      <AppButton variant="secondary" size="sm" @click="emit('journal', props.courseId)">
        <Grid3x3 class="size-3.5" aria-hidden="true" />
        {{ t('teacher.tabs.journal') }}
      </AppButton>
    </div>

    <p v-if="actionError" role="alert" class="rounded-lg bg-error-container px-3 py-2 text-sm text-on-error-container">
      {{ actionError }}
    </p>

    <!-- lessons -->
    <AppCard as="section">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h5 class="text-sm font-semibold text-on-surface">
          {{ t('teacher.courses.topics.heading') }}
        </h5>
        <span class="rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-semibold tabular-nums text-on-surface-variant">
          {{ course.topics.length }}
        </span>
      </div>

      <ul v-if="course.topics.length" class="mt-3 space-y-1.5">
        <li
          v-for="(topic, index) in course.topics"
          :key="topic.id"
          class="flex items-center gap-2 text-sm"
        >
          <AppButton
            type="button"
            variant="ghost"
            size="sm"
            :disabled="index === 0"
            :aria-label="t('teacher.courses.topics.moveUp')"
            @click="moveTopic(index, -1)"
          >
            <ArrowUp class="size-4" aria-hidden="true" />
          </AppButton>
          <AppButton
            type="button"
            variant="ghost"
            size="sm"
            :disabled="index === course.topics.length - 1"
            :aria-label="t('teacher.courses.topics.moveDown')"
            @click="moveTopic(index, 1)"
          >
            <ArrowDown class="size-4" aria-hidden="true" />
          </AppButton>

          <form
            v-if="editingTopicId === topic.id"
            class="flex min-w-0 flex-1 gap-2"
            @submit.prevent="saveRename"
          >
            <input
              v-model="editingTopicTitle"
              type="text"
              :aria-label="t('teacher.courses.topics.titleLabel')"
              class="w-full min-w-0 rounded-lg border border-outline bg-surface px-3 py-1.5 text-sm focus:border-primary"
            />
            <AppButton type="submit" variant="primary" size="sm" class="shrink-0">
              {{ t('common.save') }}
            </AppButton>
          </form>
          <button
            v-else
            type="button"
            class="min-w-0 flex-1 truncate rounded-lg px-2 py-1.5 text-left text-on-surface hover:bg-surface-container-highest"
            @click="startRename(topic.id, topic.title)"
          >
            {{ topic.title }}
          </button>

          <AppButton
            type="button"
            variant="ghostDanger"
            size="sm"
            class="shrink-0"
            :aria-label="t('teacher.courses.topics.delete', { title: topic.title })"
            @click="removeTopic(topic.id, topic.title)"
          >
            <Trash2 class="size-4" aria-hidden="true" />
          </AppButton>
        </li>
      </ul>
      <p v-else class="mt-3 text-xs text-on-surface-variant">
        {{ t('teacher.courses.topics.empty') }}
      </p>

      <form class="mt-3 flex gap-2" @submit.prevent="addTopic">
        <input
          v-model="newTopicTitle"
          type="text"
          :aria-label="t('teacher.courses.topics.placeholder')"
          :placeholder="t('teacher.courses.topics.placeholder')"
          class="w-full max-w-52 rounded-lg border border-outline bg-surface px-3 py-1.5 text-sm focus:border-primary"
        />
        <AppButton type="submit" variant="secondaryMuted" class="shrink-0">
          <Plus class="size-4" aria-hidden="true" />
          {{ t('teacher.courses.topics.add') }}
        </AppButton>
      </form>
    </AppCard>

    <!-- announcements -->
    <AppCard as="section">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h5 class="text-sm font-semibold text-on-surface">
          {{ t('teacher.courses.announcements.title') }}
        </h5>
        <span class="rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-semibold tabular-nums text-on-surface-variant">
          {{ course.announcements.length }}
        </span>
      </div>

      <ul v-if="course.announcements.length" class="mt-3 space-y-2">
        <li
          v-for="note in course.announcements"
          :key="note.id"
          class="rounded-xl bg-surface-container-low p-3"
        >
          <p class="text-sm text-on-surface">{{ note.body }}</p>
          <p
            v-if="note.material"
            class="mt-1.5 flex items-center gap-1.5 text-xs text-on-surface-variant"
          >
            <Paperclip class="size-3.5 shrink-0" aria-hidden="true" />
            <span class="min-w-0 truncate">{{ note.material.title }}</span>
          </p>
          <div class="mt-2 flex items-center justify-between gap-2">
            <span class="truncate text-[11px] text-on-surface-variant">{{ note.authorName }}</span>
            <AppButton
              type="button"
              variant="ghostDanger"
              size="sm"
              class="shrink-0"
              :aria-label="t('teacher.courses.announcements.delete', { name: note.authorName })"
              @click="removeAnnouncement(note.id)"
            >
              <Trash2 class="size-4" aria-hidden="true" />
            </AppButton>
          </div>
        </li>
      </ul>
      <p v-else class="mt-3 flex items-center gap-1.5 text-xs text-on-surface-variant">
        <Megaphone class="size-3.5" aria-hidden="true" />
        {{ t('teacher.courses.announcements.empty') }}
      </p>

      <!-- A sentence, and a file if there is one to send: requiring the file
           would turn every note into a download. -->
      <form class="mt-3 space-y-2" @submit.prevent="postAnnouncement">
        <textarea
          v-model="announcementBody"
          rows="2"
          :aria-label="t('teacher.courses.announcements.bodyPlaceholder')"
          :placeholder="t('teacher.courses.announcements.bodyPlaceholder')"
          class="w-full resize-y rounded-xl border border-outline bg-surface px-3 py-2 text-sm focus:border-primary"
        />
        <div class="flex flex-wrap items-center gap-2">
          <div class="relative min-w-0 flex-1">
            <select
              v-model="announcementMaterialId"
              :aria-label="t('teacher.courses.announcements.materialLabel')"
              class="w-full rounded-xl border border-outline bg-surface px-3 py-2 text-sm focus:border-primary"
            >
              <option value="">{{ t('teacher.courses.announcements.noMaterial') }}</option>
              <option v-for="material in course.materials" :key="material.id" :value="material.id">
                {{ material.title }}
              </option>
            </select>
          </div>
          <AppButton type="submit" variant="primary" class="shrink-0">
            {{ t('teacher.courses.announcements.post') }}
          </AppButton>
        </div>
      </form>
    </AppCard>

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
          class="flex flex-wrap items-center gap-2 text-sm"
        >
          <span class="min-w-0 flex-1 truncate text-on-surface">{{ test.title }}</span>
          <div class="relative shrink-0">
            <select
              :value="test.topicId ?? ''"
              :aria-label="t('teacher.courses.topics.fileUnder', { title: test.title })"
              class="max-w-40 rounded-xl border border-outline-variant bg-surface px-2 py-1.5 text-xs focus:border-primary"
              @change="changeTestTopic(test.id, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">{{ t('teacher.courses.topics.noLesson') }}</option>
              <option v-for="topic in course.topics" :key="topic.id" :value="topic.id">
                {{ topic.title }}
              </option>
            </select>
          </div>
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
          <!-- The thumbnail is the material: a diagram in a lesson is looked at,
               and a GIF is one that plays. -->
          <MaterialPreview
            :course-id="course.id"
            :material-id="material.id"
            :title="material.title"
            :mime-type="material.mimeType"
          />
          <span class="flex min-w-0 flex-1 items-center gap-1.5 truncate text-on-surface">
            {{ material.title }}
          </span>
          <span class="shrink-0 text-xs text-on-surface-variant">{{ formatBytes(material.sizeBytes) }}</span>
          <div class="relative shrink-0">
            <select
              :value="material.topicId ?? ''"
              :aria-label="t('teacher.courses.topics.fileUnder', { title: material.title })"
              class="max-w-40 rounded-xl border border-outline-variant bg-surface px-2 py-1.5 text-xs focus:border-primary"
              @change="changeMaterialTopic(material.id, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">{{ t('teacher.courses.topics.noLesson') }}</option>
              <option v-for="topic in course.topics" :key="topic.id" :value="topic.id">
                {{ topic.title }}
              </option>
            </select>
          </div>
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