<script setup lang="ts">
import { onMounted, ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, BarChart3, ChevronDown, CloudUpload, Copy, Download, Eye, FileQuestion, Plus, Search, SlidersHorizontal, Trash2, Upload, Users } from '@lucide/vue'
import { ApiError } from '../../api/client'
import EmptyState from '../common/EmptyState.vue'
import SkeletonList from '../common/SkeletonList.vue'
import {
  createTest,
  deleteTest,
  duplicateTest,
  exportTestFile,
  getTest,
  getTestResults,
  importTestFile,
  listTests,
  updateTest,
} from '../../api/tests'
import type { TestSummary } from '../../api/types'
import type { TestResults } from '../../api/tests'
import {
  buildQuestions,
  duplicateQuestionForm,
  formsFromQuestions,
  newQuestionForm,
  type QuestionForm,
} from './questionForm'
import QuestionEditor from './QuestionEditor.vue'
import TagInput from './TagInput.vue'
import SessionSettingsFields from './SessionSettingsFields.vue'
import { changedSettings, SETTING_LABEL } from '../../utils/settings'
import TestPreviewDialog from './TestPreviewDialog.vue'
import TestResultsView from './TestResultsView.vue'
import { useConfirm } from '../../composables/confirm'
import { getHealthState } from '../../composables/health'
import { getRoomsState, loadRooms } from '../../composables/rooms'
import { normalizeSettings } from '../../api/normalize'
import type { TestSettings } from '../../api/types'
import {
  deleteDraft,
  listDrafts,
  saveDraft,
  syncDrafts,
  type TestDraft,
} from '../../drafts/testDrafts'
import { useToast } from '../../composables/toast'
import AppButton from '../../components/common/AppButton.vue'
import AppCard from '../../components/common/AppCard.vue'
import AppInput from '../../components/common/AppInput.vue'

const { t } = useI18n()
const confirm = useConfirm()
const toast = useToast()

const tests = ref<TestSummary[]>([])
/** A title filter: the list the teacher searches, not the list the server sends. */
const query = ref('')
/** Несохранённая работа: сервер был недоступен в момент сохранения. */
const drafts = ref<TestDraft[]>([])
const syncingDrafts = ref(false)
const health = getHealthState()
const loading = ref(false)
const errorKey = ref('')

/** True while the create/edit form is open (both create and edit). */
const isEditing = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
const formErrorKey = ref('')
const title = ref('')
const description = ref('')
const timeLimitMin = ref('')
const passingPercent = ref('')
const questionForms = ref<QuestionForm[]>([])
/** The editor's two extras: which room the test is for, and its labels. */
const testTags = ref<string[]>([])
/** The test's defaults for a run of it; a session copies them when it is created. */
const testSettings = ref<TestSettings>(normalizeSettings(null))
/** Folded: six switches are not what a teacher opens a test to look at. */
const runDetailsOpen = ref(false)
/** What this test does differently from the plain run, in one line. */
const settingsSummary = computed(() => changedSettings(testSettings.value).map((key) => t(SETTING_LABEL[key])))
const testRoomId = ref<string | null>(null)
const rooms = getRoomsState()
const busyId = ref('')
/** Which test's journal is open instead of the list. */
const resultsFor = ref<TestSummary | null>(null)
const results = ref<TestResults | null>(null)
const resultsLoading = ref(false)
/** Скрытый input[type=file]: импорт запускается кнопкой, а не выбором файла наугад. */
const importInput = ref<HTMLInputElement | null>(null)
/** Файл читается сразу же — иначе диалог выбора остаётся открытым во время запроса. */
const importedFile = ref<File | null>(null)
/** Что именно не так с файлом: сервер объясняет, и это полезнее общего «не вышло». */
const importError = ref('')
const showPreview = ref(false)

function apiErrorKey(error: unknown): string {
  if (!(error instanceof ApiError)) return 'generic'
  if (error.code === 'NETWORK') return 'network'
  if (error.code === 'VALIDATION') return 'validation'
  if (error.code === 'CONFLICT') return 'conflict'
  if (error.code === 'NOT_FOUND') return 'notFound'
  return 'generic'
}

function showError(key: string): string {
  return key === 'generic' ? t('teacher.errors.generic') : t(`teacher.errors.${key}`)
}

