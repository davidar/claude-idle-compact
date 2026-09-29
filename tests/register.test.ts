import type { On, SessionRateLimit, Settings, TurnCompleteInput } from 'claude-code'
import { type Engine, describe, expect, mock, test, tier } from 'claude-code/testing'

tier('user')

const MIN = 60_000
const SUMMARY = { role: 'user' as const, text: 'summary', toolUses: [] }

const SUBSCRIPTION: SessionRateLimit[] = [
  { kind: 'five_hour', percentUsed: 17 },
  { kind: 'seven_day', percentUsed: 41 },
]

type Setup = {
  env?: Record<string, string>
  settings?: Settings
  rateLimits?: SessionRateLimit[]
  tokens?: number
  compact?: 'ok' | 'skip' | 'throw'
}

/** Answers everything the module reads beneath it, and records what it does. */
function setup(on: On, { env = {}, settings = {}, rateLimits = SUBSCRIPTION, tokens = 200_000, compact = 'ok' }: Setup = {}) {
  const clock = mock.clock(on, { now: Date.parse('2026-09-29T18:00:00') })
  mock.env(on, env)
  const seen = { compacts: [] as string[], logs: [] as string[], status: [] as (string | undefined)[] }
  on('settings.read', () => ({ value: settings }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens, window: 1_000_000, percent: 20 }, rateLimits },
  }))
  on('session.compact', (_$, e) => {
    if (compact === 'throw') throw new Error('a turn is running')
    seen.compacts.push(e.instructions ?? '')
    return compact === 'skip' ? { skip: 'nothing to compact' } : { messages: [SUMMARY], tokensBefore: tokens, tokensAfter: 12_000 }
  })
  on('ui.log', (_$, e) => (seen.logs.push(e.text), { value: undefined }))
  on('ui.status', (_$, e) => (seen.status.push(e.text), { value: undefined }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  return { clock, seen }
}

const turnDone = ($: Engine, extra: Partial<TurnCompleteInput> = {}) =>
  $.turn.complete({ answer: 'hi', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', ...extra } as TurnCompleteInput)

const prompt = ($: Engine) => $.prompt.submit({ text: 'back', wait: false, origin: { kind: 'composer' } })

describe('timing', () => {
  test('compacts 50 minutes after the last turn on a 1-hour cache', async ($, on) => {
    const { clock, seen } = setup(on)
    await turnDone($)
    await clock.advance(50 * MIN - 1)
    expect(seen.compacts).toEqual([])
    await clock.advance(2)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
    expect(seen.compacts[0]).toContain('at 18:50, after 50 minutes idle')
  })

  test('IDLE_COMPACT_MS overrides the delay', async ($, on) => {
    const { clock, seen } = setup(on, { env: { IDLE_COMPACT_MS: '1000' } })
    await turnDone($)
    await clock.advance(999)
    expect(seen.compacts).toEqual([])
    await clock.advance(2)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
  })

  test('the idleMinutes option overrides the delay', { options: { idleMinutes: 5 } }, async ($, on) => {
    const { clock, seen } = setup(on)
    await turnDone($)
    await clock.advance(5 * MIN + 1)
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

describe('cache TTL', () => {
  for (const [name, s] of [
    ['the promptCacheTtl setting', { settings: { promptCacheTtl: '5m' } }],
    ['CLAUDE_CODE_PROMPT_CACHE_TTL', { env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } }],
    ['FORCE_PROMPT_CACHING_5M', { env: { FORCE_PROMPT_CACHING_5M: '1' } }],
    ['an API key (no plan windows)', { rateLimits: [] }],
    ['a subscription past its limits', { rateLimits: [{ kind: 'five_hour', percentUsed: 100 }] }],
  ] as [string, Setup][]) {
    test(`stays off on a 5-minute cache from ${name}, and says so once`, async ($, on) => {
      const { clock, seen } = setup(on, s)
      await turnDone($)
      await turnDone($)
      await clock.advance(2 * 60 * MIN)
      await clock.settle()
      expect(seen.compacts).toEqual([])
      expect(seen.logs.length).toBe(1)
      expect(seen.logs[0]).toContain('off')
    })
  }

  test('an API key with promptCacheTtl 1h is on', async ($, on) => {
    const { clock, seen } = setup(on, { rateLimits: [], settings: { promptCacheTtl: '1h' } })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
  })

  test('idleMinutes turns it on over a 5-minute cache', { options: { idleMinutes: 3 } }, async ($, on) => {
    const { clock, seen } = setup(on, { rateLimits: [] })
    await turnDone($)
    await clock.advance(3 * MIN + 1)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
  })
})

describe('cancelling', () => {
  test('a new prompt cancels the timer', async ($, on) => {
    const { clock, seen } = setup(on)
    await turnDone($)
    await clock.advance(30 * MIN)
    await prompt($)
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

  test('leaves a transcript line and a status line, cleared by the next prompt', async ($, on) => {
    const { clock, seen } = setup(on)
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    const line = 'compacted at 18:50 after 50 min idle (200k → 12k tokens)'
    expect(seen.logs).toEqual([line])
    expect(seen.status).toEqual([line])
    await prompt($)
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
