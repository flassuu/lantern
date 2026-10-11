<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, ChevronDown, Download, Library, Megaphone } from '@lucide/vue'
import { ApiError } from '../../api/client'
import { downloadMaterial, getCourse, listCourses } from '../../api/courses'
import type { CourseDetails, CourseSummary, Material } from '../../api/types'
import EmptyState from '../common/EmptyState.vue'
import SkeletonList from '../common/SkeletonList.vue'
import MaterialBadge from '../common/MaterialBadge.vue'
import MaterialPreview from '../common/MaterialPreview.vue'
import { useToast } from '../../composables/toast'
import AppButton from '../../components/common/AppButton.vue'

const { t } = useI18n()
const toast = useToast()

const courses = ref<CourseSummary[]>([])
const loading = ref(false)
const errorKey = ref('')
const openId = ref('')
const detail = ref<CourseDetails | null>(null)
const detailLoading = ref(false)

/** 1.2 MB, 940 KB, … - the same formatting the teacher course page uses. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return t('student.errors.coursesFailed')
  if (error.code === 'NETWORK') return t('student.errors.network')
  if (error.code === 'FORBIDDEN') return t('student.errors.notAllowed')
  return t('student.errors.coursesFailed')
}

async function load(): Promise<void> {
  loading.value = true
  errorKey.value = ''
  try {
    courses.value = await listCourses()
  } catch (error) {
    errorKey.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

async function toggle(course: CourseSummary): Promise<void> {
  if (openId.value === course.id) {
    openId.value = ''
    detail.value = null
    return
  }
  openId.value = course.id
  detail.value = null
  detailLoading.value = true
  try {
    detail.value = await getCourse(course.id)
  } catch (error) {
    errorKey.value = errorMessage(error)
  } finally {
    detailLoading.value = false
  }
}

/**
 * The course's materials under their lessons, in the order the teacher put the
 * lessons in, with whatever has no lesson last under its own heading. Nothing is
 * dropped: a material with no lesson is still a material the class can open.
 */
function lessonGroups(course: CourseDetails): Array<{
  id: string | null
  title: string
  materials: Material[]
}> {
  const groups = course.topics.map((topic) => ({
    id: topic.id as string | null,
    title: topic.title,
    materials: [] as Material[],
  }))
  const loose = { id: null, title: t('student.courses.topics.noLesson'), materials: [] as Material[] }
  for (const material of course.materials) {
    const index = groups.findIndex((group) => group.id === material.topicId)
    if (index >= 0) groups[index]!.materials.push(material)
    else loose.materials.push(material)
  }
  return [...groups, loose].filter((group) => group.materials.length > 0)
}

async function download(material: { id: string; title: string }): Promise<void> {
  if (!detail.value) return
  try {
    await downloadMaterial(detail.value.id, material.id, material.title)
  } catch {
    toast.error(t('student.errors.downloadFailed'))
  }
}

onMounted(load)
</script>

