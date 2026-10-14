<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { History, Timer } from '@lucide/vue'
import { ApiError } from '../../api/client'
import { listStudentResults, type StudentResult } from '../../api/sessions'
import EmptyState from '../common/EmptyState.vue'
import SkeletonList from '../common/SkeletonList.vue'

const emit = defineEmits<{ open: [sessionId: string] }>()

const { t } = useI18n()

const results = ref<StudentResult[]>([])
const loading = ref(false)
const errorKey = ref('')

function formatWhen(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleString()
}

function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return t('student.errors.resultsFailed')
  if (error.code === 'NETWORK') return t('student.errors.network')
  return t('student.errors.resultsFailed')
}

async function load(): Promise<void> {
  loading.value = true
  errorKey.value = ''
  try {
    results.value = await listStudentResults()
  } catch (error) {
    errorKey.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <section>
    <!-- No heading of its own: the tab above already says which of the three
         screens this is, and saying it twice reads as a mistake. -->

    <p
      v-if="errorKey"
      role="alert"
      class="mt-3 rounded-xl bg-error-container px-3 py-2 text-sm text-on-error-container"
    >
      {{ errorKey }}
    </p>

    <SkeletonList v-if="loading" class="mt-4" :rows="2" />

    <EmptyState
      v-else-if="results.length === 0"
      class="mt-4"
      :icon="History"
      :title="t('student.history.emptyTitle')"
      :description="t('student.history.emptyHint')"
    />

    <ul v-else class="mt-4 space-y-2">
      <li v-for="entry in results" :key="entry.participationId">
        <button
          type="button"
          @click="emit('open', entry.sessionId)"
          class="state-layer flex w-full flex-wrap items-center justify-between gap-2 rounded-2xl border border-outline-variant bg-surface-container p-3 text-left"
        >
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-semibold text-on-surface">
              {{ entry.testTitle }}
            </span>
            <span class="mt-0.5 flex items-center gap-1 text-xs text-on-surface-variant">
              <Timer class="size-3" aria-hidden="true" />
              {{ formatWhen(entry.submittedAt) }}
            </span>
          </span>
          <span class="flex shrink-0 items-center gap-2">
            <span
              v-if="entry.status === 'auto_submitted'"
              class="rounded-full bg-warning-container px-2 py-0.5 text-[11px] font-semibold text-on-warning-container"
            >
              {{ t('student.history.autoSubmitted') }}
            </span>
            <span
              v-if="entry.passed !== null"
              class="rounded-full px-2 py-0.5 text-[11px] font-semibold"
              :class="
                entry.passed
                  ? 'bg-success-container text-on-success-container'
                  : 'bg-error-container text-on-error-container'
              "
            >
              {{ entry.passed ? t('student.history.passed') : t('student.history.failed') }}
            </span>
            <span class="text-base font-bold tabular-nums text-on-surface">
              {{ entry.percent ?? 0 }}%
            </span>
          </span>
        </button>
      </li>
    </ul>
  </section>
</template>
