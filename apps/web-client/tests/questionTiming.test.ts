import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { effectScope } from 'vue'
import { useQuestionTiming } from '../src/composables/useQuestionTiming.ts'

/**
 * The clock a student does not see, with a clock that does not move on its own:
 * every assertion here is about which seconds land on which question, so the
 * test drives time itself rather than waiting for it.
 */
function withClock(run: (timing: ReturnType<typeof useQuestionTiming>, advance: (ms: number) => void) => void): void {
  let now = 1_000_000
  const real = Date.now
  Date.now = () => now
  // The watcher is not bound to a component, so nothing disposes it; a scope is
  // what a component would have done.
  const scope = effectScope()
  try {
    scope.run(() => {
      const timing = useQuestionTiming()
      run(timing, (ms) => {
        now += ms
      })
    })
  } finally {
    Date.now = real
  }
}

describe('what each question cost', () => {
  it('puts the time on the question that was on screen', () => {
    withClock((timing, advance) => {
      timing.setCurrent('q1')
      advance(4_000)
      timing.setCurrent('q2')
      advance(9_000)

      const snapshot = timing.snapshot()
      // 4s on the first, 9s still on the second: nobody moved off it.
      assert.equal(snapshot.q1?.timeMs, 4_000)
      assert.equal(snapshot.q2?.timeMs, 9_000)
    })
  })

  it('counts a change only once the answer was written before', () => {
    withClock((timing) => {
      timing.setCurrent('q1')
      timing.noteChange('q1') // answering
      timing.noteChange('q1') // changing
      timing.noteChange('q1')
      assert.equal(timing.snapshot().q1?.changed, 2)
    })
  })

  it('says nothing about a question nobody opened or answered', () => {
    withClock((timing) => {
      timing.setCurrent('q1')
      timing.noteChange('q2')
      timing.noteChange('q2')
      const snapshot = timing.snapshot()
      assert.ok(!('q3' in snapshot))
      // A change is worth recording even where no clock ran: in a paper shown
      // all at once there is no single question on screen, and the change count
      // does not need one.
      assert.equal(snapshot.q2?.timeMs, 0)
      assert.equal(snapshot.q2?.changed, 1)
    })
  })

  it('leaves out a question that was only opened once and answered once', () => {
    withClock((timing) => {
      timing.setCurrent('q1')
      timing.noteChange('q1')
      // Neither time nor changes says anything; the detail view shows a dash.
      assert.ok(!('q1' in timing.snapshot()))
    })
  })

  it('keeps the whole attempt on one question when the paper is one page', () => {
    withClock((timing, advance) => {
      timing.setCurrent(null)
      advance(60_000)
      assert.deepEqual(timing.snapshot(), {})
    })
  })

  it('carries the numbers across a reload and counts the next edit as a change', () => {
    withClock((timing, advance) => {
      timing.restore({ q1: { timeMs: 4_000, changed: 1 } }, ['q1', 'q2'])
      timing.setCurrent('q2')
      advance(1_000)
      // q1 was answered before the reload, so this is a change, not an answer.
      timing.noteChange('q1')

      const snapshot = timing.snapshot()
      assert.equal(snapshot.q1?.timeMs, 4_000)
      assert.equal(snapshot.q1?.changed, 2)
      assert.equal(snapshot.q2?.timeMs, 1_000)
    })
  })
})
