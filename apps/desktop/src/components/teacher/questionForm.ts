import type { Question, QuestionInput, QuestionType } from '../../api/types'

export interface AnswerPair {
  left: string
  right: string
  leftImage: string | null
  rightImage: string | null
}

/**
 * Mutable form model backing the question editor.
 *
 * The image ids sit beside the text they belong to rather than inside it: an
 * option is a sentence *and* possibly a drawing, and a model that can only hold
 * one of them would make the editor choose which half of the question to keep.
 */
export interface QuestionForm {
  key: string
  /** The server question behind this row, when the test already exists. */
  questionId: string | null
  type: QuestionType
  body: string
  points: number
  /** The diagram in the question itself. */
  media: string | null
  options: string[]
  optionImages: Array<string | null>
  correctIndex: number
  correctIndexes: number[]
  isTrue: boolean
  accepted: string
  pairs: AnswerPair[]
}

/** Question payloads from the server carry the same field names. */
interface ChoicePayloadOption {
  key?: string
  text?: string
  image?: MediaPayload
}

interface MediaPayload {
  assetId?: string
}

type ReadbackPayload = {
  media?: MediaPayload
  options?: ChoicePayloadOption[]
  correct?: string | string[]
  accepted?: string[]
  pairs?: Array<{ left?: string; right?: string; leftImage?: MediaPayload; rightImage?: MediaPayload }>
}

/** The id out of a `{ assetId }` reference, or null where there is no picture. */
function mediaId(value: MediaPayload | undefined): string | null {
  return typeof value?.assetId === 'string' && value.assetId !== '' ? value.assetId : null
}

/** Validation result: built questions, or the i18n detail key of the first problem. */
export type QuestionBuild = QuestionInput[] | string

function optionKey(index: number): string {
  return String.fromCharCode(97 + index)
}

export function newQuestionForm(type: QuestionType = 'single_choice'): QuestionForm {
  return {
    key: crypto.randomUUID(),
    questionId: null,
    type,
    body: '',
    points: 1,
    media: null,
    options: ['', ''],
    optionImages: [null, null],
    correctIndex: 0,
    correctIndexes: [0],
    isTrue: true,
    accepted: '',
    pairs: [
      { left: '', right: '', leftImage: null, rightImage: null },
      { left: '', right: '', leftImage: null, rightImage: null },
    ],
  }
}

/** Deep copy of a form row with a fresh key, so it can be inserted next to the original. */
export function duplicateQuestionForm(form: QuestionForm): QuestionForm {
  return {
    ...form,
    key: crypto.randomUUID(),
    // A duplicate is a new question: it has no result history of its own.
    questionId: null,
    options: [...form.options],
    optionImages: [...form.optionImages],
    correctIndexes: [...form.correctIndexes],
    pairs: form.pairs.map((pair) => ({ ...pair })),
  }
}

/** A picture reference, or nothing at all - never an empty one. */
function imageFor(assetId: string | null | undefined, field = 'image'): Record<string, unknown> {
  return assetId === null || assetId === undefined || assetId === ''
    ? {}
    : { [field]: { assetId } }
}

/** The diagram in the question itself, if it has one. */
function withMedia(form: QuestionForm): Record<string, unknown> {
  return imageFor(form.media, 'media')
}

export function buildQuestions(forms: QuestionForm[]): QuestionBuild {
  const questions: QuestionInput[] = []
  for (let position = 0; position < forms.length; position++) {
    const form = forms[position]
    if (!form.body.trim()) return 'emptyBody'
    if (!Number.isInteger(form.points) || form.points < 1) return 'badPoints'

    let payload: Record<string, unknown>
    switch (form.type) {
      case 'single_choice': {
        const options = form.options.map((text, index) => ({
          key: optionKey(index),
          text: text.trim(),
          ...imageFor(form.optionImages[index]),
        }))
        if (options.length < 2) return 'tooFewOptions'
        if (options.some((option) => !option.text)) return 'emptyOption'
        if (form.correctIndex < 0 || form.correctIndex >= options.length) return 'noCorrect'
        payload = { ...withMedia(form), options, correct: options[form.correctIndex].key }
        break
      }
      case 'multiple_choice': {
        const options = form.options.map((text, index) => ({
          key: optionKey(index),
          text: text.trim(),
          ...imageFor(form.optionImages[index]),
        }))
        if (options.length < 2) return 'tooFewOptions'
        if (options.some((option) => !option.text)) return 'emptyOption'
        const indexes = [...new Set(form.correctIndexes)].filter(
          (index) => index >= 0 && index < options.length,
        )
        if (indexes.length === 0) return 'noCorrect'
        payload = { ...withMedia(form), options, correct: indexes.map((index) => options[index].key) }
        break
      }
      case 'true_false':
        payload = { ...withMedia(form), correct: form.isTrue }
        break
      case 'short_answer': {
        const accepted = form.accepted
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
        if (accepted.length === 0) return 'noAccepted'
        payload = { ...withMedia(form), accepted }
        break
      }
      case 'matching': {
        const pairs = form.pairs.map((pair) => ({
          left: pair.left.trim(),
          right: pair.right.trim(),
          ...imageFor(pair.leftImage, 'leftImage'),
          ...imageFor(pair.rightImage, 'rightImage'),
        }))
        if (pairs.length < 2) return 'tooFewPairs'
        if (pairs.some((pair) => !pair.left || !pair.right)) return 'emptyPair'
        payload = { ...withMedia(form), pairs }
        break
      }
    }
    questions.push({
      type: form.type,
      body: form.body.trim(),
      points: form.points,
      position,
      payload,
    })
  }
  return questions
}

/** Maps server questions back into editable form rows. */
export function formsFromQuestions(questions: Question[]): QuestionForm[] {
  return questions.map((question) => {
    const form = newQuestionForm(question.type)
    form.questionId = question.id
    form.body = question.body
    form.points = question.points
    const payload = (question.payload ?? {}) as ReadbackPayload
    form.media = mediaId(payload.media)
    switch (question.type) {
      case 'single_choice': {
        form.options = payload.options?.map((option) => option.text ?? '') ?? []
        form.optionImages = (payload.options ?? []).map((option) => mediaId(option.image))
        const index =
          payload.options?.findIndex((option) => option.key !== undefined && option.key === payload.correct) ?? -1
        form.correctIndex = index >= 0 ? index : 0
        break
      }
      case 'multiple_choice': {
        form.options = payload.options?.map((option) => option.text ?? '') ?? []
        form.optionImages = (payload.options ?? []).map((option) => mediaId(option.image))
        const correct = Array.isArray(payload.correct) ? (payload.correct as string[]) : []
        form.correctIndexes = (payload.options ?? [])
          .map((option, index) => (option.key !== undefined && correct.includes(option.key) ? index : -1))
          .filter((index) => index >= 0)
        if (form.correctIndexes.length === 0) form.correctIndexes = [0]
        break
      }
      case 'true_false':
        form.isTrue = (payload as { correct?: boolean }).correct === true
        break
      case 'short_answer':
        form.accepted = (payload.accepted ?? []).join('\n')
        break
      case 'matching':
        form.pairs = (payload.pairs ?? []).map((pair) => ({
          left: pair.left ?? '',
          right: pair.right ?? '',
          leftImage: mediaId(pair.leftImage),
          rightImage: mediaId(pair.rightImage),
        }))
        if (form.pairs.length === 0) form.pairs = newQuestionForm('matching').pairs
        break
    }
    return form
  })
}