/** Tests matching the search box, case-insensitively on the title. */
const filteredTests = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return tests.value
  return tests.value.filter((test) => test.title.toLowerCase().includes(needle))
})

/** Points across the questions in the editor, for the chip above the list. */
const editorPoints = computed(() =>
  questionForms.value.reduce((sum, form) => sum + form.points, 0),
)

/** Seconds an average student is expected on a question of each type. */
const SECONDS_PER_TYPE: Record<string, number> = {
  single_choice: 20,
  multiple_choice: 30,
  true_false: 10,
  short_answer: 30,
  matching: 40,
}

/**
 * Minutes the paper should take, from the questions alone.
 *
 * It is an estimate rather than a countdown: the running session already has a
 * time limit for that, and a number here answers "did I write twenty minutes or
 * an hour" while the paper is still being written.
 */
const estimatedMinutes = computed(() => {
  const seconds = questionForms.value.reduce(
    (sum, form) => sum + (SECONDS_PER_TYPE[form.type] ?? 20),
    0,
  )
  return Math.max(1, Math.round(seconds / 60))
})

/** Share of past attempts that got a question right, by server question id. */
const correctByQuestion = ref(new Map<string, number>())

/** Loads the difficulty chips for an existing test; a new test has none. */
async function loadDifficulty(testId: string): Promise<void> {
  correctByQuestion.value = new Map()
  try {
    const found = await getTestResults(testId)
    correctByQuestion.value = new Map(
      found.questions.map((stat) => [
        stat.questionId,
        stat.answers > 0 ? Math.round((stat.correct / stat.answers) * 100) : 0,
      ]),
    )
  } catch {
    // The editor is still usable without the numbers: a brand-new test has no
    // history, and the chip simply does not appear.
  }
}

/** The chip for one form row, keyed by the question it was loaded from. */
function correctPercentOf(form: QuestionForm): number | null {
  return form.questionId !== null ? (correctByQuestion.value.get(form.questionId) ?? null) : null
}

function formError(): string {
  return formErrorKey.value ? t(`teacher.form.err.${formErrorKey.value}`) : ''
}

async function load() {
  loading.value = true
  errorKey.value = ''
  try {
    tests.value = await listTests()
  } catch (error) {
    errorKey.value = apiErrorKey(error)
  } finally {
    loading.value = false
  }
}

/** The name of a room, for the chip; '' when the test is not tied to one. */
const roomNameOf = computed(
  () => (id: string | null) => rooms.rooms.find((room) => room.id === id)?.name ?? '',
)

function startCreate() {
  formErrorKey.value = ''
  title.value = ''
  description.value = ''
  timeLimitMin.value = ''
  passingPercent.value = ''
  testTags.value = []
  testSettings.value = normalizeSettings(null)
  testRoomId.value = null
  questionForms.value = [newQuestionForm()]
  editingId.value = null
  isEditing.value = true
}

async function startEdit(test: TestSummary) {
  formErrorKey.value = ''
  try {
    const details = await getTest(test.id)
    title.value = details.title
    description.value = details.description
    timeLimitMin.value = details.timeLimitSec ? String(Math.round(details.timeLimitSec / 60)) : ''
    passingPercent.value = details.passingPercent != null ? String(details.passingPercent) : ''
    questionForms.value = formsFromQuestions(details.questions)
    testTags.value = (details.tags ?? []).map((tag) => tag.name)
    testSettings.value = details.settings
    testRoomId.value = details.roomId ?? null
    editingId.value = test.id
    isEditing.value = true
    void loadDifficulty(test.id)
  } catch (error) {
    errorKey.value = apiErrorKey(error)
  }
}

function addQuestion() {
  questionForms.value.push(newQuestionForm())
}

async function openResults(test: TestSummary): Promise<void> {
  resultsFor.value = test
  results.value = null
  resultsLoading.value = true
  try {
    results.value = await getTestResults(test.id)
  } catch (error) {
    toast.error(
      error instanceof ApiError && error.code === 'FORBIDDEN'
        ? t('teacher.errors.generic')
        : t('teacher.errors.network'),
    )
    resultsFor.value = null
  } finally {
    resultsLoading.value = false
  }
}

