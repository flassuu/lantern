import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  clearDraft,
  clearDraftsForUser,
  draftKey,
  readDraft,
  writeDraft,
  type DraftInput,
  type DraftStorage,
} from '../src/composables/sessionDraft.ts'

function memoryStorage(): DraftStorage {
  const store = new Map<string, string>()
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
    keys: () => [...store.keys()],
  }
}

const INPUT: DraftInput = {
  page: 1,
  responses: {
    q1: { keys: ['a'], text: '' },
    q2: { keys: [], text: 'Photosynthesis', boolean: true },
    q3: { keys: [], text: '', pairs: [{ left: 'one', right: '1' }] },
  },
  timing: {
    q1: { timeMs: 4_000, changed: 1 },
    q2: { timeMs: 0, changed: 2 },
  },
}

describe('a paper kept on the device', () => {
  it('gives back the answers, the page and the time after a reload', () => {
    const storage = memoryStorage()
    writeDraft('s1', 'u1', INPUT, storage)

    const draft = readDraft('s1', 'u1', storage)
    assert.ok(draft)
    assert.equal(draft.version, 1)
    assert.equal(draft.page, 1)
    assert.deepEqual(draft.responses, INPUT.responses)
    assert.deepEqual(draft.timing, INPUT.timing)
    assert.ok(!Number.isNaN(Date.parse(draft.savedAt)))
  })

  it('keeps one student away from another on a shared phone', () => {
    const storage = memoryStorage()
    writeDraft('s1', 'u1', INPUT, storage)
    writeDraft('s1', 'u2', { ...INPUT, page: 0 }, storage)

    assert.equal(readDraft('s1', 'u1', storage)?.page, 1)
    assert.equal(readDraft('s1', 'u2', storage)?.page, 0)
    // Another run is another paper, even for the same student.
    assert.equal(readDraft('s2', 'u1', storage), null)
  })

  it('drops a draft from a run that is over', () => {
    const storage = memoryStorage()
    const old = {
      version: 1,
      savedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      ...INPUT,
    }
    storage.setItem(draftKey('s1', 'u1'), JSON.stringify(old))

    assert.equal(readDraft('s1', 'u1', storage), null)
    assert.equal(storage.getItem(draftKey('s1', 'u1')), null)
  })

  it('drops a corrupted entry instead of throwing', () => {
    const storage = memoryStorage()
    storage.setItem(draftKey('s1', 'u1'), '{not json')
    assert.equal(readDraft('s1', 'u1', storage), null)
    assert.equal(storage.getItem(draftKey('s1', 'u1')), null)

    storage.setItem(
      draftKey('s1', 'u1'),
      JSON.stringify({ version: 1, savedAt: new Date().toISOString(), page: 0, responses: {}, timing: {} }),
    )
    // A draft with no answers is valid and restores nothing, which is fine.
    assert.ok(readDraft('s1', 'u1', storage))
  })

  it('refuses a draft written by another version', () => {
    const storage = memoryStorage()
    storage.setItem(
      draftKey('s1', 'u1'),
      JSON.stringify({ version: 99, savedAt: new Date().toISOString(), ...INPUT }),
    )
    assert.equal(readDraft('s1', 'u1', storage), null)
  })

  it('does not throw when storage is full or disabled', () => {
    const broken: DraftStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {
        throw new Error('disabled')
      },
      keys: () => [],
    }
    assert.doesNotThrow(() => writeDraft('s1', 'u1', INPUT, broken))
    assert.equal(readDraft('s1', 'u1', broken), null)
    assert.doesNotThrow(() => clearDraft('s1', 'u1', broken))
    assert.doesNotThrow(() => clearDraftsForUser('u1', broken))
  })

  it('clears one paper, and every paper of one student at sign-out', () => {
    const storage = memoryStorage()
    writeDraft('s1', 'u1', INPUT, storage)
    writeDraft('s2', 'u1', INPUT, storage)
    writeDraft('s2', 'u2', INPUT, storage)

    clearDraft('s1', 'u1', storage)
    assert.equal(readDraft('s1', 'u1', storage), null)
    assert.ok(readDraft('s2', 'u1', storage))

    clearDraftsForUser('u1', storage)
    assert.equal(readDraft('s2', 'u1', storage), null)
    // The other student's paper is not the one signing out.
    assert.ok(readDraft('s2', 'u2', storage))
  })
})
