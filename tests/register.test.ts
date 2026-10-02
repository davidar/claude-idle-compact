import type { On, TurnCompleteInput } from 'claude-code'
import { type Engine, describe, expect, mock, test, tier } from 'claude-code/testing'

tier('user')

const MIN = 60_000
const SUMMARY = { role: 'user' as const, text: 'summary', toolUses: [] }

type Setup = {
  tokens?: number
  compact?: 'ok' | 'skip' | 'throw'
}

/** Answers everything the module reads beneath it, and records what it does. */
function setup(on: On, { tokens = 200_000, compact = 'ok' }: Setup = {}) {
  const clock = mock.clock(on, { now: Date.parse('2026-09-29T18:00:00') })
  const seen = { compacts: [] as string[], logs: [] as string[], status: [] as (string | undefined)[] }
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens, window: 1_000_000, percent: 20 }, rateLimits: [] },
  }))
  on('session.compact', (_$, e) => {
    if (compact === 'throw') throw new Error('a turn is running')
    seen.compacts.push(e.instructions ?? '')
    return compact === 'skip' ? { skip: 'nothing to compact' } : { messages: [SUMMARY], tokensBefore: tokens, tokensAfter: 12_000 }
  })
  on('ui.log', (_$, e) => (seen.logs.push(e.text), { value: undefined }))
  on('ui.status', (_$, e) => (seen.status.push(e.text), { value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  return { clock, seen }
}

const turnDone = ($: Engine, extra: Partial<TurnCompleteInput> = {}) =>
  $.turn.complete({ answer: 'hi', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', ...extra } as TurnCompleteInput)

const turnStart = ($: Engine) => $.turn.start({ text: 'back', turnId: 't2' })

describe('timing', () => {
  test('compacts 50 minutes after the last turn', async ($, on) => {
    const { clock, seen } = setup(on)
    await turnDone($)
    await clock.advance(50 * MIN - 1)
    expect(seen.compacts).toEqual([])
    await clock.advance(2)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
    expect(seen.compacts[0]).toContain('at 18:50, after 50 minutes idle')
  })

  test('idleMinutes 0 means the default 50 minutes', { options: { idleMinutes: 0 } }, async ($, on) => {
    const { clock, seen } = setup(on)
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
  })

  test('the idleMinutes option overrides the delay', { options: { idleMinutes: 5 } }, async ($, on) => {
    const { clock, seen } = setup(on)
    await turnDone($)
    await clock.advance(5 * MIN - 1)
    expect(seen.compacts).toEqual([])
    await clock.advance(2)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
  })

  test('an aborted turn arms the timer too', async ($, on) => {
    const { clock, seen } = setup(on)
    await turnDone($, { reason: 'aborted', isAborted: true })
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
  })

  test('a subagent turn does not arm the timer', async ($, on) => {
    const { clock, seen } = setup(on)
    await turnDone($, { agentId: 'a1' })
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
  })
})

describe('cancelling', () => {
  test('a new turn cancels the timer', async ($, on) => {
    const { clock, seen } = setup(on)
    await turnDone($)
    await clock.advance(30 * MIN)
    await turnStart($)
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
  })

  test('/clear cancels the timer', async ($, on) => {
    const { clock, seen } = setup(on)
    await turnDone($)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
  })
})

describe('when it fires', () => {
  test('small contexts are left alone', async ($, on) => {
    const { clock, seen } = setup(on, { tokens: 59_000 })
    await turnDone($)
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
  })

  test('the minTokens option sets the floor', { options: { minTokens: 10_000 } }, async ($, on) => {
    const { clock, seen } = setup(on, { tokens: 20_000 })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
  })

  test('leaves a transcript line and a status line, cleared by the next turn', async ($, on) => {
    const { clock, seen } = setup(on)
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    const line = 'compacted at 18:50 after 50 min idle (200k → 12k tokens)'
    expect(seen.logs).toEqual([line])
    expect(seen.status).toEqual([line])
    await turnStart($)
    expect(seen.status).toEqual([line, undefined])
  })

  test('compacts only once if nobody comes back', async ($, on) => {
    const { clock, seen } = setup(on)
    await turnDone($)
    await clock.advance(10 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
  })

  test('a skipped compaction says nothing', async ($, on) => {
    const { clock, seen } = setup(on, { compact: 'skip' })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
    expect(seen.logs).toEqual([])
    expect(seen.status).toEqual([])
  })

  test('a rejected compaction is swallowed and the next turn re-arms', async ($, on) => {
    const { clock, seen } = setup(on, { compact: 'throw' })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.logs).toEqual([])
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.logs).toEqual([])
  })
})
