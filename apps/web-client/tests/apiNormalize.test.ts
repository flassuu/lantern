import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  normalizeCourse,
  normalizeSession,
  normalizeTest,
} from '../src/api/normalize.ts'

/**
 * A server older than the client.
 *
 * This is not hypothetical: the fields the room/tag release added are missing
 * from any server that has not been restarted since, and the Live board reads
 * `session.tags.length` while it renders. That one undefined took the whole
 * workbench down - the throw aborted the page's render, so the tab strip went
 * dead with it and every tab looked like the Live tab.
 *
 * Normalising at the network edge is what these tests pin: whatever the server
 * sends, the shape the components rely on is there.
 */
describe('normalising what the server sends', () => {
  it('gives a session the fields the room release added', () => {
    const session = normalizeSession({ id: 's1', title: 'Math' })
    assert.equal(session.name, null)
    assert.equal(session.roomId, null)
    assert.deepEqual(session.tags, [])
  })

  it('keeps the values the server did send', () => {
    const tag = { id: 't1', ownerId: 'u1', name: 'Algebra', createdAt: '2026-01-01T00:00:00.000Z' }
    const session = normalizeSession({
      id: 's1',
      name: 'Monday revision',
      roomId: 'r1',
      tags: [tag],
    })
    assert.equal(session.name, 'Monday revision')
    assert.equal(session.roomId, 'r1')
    assert.deepEqual(session.tags, [tag])
  })

  it('turns the exact crash into an empty list', () => {
    // What the Live board does: `session.tags.length`. Against an old server
    // this read threw, and the throw is what froze the whole page.
    const session = normalizeSession({ id: 's1' })
    assert.equal(session.tags.length, 0)
  })

  it('treats a null name as no name, not as a missing field', () => {
    const session = normalizeSession({ id: 's1', name: null, tags: null })
    assert.equal(session.name, null)
    assert.deepEqual(session.tags, [])
  })

  it('does the same for a test and for a course', () => {
    const test = normalizeTest({ id: 'x', title: 'Fractions' })
    assert.equal(test.roomId, null)
    assert.deepEqual(test.tags, [])

    const course = normalizeCourse({ id: 'c', title: 'Algebra 9' })
    assert.deepEqual(course.tags, [])
  })

  it('gives a course the lessons and announcements the 6.7 release added', () => {
    // What the course screen does on mount: `course.topics.length`. Against a
    // server that has not been restarted since 6.7 that read threw, and the
    // throw took the whole course screen down - not one card, the render.
    const course = normalizeCourse({ id: 'c', title: 'Algebra 9' })
    assert.deepEqual(course.topics, [])
    assert.deepEqual(course.announcements, [])

    const topic = { id: 't1', title: 'Lesson 1', position: 0 }
    const kept = normalizeCourse({
      id: 'c',
      title: 'Algebra 9',
      topics: [topic],
      announcements: [{ id: 'a1', body: 'Read the diagram.' }],
    })
    assert.deepEqual(kept.topics, [topic])
    assert.equal(kept.announcements[0]?.body, 'Read the diagram.')
  })
})