function closeResults(): void {
  resultsFor.value = null
  results.value = null
}

function removeQuestion(index: number) {
  questionForms.value.splice(index, 1)
}

function duplicateQuestion(index: number) {
  const source = questionForms.value[index]
  if (!source) return
  questionForms.value.splice(index + 1, 0, duplicateQuestionForm(source))
}

function moveQuestion(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= questionForms.value.length) return
  const [row] = questionForms.value.splice(index, 1)
  if (!row) return
  questionForms.value.splice(target, 0, row)
}

async function save() {
  const built = buildQuestions(questionForms.value)
  if (typeof built === 'string') {
    formErrorKey.value = built
    return
  }
  if (!title.value.trim()) {
    formErrorKey.value = 'titleRequired'
    return
  }
  formErrorKey.value = ''
  const payload = {
    title: title.value.trim(),
    description: description.value.trim(),
    timeLimitSec: timeLimitMin.value ? Number(timeLimitMin.value) * 60 : null,
    passingPercent: passingPercent.value ? Number(passingPercent.value) : null,
    roomId: testRoomId.value,
    tags: testTags.value,
    settings: testSettings.value,
    questions: built,
  }
  saving.value = true
  try {
    if (editingId.value) await updateTest(editingId.value, payload)
    else await createTest(payload)
    toast.success(editingId.value ? t('teacher.tests.updated') : t('teacher.tests.created'))
    await load()
    query.value = ''
    isEditing.value = false
    showPreview.value = false
  } catch (error) {
    // Сервер недоступен — работа не должна пропасть: она ждёт в черновиках.
    if (error instanceof ApiError && error.isNetwork && !editingId.value) {
      saveDraft(payload)
      drafts.value = listDrafts()
      toast.success(t('teacher.tests.savedLocally'))
      isEditing.value = false
      showPreview.value = false
      return
    }
    formErrorKey.value = apiErrorKey(error)
  } finally {
    saving.value = false
  }
}

/** Черновики уходят на сервер, как только он снова отвечает. */
async function uploadDrafts(): Promise<void> {
  if (syncingDrafts.value || drafts.value.length === 0) return
  syncingDrafts.value = true
  try {
    const result = await syncDrafts(async (payload) => {
      await createTest(payload)
    })
    drafts.value = listDrafts()
    if (result.uploaded.length > 0) {
      toast.success(t('teacher.tests.draftsUploaded', { count: result.uploaded.length }))
    }
    if (result.failed.length > 0) {
      toast.error(t('teacher.tests.draftsFailed', { count: result.failed.length }))
    }
    await load()
  } finally {
    syncingDrafts.value = false
  }
}

function discardDraft(draft: TestDraft): void {
  deleteDraft(draft.id)
  drafts.value = listDrafts()
}

/** Открыть черновик в редакторе — как если бы он был только что открыт. */
function openDraft(draft: TestDraft): void {
  startCreate()
  title.value = draft.payload.title
  description.value = draft.payload.description
  timeLimitMin.value = draft.payload.timeLimitSec
    ? String(Math.round(draft.payload.timeLimitSec / 60))
    : ''
  passingPercent.value =
    draft.payload.passingPercent != null ? String(draft.payload.passingPercent) : ''
  // У черновика нет id вопросов — редактору они и не нужны, форма строится из payload.
  questionForms.value = formsFromQuestions(
    draft.payload.questions.map((question) => ({ ...question, id: '' })),
  )
  isEditing.value = true
}

async function duplicate(test: TestSummary): Promise<void> {
  busyId.value = test.id
  try {
    const copy = await duplicateTest(test.id)
    toast.success(t('teacher.tests.duplicated', { title: copy.title }))
    await load()
  } catch (error) {
    errorKey.value = apiErrorKey(error)
  } finally {
    busyId.value = ''
  }
}

async function exportFile(test: TestSummary): Promise<void> {
  busyId.value = test.id
  try {
    await exportTestFile(test.id, test.title)
    toast.success(t('teacher.tests.exported'))
  } catch (error) {
    errorKey.value = apiErrorKey(error)
  } finally {
    busyId.value = ''
  }
}

function openImportPicker(): void {
  importInput.value?.click()
}

