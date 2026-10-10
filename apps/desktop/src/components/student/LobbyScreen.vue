<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Hourglass } from '@lucide/vue'
import type { SessionState } from '../../api/sessions'
import AppCard from '../../components/common/AppCard.vue'

/**
 * The waiting room.
 *
 * A student who has joined a run that has not started yet stands here: they are
 * in, they are counted, and nothing is timed. The clock begins when the teacher
 * presses Start, and the socket under this screen is what tells them so.
 *
 * The screen says little on purpose - a student waiting for their teacher does
 * not need a control they could press by mistake.
 */
defineProps<{
  state: SessionState
}>()

const { t } = useI18n()
</script>

<template>
  <AppCard as="section">
    <div class="flex items-start gap-3">
      <span
        class="grid size-10 shrink-0 place-items-center rounded-full bg-primary-container text-on-primary-container"
      >
        <Hourglass class="size-5" aria-hidden="true" />
      </span>
      <div class="min-w-0">
        <h3 class="text-base font-semibold text-on-surface">
          {{ t('student.lobby.title') }}
        </h3>
        <p class="mt-1 text-sm text-on-surface-variant">{{ t('student.lobby.hint') }}</p>
      </div>
    </div>

    <p class="mt-4 flex items-center gap-2 text-sm text-on-surface-variant" role="status">
      <span class="size-2 animate-pulse rounded-full bg-primary" aria-hidden="true" />
      {{ t('student.lobby.waiting') }}
    </p>
  </AppCard>
</template>
