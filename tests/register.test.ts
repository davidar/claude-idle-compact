import type { ContextCategory, ContextCategoryKind, ModelUsage, On, SessionContextBreakdown, TurnCompleteInput } from 'claude-code'
import { type Engine, describe, expect, mock, test, tier } from 'claude-code/testing'

tier('user')

const MIN = 60_000
const SUMMARY = { role: 'user' as const, text: 'summary', toolUses: [] }

type Setup = {
  /** The whole context; null for unknown, as after a compaction. */
  tokens?: number | null
  /** The conversation (the breakdown's Messages row); null for no breakdown. 20k of system prompt and tools by default. */
  messages?: number | null
  compact?: 'ok' | 'skip' | 'throw'
  usage?: ModelUsage
  /** What `$.state` holds at the start, as a reloaded module finds it. */
  stored?: Stored
}

type Stored = { sessionId: string; at: number } | null

const row = (name: string, tokens: number, kind: ContextCategoryKind = 'used'): ContextCategory =>
  ({ name, tokens, kind, color: 'inactive', isDeferred: false })

/** What /context would list: the system prompt and tools, the conversation, the rest of the window. */
function breakdown(tokens: number | null, messages: number): SessionContextBreakdown {
  const total = tokens ?? messages
  return {
    categories: [row('System prompt', total - messages), row('Messages', messages), row('Free space', 1_000_000 - total, 'free')],
    totalTokens: total, maxTokens: 1_000_000, rawMaxTokens: 1_000_000, autocompactSource: 'model-default', percentage: Math.round(total / 10_000),
    gridRows: [], model: 'test', memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true, apiUsage: null,
  }
}