/** Файл уже выбран — импортируем его и показываем, что именно не так, если не выйдет. */
async function runImport(): Promise<void> {
  const file = importedFile.value
  importedFile.value = null
  if (!file) return
  busyId.value = 'import'
  try {
    const created = await importTestFile(file)
    toast.success(t('teacher.tests.imported', { title: created.title }))
    errorKey.value = ''
    query.value = ''
    await load()
  } catch (error) {
    errorKey.value = error instanceof ApiError ? 'teacher.tests.errors.generic' : 'teacher.errors.network'
    importError.value =
      error instanceof ApiError && error.code !== 'NETWORK' ? error.message : ''
  } finally {
    busyId.value = ''
  }
}

async function remove(test: TestSummary) {
  if (!(await confirm({ message: t('teacher.tests.deleteConfirm') }))) return
  busyId.value = test.id
  try {
    await deleteTest(test.id)
    toast.success(t('teacher.tests.deleted'))
    await load()
  } catch (error) {
    errorKey.value = apiErrorKey(error)
  } finally {
    busyId.value = ''
  }
}

watch(
  () => health.status,
  (status, previous) => {
    if (status === 'online' && previous === 'offline' && drafts.value.length > 0) {
      void uploadDrafts()
    }
  },
)

onMounted(async () => {
  drafts.value = listDrafts()
  void loadRooms()
  await load()
})
</script>