<template>
  <section>
    <div class="flex items-center gap-2">
      <Library class="size-5 shrink-0" aria-hidden="true" />
      <h3 class="text-base font-semibold text-on-surface">
        {{ t('student.courses.heading') }}
      </h3>
    </div>
    <p class="mt-1 text-xs text-on-surface-variant">{{ t('student.courses.hint') }}</p>

    <p
      v-if="errorKey"
      role="alert"
      class="mt-3 rounded-xl bg-error-container px-3 py-2 text-sm text-on-error-container"
    >
      {{ errorKey }}
    </p>

    <SkeletonList v-if="loading" class="mt-4" :rows="2" />

    <EmptyState
      v-else-if="courses.length === 0"
      class="mt-4"
      :icon="BookOpen"
      :title="t('student.courses.emptyTitle')"
      :description="t('student.courses.emptyHint')"
    />

    <ul v-else class="mt-4 space-y-2">
      <li
        v-for="course in courses"
        :key="course.id"
        class="overflow-hidden rounded-2xl border border-outline-variant bg-surface-container"
      >
        <button
          type="button"
          :aria-expanded="openId === course.id"
          @click="toggle(course)"
          class="state-layer flex w-full items-center gap-3 p-4 text-left"
        >
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-semibold text-on-surface">
              {{ course.title }}
            </span>
            <span class="mt-0.5 block text-xs text-on-surface-variant">
              {{ t('student.courses.counts', {
                materials: course.materialsCount,
                tests: course.testsCount,
              }) }}
            </span>
          </span>
          <ChevronDown
            class="size-4 shrink-0 text-on-surface-variant"
            :class="openId === course.id ? 'rotate-180' : ''"
            aria-hidden="true"
          />
        </button>

        <div v-if="openId === course.id" class="border-t border-outline-variant p-4">
          <SkeletonList v-if="detailLoading" :rows="1" />

          <template v-else-if="detail">
            <p v-if="detail.description" class="text-sm text-on-surface-variant">
              {{ detail.description }}
            </p>

            <!-- What the teacher said, first: on a phone this is the one part of
                 a course that changed today. -->
            <div v-if="detail.announcements.length" class="mt-3 space-y-2">
              <p
                v-for="note in detail.announcements"
                :key="note.id"
                class="rounded-xl bg-secondary-container p-3 text-on-secondary-container"
              >
                <span class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide">
                  <Megaphone class="size-3.5 shrink-0" aria-hidden="true" />
                  {{ t('student.courses.announcements.title') }}
                </span>
                <span class="mt-1 block text-sm">{{ note.body }}</span>
                <span
                  v-if="note.material"
                  class="mt-1.5 flex items-center gap-1.5 text-xs"
                >
                  <Paperclip class="size-3.5 shrink-0" aria-hidden="true" />
                  <span class="min-w-0 truncate">{{ note.material.title }}</span>
                </span>
              </p>
            </div>

            <!-- A lesson is a group of what the course holds. Everything with no
                 lesson is shown under it rather than hidden: a test added on
                 Friday still has to be findable. -->
            <div class="mt-4">
              <p class="text-xs font-semibold text-on-surface">
                {{ t('student.courses.materials') }}
              </p>
              <p
                v-if="detail.materials.length === 0"
                class="mt-1.5 text-xs text-on-surface-variant"
              >
                {{ t('student.courses.noMaterials') }}
              </p>

              <div
                v-for="topic in lessonGroups(detail)"
                v-else
                :key="topic.id ?? 'loose'"
                class="mt-2"
              >
                <p
                  v-if="topic.id !== null"
                  class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant"
                >
                  <BookOpen class="size-3.5 shrink-0" aria-hidden="true" />
                  {{ topic.title }}
                </p>
                <ul class="mt-1.5 space-y-1.5">
                  <li
                    v-for="material in topic.materials"
                    :key="material.id"
                    class="flex flex-wrap items-center gap-2"
                  >
                    <MaterialBadge :title="material.title" :mime-type="material.mimeType" />
                    <!-- A diagram is looked at, not only saved. A GIF plays. -->
                    <MaterialPreview
                      :course-id="detail.id"
                      :material-id="material.id"
                      :title="material.title"
                      :mime-type="material.mimeType"
                    />
                    <span class="min-w-0 flex-1 truncate text-sm text-on-surface">
                      {{ material.title }}
                    </span>
                    <span class="shrink-0 text-xs text-on-surface-variant">
                      {{ formatBytes(material.sizeBytes) }}
                    </span>
                    <AppButton
  variant="secondaryMuted"
  class="shrink-0"
  :aria-label="t('student.courses.download', { title: material.title })"
  @click="download(material)"
>
                      <Download class="size-4" aria-hidden="true" />
                    </AppButton>
                  </li>
                </ul>
              </div>
            </div>

            <div class="mt-4">
              <p class="text-xs font-semibold text-on-surface">
                {{ t('student.courses.tests') }}
              </p>
              <p v-if="detail.tests.length === 0" class="mt-1.5 text-xs text-on-surface-variant">
                {{ t('student.courses.noTests') }}
              </p>
              <ul v-else class="mt-1.5 flex flex-wrap gap-1.5">
                <li
                  v-for="test in detail.tests"
                  :key="test.id"
                  class="rounded-full bg-surface-container-highest px-2.5 py-0.5 text-xs font-semibold text-on-surface-variant"
                >
                  {{ test.title }}
                </li>
              </ul>
            </div>
          </template>
        </div>
      </li>
    </ul>
  </section>
</template>