/** Answers everything the module reads beneath it, and records what it does. */
function setup(on: On, { tokens = 200_000, messages = tokens === null ? null : tokens - 20_000, compact = 'ok', usage, stored = null }: Setup = {}) {
  const clock = mock.clock(on, { now: T0 })
  // lateMs: how late the timer fires, as after the machine slept. The module reads the usage
  // before the time, so the usage hook is where the clock runs on.
  // duringRead: run once while the module reads `$.state`, to overtake a re-arm.
  const seen = {
    compacts: [] as string[], logs: [] as string[], status: [] as (string | undefined)[], lateMs: 0,
    stored, duringRead: undefined as (() => Promise<unknown>) | undefined,
  }
  on('session.usage', async (_$, e) => {
    if (seen.lateMs) await clock.advance(seen.lateMs)
    const context = { tokens: tokens ?? undefined, window: 1_000_000 }
    const withBreakdown = e.breakdown && messages !== null ? { ...context, breakdown: breakdown(tokens, messages) } : context
    return { value: { startedAt: 0, context: withBreakdown, rateLimits: [] } }
  })
  on('session.compact', (_$, e) => {
    if (compact === 'throw') throw new Error('a turn is running')
    seen.compacts.push(e.instructions ?? '')
    return compact === 'skip' ? { skip: 'nothing to compact' } : { messages: [SUMMARY], tokensBefore: tokens ?? undefined, tokensAfter: 12_000, usage }
  })
  on('ui.log', (_$, e) => (seen.logs.push(e.text), { value: undefined }))
  on('ui.status', (_$, e) => (seen.status.push(e.text), { value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('state.get', async () => {
    const value = seen.stored
    const during = seen.duringRead
    seen.duringRead = undefined
    if (during) await during()
    return { value: { value, version: 0 } }
  })
  on('state.set', (_$, e) => ((seen.stored = e.value as Stored), { value: { isSet: true as const, version: 1 } }))
  return { clock, seen }
}

const turnDone = ($: Engine, extra: Partial<TurnCompleteInput> = {}) =>
  $.turn.complete({ answer: 'hi', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', ...extra } as TurnCompleteInput)

const turnStart = ($: Engine) => $.turn.start({ text: 'back', turnId: 't2' })

/** What a reload of the module raises: session.start, in this test on the same activation. */
const reload = ($: Engine) => $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

const T0 = Date.parse('2026-09-29T18:00:00')

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

  test('/clear forgets the last turn, so a reload does not re-arm', async ($, on) => {
    const { clock, seen } = setup(on)
    await turnDone($)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    expect(seen.stored).toBe(null)
    await reload($)
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
  })
})

describe('reloading', () => {
  test('a turn keeps its end time for a reload', async ($, on) => {
    const { seen } = setup(on)
    await turnDone($)
    expect(seen.stored).toEqual({ sessionId: 's1', at: T0 })
  })

  test('a reload mid-idle compacts at the original deadline', async ($, on) => {
    const { clock, seen } = setup(on)
    await turnDone($)
    await clock.advance(30 * MIN)
    await reload($)
    await clock.advance(20 * MIN - 1)
    expect(seen.compacts).toEqual([])
    await clock.advance(2)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
    expect(seen.compacts[0]).toContain('at 18:50, after 50 minutes idle')
    expect(seen.logs).toEqual(['compacted at 18:50 after 50 min idle (200k tokens → 12k summary)'])
  })

  test('a freshly loaded module re-arms from the stored turn', async ($, on) => {
    const { clock, seen } = setup(on, { stored: { sessionId: 's1', at: T0 - 30 * MIN } })
    await reload($)
    await clock.advance(20 * MIN - 1)
    expect(seen.compacts).toEqual([])
    await clock.advance(2)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
    expect(seen.logs).toEqual(['compacted at 18:20 after 50 min idle (200k tokens → 12k summary)'])
  })

  test('a reload past the deadline does nothing and says nothing', async ($, on) => {
    const { clock, seen } = setup(on, { stored: { sessionId: 's1', at: T0 - 3 * 24 * 60 * MIN } })
    await reload($)
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
    expect(seen.logs).toEqual([])
  })

  test("another session's turn does not arm this one", async ($, on) => {
    const { clock, seen } = setup(on, { stored: { sessionId: 's0', at: T0 - 30 * MIN } })
    await reload($)
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
  })

  test('a reload while a turn runs arms nothing', async ($, on) => {
    const { clock, seen } = setup(on)
    await turnDone($)
    await clock.advance(10 * MIN)
    await turnStart($)
    expect(seen.stored).toBe(null)
    await reload($)
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
  })

  test('a turn that starts while a reload reads the stored turn wins', async ($, on) => {
    const { clock, seen } = setup(on, { stored: { sessionId: 's1', at: T0 - 30 * MIN } })
    seen.duringRead = () => turnStart($)
    await reload($)
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
  })

  test('a reload after the compaction does not compact again', async ($, on) => {
    const { clock, seen } = setup(on)
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
    await reload($)
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
  })

  test('a reload after a manual /compact re-arms, and the unknown size leaves it alone', async ($, on) => {
    const { clock, seen } = setup(on, { tokens: null, stored: { sessionId: 's1', at: T0 - 30 * MIN } })
    await reload($)
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
    expect(seen.logs).toEqual([])
  })
})

describe('when it fires', () => {
  test('small conversations are left alone, however big the system prompt and tools', async ($, on) => {
    const { clock, seen } = setup(on, { tokens: 120_000, messages: 39_000 })
    await turnDone($)
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
  })

  test('a conversation under the floor says why it was left alone', async ($, on) => {
    const { clock, seen } = setup(on, { tokens: 32_000, messages: 12_000 })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.logs).toEqual(['not compacted: the conversation is 12k tokens, under the 40k floor'])
    expect(seen.status).toEqual([])
  })

  test('a small floor reads as it is', { options: { minTokens: 100 } }, async ($, on) => {
    const { clock, seen } = setup(on, { tokens: 20_050, messages: 50 })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.logs).toEqual(['not compacted: the conversation is 50 tokens, under the 100 floor'])
  })

  test('the floor is on the conversation', async ($, on) => {
    const { clock, seen } = setup(on, { tokens: 61_000, messages: 41_000 })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
  })

  test('the minTokens option sets the floor', { options: { minTokens: 10_000 } }, async ($, on) => {
    const { clock, seen } = setup(on, { tokens: 30_000, messages: 11_000 })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
  })

  test('without a breakdown, the whole context counts', async ($, on) => {
    const { clock, seen } = setup(on, { tokens: 200_000, messages: null })
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
    const line = 'compacted at 18:50 after 50 min idle (200k tokens → 12k summary)'
    expect(seen.logs).toEqual([line])
    expect(seen.status).toEqual([line])
    await turnStart($)
    expect(seen.status).toEqual([line, undefined])
  })

  test('the line says how much of the summary request came from the cache', async ($, on) => {
    const usage = { input_tokens: 1_500, output_tokens: 800, cache_read_input_tokens: 198_000, cache_creation_input_tokens: 500 }
    const { clock, seen } = setup(on, { usage })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.logs).toEqual(['compacted at 18:50 after 50 min idle (200k tokens → 12k summary, 99% read from cache)'])
  })

  test('a timer that fires late, after the machine slept, does not compact and says why', async ($, on) => {
    const { clock, seen } = setup(on)
    await turnDone($)
    seen.lateMs = 8 * 60 * MIN
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts).toEqual([])
    expect(seen.logs).toEqual(['not compacted: the timer fired 530 min after the last turn, too late for a warm cache'])
    expect(seen.status).toEqual([])
  })

  test('a timer a few minutes late still compacts', async ($, on) => {
    const { clock, seen } = setup(on)
    await turnDone($)
    seen.lateMs = 9 * MIN
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
  })

  test('an unknown context size, as after a manual /compact, is left alone without a word', async ($, on) => {
    const { clock, seen } = setup(on, { tokens: null })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts).toEqual([])
    expect(seen.logs).toEqual([])
  })

  test('an unknown context size is left alone even with no floor', { options: { minTokens: 0 } }, async ($, on) => {
    const { clock, seen } = setup(on, { tokens: null })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts).toEqual([])
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