<template>
  <!-- The editor owns the tab while it is open, as the results view does: a list
       showing through behind a form is two screens asking for one click. -->
  <form v-if="isEditing" class="space-y-4" @submit.prevent="save">
    <div class="flex items-center justify-between gap-2">
      <div class="flex min-w-0 items-center gap-1">
        <AppButton variant="ghost" icon :aria-label="t('teacher.results.back')" @click="isEditing = false">
          <ArrowLeft class="size-4" aria-hidden="true" />
        </AppButton>
        <h3 class="min-w-0 truncate text-base font-semibold text-on-surface">
          {{ editingId ? t('teacher.tests.editHeading') : t('teacher.tests.newTest') }}
        </h3>
      </div>
      <AppButton variant="secondaryMuted" size="sm" class="shrink-0" @click="showPreview = true">
        <Eye class="size-3.5" aria-hidden="true" />
        {{ t('teacher.tests.preview') }}
      </AppButton>
    </div>

    <AppCard as="div">
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="block">
          <span class="text-xs font-semibold text-on-surface-variant">{{ t('teacher.tests.title') }}</span>
          <AppInput v-model="title" type="text" class="mt-1" />
        </label>
        <div class="grid grid-cols-2 gap-3">
          <label class="block">
            <span class="text-xs font-semibold text-on-surface-variant">{{ t('teacher.tests.timeLimit') }}</span>
            <AppInput v-model="timeLimitMin" type="number" min="0" class="mt-1" />
          </label>
          <label class="block">
            <span class="text-xs font-semibold text-on-surface-variant">{{ t('teacher.tests.passMark') }}</span>
            <AppInput v-model="passingPercent" type="number" min="0" max="100" class="mt-1" />
          </label>
        </div>
        <label class="block sm:col-span-2">
          <span class="text-xs font-semibold text-on-surface-variant">{{ t('teacher.tests.description') }}</span>
          <textarea
            v-model="description"
            rows="2"
            class="mt-1 w-full rounded-lg border border-outline bg-surface px-3 py-2 text-sm focus:border-primary"
          />
        </label>

        <!-- Which group this paper is for, and what it is about. A room is a
             choice with consequences - the board counts students per room - and
             the labels answer the softer question of what it covers. -->
        <div class="sm:col-span-2">
          <p class="text-xs font-semibold text-on-surface-variant">{{ t('teacher.tests.room') }}</p>
          <ul v-if="rooms.rooms.length" class="mt-1.5 flex flex-wrap gap-1.5">
            <li>
              <AppButton
                variant="secondaryPlain"
                size="sm"
                :aria-pressed="testRoomId === null"
                :class="testRoomId === null ? 'bg-secondary-container text-on-secondary-container' : ''"
                @click="testRoomId = null"
              >
                {{ t('teacher.tests.roomNone') }}
              </AppButton>
            </li>
            <li v-for="room in rooms.rooms" :key="room.id">
              <AppButton
                variant="secondaryPlain"
                size="sm"
                :aria-pressed="testRoomId === room.id"
                :class="testRoomId === room.id ? 'bg-secondary-container text-on-secondary-container' : ''"
                @click="testRoomId = room.id"
              >
                {{ room.name }}
              </AppButton>
            </li>
          </ul>
          <p v-else class="mt-1.5 text-[11px] text-on-surface-variant">
            {{ t('teacher.tests.roomNoneHint') }}
          </p>
        </div>

        <div class="sm:col-span-2">
          <TagInput v-model="testTags" :label="t('teacher.tags.label')" />
        </div>

        <!--
          The run's defaults, folded. A session copies these when it is created
          and can change them in its lobby, so this is the starting point rather
          than the rules for every future run - which is exactly why it does not
          deserve a sixth block of switches between the paper and its questions.
          Folded, the row still says what it does: the chips name every setting
          that is off the default, so nothing here is hidden.
        -->
        <div class="sm:col-span-2 overflow-hidden rounded-xl border border-outline-variant bg-surface">
          <button
            type="button"
            class="state-layer flex w-full items-center gap-2 px-3 py-2.5 text-left"
            :aria-expanded="runDetailsOpen"
            @click="runDetailsOpen = !runDetailsOpen"
          >
            <SlidersHorizontal class="size-4 shrink-0 text-on-surface-variant" aria-hidden="true" />
            <span class="shrink-0 text-xs font-semibold text-on-surface-variant">
              {{ t('teacher.tests.runDetails') }}
            </span>
            <span v-if="settingsSummary.length" class="flex min-w-0 flex-wrap items-center gap-1">
              <span
                v-for="label in settingsSummary"
                :key="label"
                class="truncate rounded-full bg-secondary-container px-2 py-0.5 text-[10px] font-semibold text-on-secondary-container"
              >
                {{ label }}
              </span>
            </span>
            <ChevronDown
              class="ml-auto size-4 shrink-0 text-on-surface-variant transition-transform duration-200"
              :class="runDetailsOpen ? 'rotate-180' : ''"
              aria-hidden="true"
            />
          </button>
          <div v-show="runDetailsOpen" class="border-t border-outline-variant p-3">
            <p class="text-[11px] text-on-surface-variant">
              {{ t('teacher.sessionSettings.defaultsHint') }}
            </p>
            <div class="mt-3">
              <SessionSettingsFields v-model="testSettings" />
            </div>
          </div>
        </div>
      </div>
    </AppCard>

    <div v-if="formError()" role="alert" class="rounded-lg bg-error-container px-3 py-2 text-sm text-on-error-container">
      {{ formError() }}
    </div>

    <div class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <p class="text-sm font-semibold text-on-surface">{{ t('teacher.tests.questions') }}</p>
          <span class="rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-semibold text-on-surface-variant">
            {{ t('teacher.tests.questionCount', { count: questionForms.length }) }}
          </span>
          <span class="rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-semibold text-on-surface-variant">
            {{ t('teacher.tests.totalPoints', { count: editorPoints }) }}
          </span>
          <span class="rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-semibold text-on-surface-variant">
            {{ t('teacher.tests.estimatedTime', { minutes: estimatedMinutes }) }}
          </span>
        </div>
      </div>
      <QuestionEditor
        v-for="(question, index) in questionForms"
        :key="question.key"
        :question="question"
        :index="index"
        :total="questionForms.length"
        :correct-percent="correctPercentOf(question)"
        @remove="removeQuestion"
        @duplicate="duplicateQuestion"
        @move="moveQuestion"
      />
      <AppButton variant="secondaryMuted" @click="addQuestion">
        <Plus class="size-4" aria-hidden="true" />
        {{ t('teacher.tests.addQuestion') }}
      </AppButton>
    </div>

    <TestPreviewDialog
      :open="showPreview"
      :title="title"
      :description="description"
      :time-limit-min="timeLimitMin"
      :passing-percent="passingPercent"
      :forms="questionForms"
      @close="showPreview = false"
    />

    <div class="flex gap-2">
      <AppButton variant="primary" type="submit" :disabled="saving">
        {{ t('teacher.tests.save') }}
      </AppButton>
      <AppButton variant="secondaryMuted" @click="isEditing = false">
        {{ t('teacher.tests.cancel') }}
      </AppButton>
    </div>
  </form>

  <template v-else-if="resultsFor">
    <SkeletonList v-if="resultsLoading" :rows="3" />

    <TestResultsView
      v-if="results"
      :test="{
        id: resultsFor.id,
        title: results.test.title,
        passingPercent: results.test.passingPercent,
      }"
      :results="results"
      @back="closeResults"
    />
  </template>

  <template v-else>
    <div class="flex items-center justify-between">
      <h3 class="text-base font-semibold text-on-surface">{{ t('teacher.tests.heading') }}</h3>
      <div class="flex shrink-0 items-center gap-2">
        <AppButton
          variant="secondaryMuted"
          size="sm"
          :disabled="busyId === 'import'"
          @click="openImportPicker"
        >
          <Upload class="size-3.5" aria-hidden="true" />
          {{ t('teacher.tests.importJson') }}
        </AppButton>
        <AppButton variant="primary" @click="startCreate">
          <Plus class="size-3.5" aria-hidden="true" />
          {{ t('teacher.tests.newTest') }}
        </AppButton>
      </div>
    </div>

    <input
      ref="importInput"
      type="file"
      accept="application/json,.json"
      class="sr-only"
      :aria-label="t('teacher.tests.importJson')"
      @change="(event) => { importedFile = (event.target as HTMLInputElement).files?.[0] ?? null; runImport() }"
    />

    <p
      v-if="importError"
      role="alert"
      class="mt-3 rounded-lg bg-error-container px-3 py-2 text-sm text-on-error-container"
    >
      {{ importError }}
    </p>

    <!-- Черновики: работа, которую сервер не принял, потому что его не было рядом -->
    <section
      v-if="drafts.length > 0"
      class="mt-4 rounded-2xl border border-outline-variant bg-warning-container p-4"
    >
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <h3 class="text-sm font-semibold text-on-warning-container">
            {{ t('teacher.tests.draftsHeading', { count: drafts.length }) }}
          </h3>
          <p class="mt-0.5 text-xs text-on-warning-container">
            {{ t('teacher.tests.draftsHint') }}
          </p>
        </div>
        <AppButton
          variant="primary"
          size="sm"
          class="shrink-0"
          :disabled="syncingDrafts || health.status !== 'online'"
          @click="uploadDrafts"
        >
          <CloudUpload class="size-3.5" aria-hidden="true" />
          {{ syncingDrafts ? t('teacher.tests.draftsUploading') : t('teacher.tests.draftsUpload') }}
        </AppButton>
      </div>

      <ul class="mt-3 space-y-1.5">
        <li
          v-for="draft in drafts"
          :key="draft.id"
          class="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface px-3 py-2 text-sm"
        >
          <span class="min-w-0 flex-1">
            <span class="block truncate font-semibold text-on-surface">{{ draft.payload.title }}</span>
            <span class="block text-xs text-on-surface-variant">
              {{ t('teacher.tests.draftQuestions', { count: draft.payload.questions.length }) }}
            </span>
          </span>
          <span class="flex shrink-0 items-center gap-2">
            <AppButton variant="secondaryMuted" size="sm" @click="openDraft(draft)">
              {{ t('teacher.tests.draftOpen') }}
            </AppButton>
            <AppButton
              variant="ghostDanger"
              icon
              :aria-label="t('teacher.tests.draftDiscard')"
              @click="discardDraft(draft)"
            >
              <Trash2 class="size-4" aria-hidden="true" />
            </AppButton>
          </span>
        </li>
      </ul>
    </section>

    <p v-if="errorKey" role="alert" class="mt-4 rounded-lg bg-error-container px-3 py-2 text-sm text-on-error-container">
      {{ showError(errorKey) }}
    </p>
    <SkeletonList v-else-if="loading" class="mt-4" :rows="3" />

    <EmptyState
      v-else-if="tests.length === 0"
      class="mt-4"
      :icon="FileQuestion"
      :title="t('teacher.tests.emptyTitle')"
      :description="t('teacher.tests.emptyHint')"
      :action-label="t('teacher.tests.newTest')"
      @action="startCreate"
    />
    <template v-else>
      <!-- A list worth searching once it outgrows one screen. -->
      <label
        v-if="tests.length > 3"
        class="mt-4 flex items-center gap-2 rounded-lg border border-outline bg-surface px-3 py-1.5 focus-within:border-primary"
      >
        <Search class="size-4 shrink-0 text-on-surface-variant" aria-hidden="true" />
        <input
          v-model="query"
          type="search"
          :placeholder="t('teacher.tests.search')"
          :aria-label="t('teacher.tests.search')"
          class="w-full bg-transparent text-sm"
        />
      </label>

      <p
        v-if="filteredTests.length === 0"
        class="mt-4 flex items-center gap-1.5 text-xs text-on-surface-variant"
      >
        <Search class="size-3.5" aria-hidden="true" />
        {{ t('teacher.tests.searchNoMatch', { query: query.trim() }) }}
      </p>

      <ul v-else class="mt-4 space-y-2">
        <AppCard
          as="li"
          v-for="test in filteredTests"
          :key="test.id"
          class="flex flex-col gap-3 shadow-sm sm:flex-row sm:items-center"
        >
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold text-on-surface">{{ test.title }}</p>
            <p v-if="test.description" class="mt-0.5 truncate text-xs text-on-surface-variant">
              {{ test.description }}
            </p>
            <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span class="rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-semibold text-on-surface-variant">
                {{ t('teacher.tests.questionCount', { count: test.questionCount }) }}
              </span>
              <span
                v-if="test.timeLimitSec"
                class="rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-semibold text-on-surface-variant"
              >
                {{ Math.round(test.timeLimitSec / 60) }} {{ t('teacher.tests.minutes') }}
              </span>
              <span
                v-if="test.passingPercent != null"
                class="rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-semibold text-on-surface-variant"
              >
                {{ t('teacher.tests.passing', { percent: test.passingPercent }) }}
              </span>
              <span
                v-if="roomNameOf(test.roomId)"
                class="inline-flex items-center gap-1 rounded-full bg-surface-container-highest px-2 py-0.5 text-[11px] font-semibold text-on-surface-variant"
              >
                <Users class="size-3" aria-hidden="true" />
                {{ roomNameOf(test.roomId) }}
              </span>
              <span
                v-for="tag in test.tags"
                :key="tag.id"
                class="rounded-full bg-secondary-container px-2 py-0.5 text-[11px] font-semibold text-on-secondary-container"
              >
                {{ tag.name }}
              </span>
            </div>
          </div>
          <div class="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <AppButton
              variant="secondaryMuted"
              size="sm"
              :disabled="busyId === test.id"
              @click="openResults(test)"
            >
              <BarChart3 class="size-3.5" aria-hidden="true" />
              {{ t('teacher.tests.results') }}
            </AppButton>
            <AppButton
              variant="secondary"
              size="sm"
              :disabled="busyId === test.id"
              @click="startEdit(test)"
            >
              {{ t('teacher.tests.edit') }}
            </AppButton>
            <AppButton
              variant="ghost"
              icon
              size="sm"
              :disabled="busyId === test.id"
              :aria-label="t('teacher.tests.duplicate')"
              v-tip="t('teacher.tests.duplicate')"
              @click="duplicate(test)"
            >
              <Copy class="size-4" aria-hidden="true" />
            </AppButton>
            <AppButton
              variant="ghost"
              icon
              size="sm"
              :disabled="busyId === test.id"
              :aria-label="t('teacher.tests.exportJson')"
              v-tip="t('teacher.tests.exportJson')"
              @click="exportFile(test)"
            >
              <Download class="size-4" aria-hidden="true" />
            </AppButton>
            <AppButton
              variant="ghostDanger"
              icon
              size="sm"
              :disabled="busyId === test.id"
              :aria-label="t('teacher.tests.delete')"
              v-tip="t('teacher.tests.delete')"
              @click="remove(test)"
            >
              <Trash2 class="size-4" aria-hidden="true" />
            </AppButton>
          </div>
        </AppCard>
      </ul>
    </template>
  </template>
</template>
