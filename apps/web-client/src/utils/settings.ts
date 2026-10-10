import { DEFAULT_SETTINGS, type TestSettings } from '../api/normalize'

/** The six decisions a teacher makes about a run, as keys of the settings. */
export type SettingKey = keyof TestSettings

/**
 * The i18n key that names each setting, and only the changed reading of it:
 * a boolean is named by what turning it off would mean, so a chip saying
 * "Never" is only ever shown when the answers really are never revealed.
 */
export const SETTING_LABEL: Record<SettingKey, string> = {
  shuffleQuestions: 'teacher.sessionSettings.shuffleQuestions',
  shuffleOptions: 'teacher.sessionSettings.shuffleOptions',
  showCorrectAnswers: 'teacher.sessionSettings.revealNever',
  releaseResults: 'teacher.sessionSettings.releaseTeacher',
  questionsPerPage: 'teacher.sessionSettings.pagesOne',
  allowBack: 'teacher.sessionSettings.backOff',
}

/** In the order a teacher reads them, not the order they are declared. */
const ORDER: SettingKey[] = [
  'shuffleQuestions',
  'shuffleOptions',
  'questionsPerPage',
  'allowBack',
  'releaseResults',
  'showCorrectAnswers',
]

/**
 * The settings that are not the default, so a screen can say in one line what a
 * test or a run will actually do.
 *
 * A run at its defaults shows nothing rather than six "off" chips: the point of
 * the line is to catch a paper that behaves unlike the others, and silence is
 * the truth for an ordinary one.
 */
export function changedSettings(settings: TestSettings): SettingKey[] {
  return ORDER.filter((key) => settings[key] !== DEFAULT_SETTINGS[key])
}