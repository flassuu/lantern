<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { CheckCircle2, Search } from '@lucide/vue'
import type { TestSummary } from '../../api/types'
import { changedSettings, SETTING_LABEL } from '../../utils/settings'

const props = withDefaults(
  defineProps<{
    tests: TestSummary[]
    busy?: boolean
    /**
     * Whether to say, under each test, what a run of it would do differently.
     * Only the start dialog wants it - there the teacher is about to open a
     * lobby with these rules and needs to know which paper behaves unlike the
     * rest. In the course picker the same line would be noise.
     */
    showSettings?: boolean
  }>(),
  { busy: false, showSettings: false },
)

const emit = defineEmits<{ select: [testId: string] }>()

const { t } = useI18n()
const query = ref('')

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return props.tests
  return props.tests.filter((test) => test.title.toLowerCase().includes(needle))
})

/**
 * What each test does that the plain run does not, by id.
 *
 * Computed rather than called per row: the chips name the settings that are off
 * the default, and a test at its defaults says nothing at all - which is the
 * truth for most of them, and the reason the line stays short.
 */
const summaries = computed(() => {
  const map = new Map<string, string[]>()
  if (!props.showSettings) return map
  for (const test of filtered.value) {
    const labels = changedSettings(test.settings).map((key) => t(SETTING_LABEL[key]))
    if (labels.length > 0) map.set(test.id, labels)
  }
  return map
})
</script>

<template>
  <div class="mt-3">
    <label class="flex items-center gap-2 rounded-lg border border-outline bg-surface px-3 py-1.5 focus-within:border-primary">
      <Search class="size-4 shrink-0 text-on-surface-variant" aria-hidden="true" />
      <input
        v-model="query"
        type="search"
        :aria-label="t('teacher.courses.attachSearch')"
        :placeholder="t('teacher.courses.attachSearch')"
        class="w-full bg-transparent text-sm"
      />
    </label>

    <p
      v-if="tests.length === 0"
      class="mt-2 flex items-center gap-1.5 text-xs text-on-surface-variant"
    >
      <CheckCircle2 class="size-3.5" aria-hidden="true" />
      {{ t('teacher.courses.allTestsAttached') }}
    </p>

    <p
      v-else-if="filtered.length === 0"
      class="mt-2 flex items-center gap-1.5 text-xs text-on-surface-variant"
    >
      <Search class="size-3.5" aria-hidden="true" />
      {{ t('teacher.courses.attachNoMatch') }}
    </p>

    <ul v-else class="mt-2 max-h-56 space-y-1.5 overflow-y-auto">
      <li v-for="test in filtered" :key="test.id">
        <button
          type="button"
          :disabled="busy"
          class="state-layer flex w-full items-center justify-between gap-2 rounded-xl bg-surface px-3 py-2 text-left disabled:opacity-60"
          @click="emit('select', test.id)"
        >
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-semibold text-on-surface">
              {{ test.title }}
            </span>
            <span class="block text-xs text-on-surface-variant">
              {{ t('teacher.tests.questionCount', { count: test.questionCount }) }}
              <span v-if="test.timeLimitSec">
                · {{ test.timeLimitSec / 60 }} {{ t('teacher.tests.minutes') }}
              </span>
            </span>
            <!--
              The line is always there when the settings matter, and says so when
              they are ordinary: a blank space under a test would read as "not
              shown", and the teacher is here to find out what a run will do.
            -->
            <span v-if="showSettings" class="mt-1 flex flex-wrap items-center gap-1">
              <template v-if="summaries.get(test.id)">
                <span
                  v-for="label in summaries.get(test.id)"
                  :key="label"
                  class="rounded-full bg-secondary-container px-2 py-0.5 text-[10px] font-semibold text-on-secondary-container"
                >
                  {{ label }}
                </span>
              </template>
              <span v-else class="text-[11px] text-on-surface-variant">
                {{ t('teacher.live.standardRun') }}
              </span>
            </span>
          </span>
          <span
            class="shrink-0 rounded-full bg-primary-container px-2 py-0.5 text-[11px] font-semibold text-on-primary-container"
          >
            {{ t('teacher.courses.attach') }}
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>