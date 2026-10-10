<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ClipboardList, Library, Paperclip, Plus, Trash2, Users, X } from '@lucide/vue'
import { ApiError } from '../../api/client'
import EmptyState from '../common/EmptyState.vue'
import SkeletonList from '../common/SkeletonList.vue'
import { createCourse, deleteCourse, listCourses } from '../../api/courses'
import type { CourseSummary } from '../../api/types'
import CourseDetails from './CourseDetails.vue'
import TagInput from './TagInput.vue'
import { useConfirm } from '../../composables/confirm'
import { useDialogFocus } from '../../composables/focusTrap'
import { useToast } from '../../composables/toast'
import AppButton from '../../components/common/AppButton.vue'
import AppCard from '../../components/common/AppCard.vue'
import AppDialog from '../../components/common/AppDialog.vue'
import AppInput from '../../components/common/AppInput.vue'

const { t } = useI18n()
const confirm = useConfirm()
const toast = useToast()

const courses = ref<CourseSummary[]>([])
const loading = ref(false)
const errorKey = ref('')

const showCreate = ref(false)
const newTitle = ref('')
const newDescription = ref('')
const newTags = ref<string[]>([])
const createError = ref('')
const saving = ref(false)

const openCourseId = ref<string | null>(null)

/** The one dialog on this screen: a course is a title, a description and labels. */
const panel = ref<HTMLElement | null>(null)
const cancelRef = ref<HTMLButtonElement | null>(null)
useDialogFocus(() => showCreate.value, () => closeCreate(), panel, cancelRef)

function apiErrorKey(error: unknown): string {
  if (!(error instanceof ApiError)) return 'generic'
  if (error.code === 'NETWORK') return 'network'
  if (error.code === 'VALIDATION') return 'validation'
  return 'generic'
}

function showError(key: string): string {
  return key === 'generic' ? t('teacher.errors.generic') : t(`teacher.errors.${key}`)
}

function createErrorText(): string {
  if (!createError.value) return ''
  return createError.value === 'titleRequired'
    ? t('teacher.form.err.titleRequired')
    : showError(createError.value)
}

function openCreate(): void {
  createError.value = ''
  newTitle.value = ''
  newDescription.value = ''
  newTags.value = []
  showCreate.value = true
}

function closeCreate(): void {
  if (saving.value) return
  showCreate.value = false
  createError.value = ''
}

async function load() {
  loading.value = true
  errorKey.value = ''
  try {
    courses.value = await listCourses()
  } catch (error) {
    errorKey.value = apiErrorKey(error)
  } finally {
    loading.value = false
  }
}

async function create() {
  if (!newTitle.value.trim()) {
    createError.value = 'titleRequired'
    return
  }
  createError.value = ''
  saving.value = true
  try {
    await createCourse({
      title: newTitle.value.trim(),
      description: newDescription.value.trim(),
      tags: newTags.value,
    })
    toast.success(t('teacher.courses.created'))
    showCreate.value = false
    newTitle.value = ''
    newDescription.value = ''
    await load()
  } catch (error) {
    createError.value = apiErrorKey(error)
  } finally {
    saving.value = false
  }
}

async function remove(course: CourseSummary) {
  if (!(await confirm({ message: t('teacher.courses.deleteConfirm') }))) return
  try {
    await deleteCourse(course.id)
    toast.success(t('teacher.courses.deleted'))
    await load()
  } catch (error) {
    errorKey.value = apiErrorKey(error)
  }
}

onMounted(load)
</script>

