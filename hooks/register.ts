import type { EngineInterface, PluginOptions, Register, SessionRateLimit, Timer } from 'claude-code'

// How long before a 1-hour cache lapses to compact. A 367k-token summary pass took about 2 minutes.
const MARGIN_MS = 10 * 60_000
const HOUR_MS = 60 * 60_000
// Below this many input tokens a cold re-read is cheap; not worth losing detail.
const DEFAULT_MIN_TOKENS = 60_000

type Ttl = '5m' | '1h'

const isTtl = (v: unknown): v is Ttl => v === '5m' || v === '1h'
const isSet = (v: string | undefined) => v !== undefined && v !== '' && v !== '0' && v !== 'false'

function nonNegative(raw: unknown): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5)
const kTokens = (n: number) => `${Math.round(n / 1000)}k`

/**
 * The main conversation's prompt-cache TTL, resolved the way Claude Code resolves it:
 * FORCE_PROMPT_CACHING_5M, CLAUDE_CODE_PROMPT_CACHE_TTL, the promptCacheTtl setting,
 * ENABLE_PROMPT_CACHING_1H, and otherwise 1 hour on a subscription within its usage limits,
 * 5 minutes on an API key or a cloud provider.
 */
async function cacheTtl($: EngineInterface, rateLimits: readonly SessionRateLimit[]): Promise<Ttl> {
  if (isSet(await $.env.get('FORCE_PROMPT_CACHING_5M'))) return '5m'
  const fromEnv = await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')
  if (isTtl(fromEnv)) return fromEnv
  const { promptCacheTtl } = await $.settings.read()
  if (isTtl(promptCacheTtl)) return promptCacheTtl
  if (isSet(await $.env.get('ENABLE_PROMPT_CACHING_1H'))) return '1h'
  // Only a subscription login reports plan windows.
  const plan = rateLimits.filter(r => r.kind === 'five_hour' || r.kind === 'seven_day')
  return plan.length > 0 && plan.every(r => r.percentUsed < 100) ? '1h' : '5m'
}

/** Idle time before compacting, or undefined when the cache TTL is too short to bother. */
async function idleDelayMs($: EngineInterface, options: PluginOptions, rateLimits: readonly SessionRateLimit[]) {
  const envMs = nonNegative(await $.env.get('IDLE_COMPACT_MS'))
  if (envMs) return envMs
  const minutes = nonNegative(options.idleMinutes)
  if (minutes) return minutes * 60_000
  return (await cacheTtl($, rateLimits)) === '1h' ? HOUR_MS - MARGIN_MS : undefined
}

async function minTokens($: EngineInterface, options: PluginOptions) {
  return nonNegative(await $.env.get('IDLE_COMPACT_MIN_TOKENS')) ?? nonNegative(options.minTokens) ?? DEFAULT_MIN_TOKENS
}

const instructions = (at: string, idleMin: number) =>
  `This compaction ran automatically at ${at}, after ${idleMin} minutes idle, before the prompt cache expired. ` +
  'Open the summary by saying so. Keep open tasks, decisions and their reasons, pending follow-ups with dates, ' +
  'file paths touched, and anything the user asked to be remembered.'

/** Per-activation state: the armed timer and what the module has put on screen. */
type State = {
  timer?: Timer
  // Bumped on every disarm, so an arm still awaiting its reads can tell it was overtaken.
  generation: number
  hasStatus: boolean
  hasSaidOff: boolean
}

function disarm(state: State) {
  state.generation++
  state.timer?.cancel()
  state.timer = undefined
}

function clearStatus($: EngineInterface, state: State) {
  if (state.hasStatus) $.ui.status(undefined)
  state.hasStatus = false
}

async function compactIfWorthIt($: EngineInterface, state: State, idleSince: number, floor: number) {
  const fired = state.generation
  try {
    const { context } = await $.session.usage()
    const before = context.tokens ?? 0
    if (before < floor) return
    const now = await $.clock.now()
    const at = hhmm(now)
    const idleMin = Math.round((now - idleSince) / 60_000)
    const result = await $.session.compact({ instructions: instructions(at, idleMin) })
    if (result.messages === undefined) return
    const after = result.tokensAfter === undefined ? '' : ` → ${kTokens(result.tokensAfter)}`
    const line = `compacted at ${at} after ${idleMin} min idle (${kTokens(result.tokensBefore ?? before)}${after} tokens)`
    $.ui.log(line)
    // A prompt sent while the summary ran has already cleared the status; don't pin a stale one.
    if (fired !== state.generation) return
    $.ui.status(line)
    state.hasStatus = true
  } catch {
    // compact rejects while a turn runs; the next turn.complete re-arms the timer
  }
}

async function arm($: EngineInterface, state: State, options: PluginOptions) {
  disarm(state)
  const armed = state.generation
  const { rateLimits } = await $.session.usage()
  const delay = await idleDelayMs($, options, rateLimits)
  const floor = await minTokens($, options)
  const idleSince = await $.clock.now()
  if (armed !== state.generation) return
  if (delay === undefined) {
    if (!state.hasSaidOff) {
      $.ui.log('off: the prompt cache TTL is 5 minutes. Set promptCacheTtl to "1h", or set idleMinutes, to turn it on.')
      state.hasSaidOff = true
    }
    return
  }
  state.timer = $.clock.after(delay, () => {
    state.timer = undefined
    void compactIfWorthIt($, state, idleSince, floor)
  })
}

/**
 * Arms a timer at the end of every main-loop turn and cancels it on any new prompt or turn, so it
 * only fires after a stretch of genuine idle. When it fires and the context is big enough, compacts
 * while the cache is still warm and leaves a note in the transcript and the status line.
 */
export const register: Register = (on, options) => {
  const state: State = { generation: 0, hasStatus: false, hasSaidOff: false }

  on('prompt.submit', ($, e, next) => {
    disarm(state)
    clearStatus($, state)
    return next(e)
  })

  on('turn.start', (_$, e, next) => {
    disarm(state)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      // never let arming the timer break the turn
      await arm($, state, options).catch(() => {})
    }
    return result
  })

  on('session.end', ($, e, next) => {
    disarm(state)
    clearStatus($, state)
    return next(e)
  })
}