<template>
  <section>
    <CourseDetails
      v-if="openCourseId"
      :course-id="openCourseId"
      @close="openCourseId = null; load()"
    />

    <template v-else>
      <div class="flex items-center justify-between">
        <h3 class="text-base font-semibold text-on-surface">{{ t('teacher.courses.heading') }}</h3>
        <AppButton variant="primary" @click="openCreate">
          <Plus class="size-3.5" aria-hidden="true" />
          {{ t('teacher.courses.newCourse') }}
        </AppButton>
      </div>

      <p
        v-if="errorKey"
        role="alert"
        class="mt-4 rounded-lg bg-error-container px-3 py-2 text-sm text-on-error-container"
      >
        {{ showError(errorKey) }}
      </p>
      <SkeletonList v-else-if="loading" class="mt-4" :rows="3" />
      <EmptyState
        v-else-if="courses.length === 0"
        class="mt-4"
        :icon="Library"
        :title="t('teacher.courses.emptyTitle')"
        :description="t('teacher.courses.emptyHint')"
        :action-label="t('teacher.courses.newCourse')"
        @action="openCreate"
      />
      <ul v-else class="mt-4 space-y-2">
        <AppCard
          as="li"
          v-for="course in courses"
          :key="course.id"
          class="flex flex-col gap-3 shadow-sm sm:flex-row sm:items-center"
        >
          <button
            type="button"
            class="state-layer min-w-0 flex-1 rounded-2xl text-left"
            @click="openCourseId = course.id"
          >
            <p class="truncate text-sm font-semibold text-on-surface">{{ course.title }}</p>
            <p v-if="course.description" class="mt-0.5 truncate text-xs text-on-surface-variant">
              {{ course.description }}
            </p>
            <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span class="inline-flex items-center gap-1 rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-semibold text-on-surface-variant">
                <Users class="size-3" aria-hidden="true" />
                {{ t('teacher.courses.studentsCount', { count: course.studentsCount }) }}
              </span>
              <span class="inline-flex items-center gap-1 rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-semibold text-on-surface-variant">
                <ClipboardList class="size-3" aria-hidden="true" />
                {{ t('teacher.courses.testsCount', { count: course.testsCount }) }}
              </span>
              <span class="inline-flex items-center gap-1 rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-semibold text-on-surface-variant">
                <Paperclip class="size-3" aria-hidden="true" />
                {{ t('teacher.courses.materialsCount', { count: course.materialsCount }) }}
              </span>
              <span
                v-for="tag in course.tags"
                :key="tag.id"
                class="rounded-full bg-secondary-container px-2 py-0.5 text-[11px] font-semibold text-on-secondary-container"
              >
                {{ tag.name }}
              </span>
            </div>
          </button>
          <AppButton
            variant="ghostDanger"
            icon
            size="sm"
            class="shrink-0 self-end sm:self-center"
            :aria-label="t('teacher.tests.delete')"
            v-tip="t('teacher.tests.delete')"
            @click="remove(course)"
          >
            <Trash2 class="size-4" aria-hidden="true" />
          </AppButton>
        </AppCard>
      </ul>
    </template>

    <AppDialog
      v-if="showCreate"
      :label="t('teacher.courses.newCourse')"
      @close="closeCreate"
    >
      <form ref="panel" class="flex max-h-[92dvh] flex-col" @submit.prevent="create">
        <header class="flex items-start justify-between gap-3 border-b border-outline-variant p-4">
          <div class="min-w-0">
            <h3 class="text-base font-semibold text-on-surface">
              {{ t('teacher.courses.newCourse') }}
            </h3>
            <p class="mt-0.5 text-sm text-on-surface-variant">
              {{ t('teacher.courses.emptyHint') }}
            </p>
          </div>
          <AppButton
            variant="ghost"
            class="shrink-0"
            :aria-label="t('common.close')"
            @click="closeCreate"
          >
            <X class="size-4" aria-hidden="true" />
          </AppButton>
        </header>

        <div class="flex-1 space-y-3 overflow-y-auto p-4">
          <label class="block">
            <span class="text-xs font-semibold text-on-surface-variant">
              {{ t('teacher.courses.title') }}
            </span>
            <AppInput v-model="newTitle" type="text" class="mt-1" />
          </label>
          <label class="block">
            <span class="text-xs font-semibold text-on-surface-variant">
              {{ t('teacher.courses.description') }}
            </span>
            <textarea
              v-model="newDescription"
              rows="2"
              class="mt-1 w-full rounded-lg border border-outline bg-surface px-3 py-2 text-sm focus:border-primary"
            />
          </label>
          <TagInput v-model="newTags" :label="t('teacher.tags.label')" />
          <p v-if="createErrorText()" role="alert" class="text-sm text-error">
            {{ createErrorText() }}
          </p>
        </div>

        <footer class="flex justify-end gap-2 border-t border-outline-variant p-4">
          <AppButton variant="secondary" ref="cancelRef" @click="closeCreate">
            {{ t('common.cancel') }}
          </AppButton>
          <AppButton variant="primary" type="submit" :disabled="saving">
            {{ t('teacher.courses.save') }}
          </AppButton>
        </footer>
      </form>
    </AppDialog>
  </section>
</template>