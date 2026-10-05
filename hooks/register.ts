import type { EngineInterface, ModelUsage, PluginOptions, Register, SessionContextUsage, Timer } from 'claude-code'

// How long before a 1-hour cache lapses to compact. A 367k-token summary pass took about 2 minutes.
// Also how late the timer may fire and still compact.
const MARGIN_MS = 10 * 60_000
const HOUR_MS = 60 * 60_000
// Below this many conversation tokens a cold re-read is cheap; not worth losing detail. The system
// prompt and tools don't count: compaction leaves them in place, and they are re-cached either way.
const DEFAULT_MIN_TOKENS = 40_000

// When a session's last main-loop turn ended (declared in types/index.d.ts). Held by the host for the
// process, so it outlives a reload of this module.
const LAST_TURN = { plugin: 'idle-compact', key: 'lastTurn' } as const

function nonNegative(raw: unknown): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5)
const inThousands = (n: number) => `${Math.round(n / 1000)}k`
// Small figures as they are: a 100-token floor isn't "0k".
const approx = (n: number) => (n < 1000 ? `${n}` : inThousands(n))

/** How much of the summary request's input the prompt cache served: the saving this mod exists for. */
function cacheShare(usage: ModelUsage | undefined) {
  if (!usage) return ''
  const input = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  return input ? `, ${Math.floor((usage.cache_read_input_tokens * 100) / input)}% read from cache` : ''
}

/**
 * What compaction can shrink: the conversation, as /context's Messages row counts it. The whole
 * context when there is no breakdown.
 *
 * The row is a residual: the last response's input less the other rows. That needs the `full`
 * breakdown, which counts the other rows with the token-count API; the `summary` one estimates
 * them, and was seen putting the tools at twice their size, which left 2 tokens of conversation.
 */
function conversationTokens(context: SessionContextUsage) {
  const row = context.breakdown?.categories.find((c) => c.kind === 'used' && c.name === 'Messages')
  return row?.tokens ?? context.tokens
}

/** Idle time before compacting. It assumes the 1-hour cache: the mod is no use on a 5-minute one. */
function idleDelayMs(options: PluginOptions) {
  const minutes = nonNegative(options.idleMinutes)
  return minutes ? minutes * 60_000 : HOUR_MS - MARGIN_MS
}

function minTokens(options: PluginOptions) {
  return nonNegative(options.minTokens) ?? DEFAULT_MIN_TOKENS
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
}

function disarm(state: State) {
  state.generation++
  state.timer?.cancel()
  state.timer = undefined
}

/** A reload while a turn runs, or after the session ended, must not re-arm. */
function forget($: EngineInterface) {
  return $.state.set(LAST_TURN, null).catch(() => {})
}

function clearStatus($: EngineInterface, state: State) {
  if (state.hasStatus) $.ui.status(undefined)
  state.hasStatus = false
}

async function compactIfWorthIt($: EngineInterface, state: State, idleSince: number, latest: number, floor: number) {
  const fired = state.generation
  try {
    const { context } = await $.session.usage({ breakdown: 'full' })
    // Unknown after a compaction until the next response: nothing to shrink then either.
    if (context.tokens === undefined) return
    const conversation = conversationTokens(context) ?? 0
    if (conversation < floor) {
      $.ui.log(`not compacted: the conversation is ${approx(conversation)} tokens, under the ${approx(floor)} floor`)
      return
    }
    const before = context.tokens ?? 0
    const now = await $.clock.now()
    const at = hhmm(now)
    const idleMin = Math.round((now - idleSince) / 60_000)
    // A timer that fires late (the machine slept) finds the cache cold: compacting now would cost
    // what the cold return costs, and lose detail on top.
    if (now > latest) {
      $.ui.log(`not compacted: the timer fired ${idleMin} min after the last turn, too late for a warm cache`)
      return
    }
    const result = await $.session.compact({ instructions: instructions(at, idleMin) })
    if (result.messages === undefined) return
    // tokensBefore is the whole context; tokensAfter is only the summary, without the system prompt and tools.
    const summary = result.tokensAfter === undefined ? '' : ` → ${inThousands(result.tokensAfter)} summary`
    const sizes = `${inThousands(result.tokensBefore ?? before)} tokens${summary}${cacheShare(result.usage)}`
    const line = `compacted at ${at} after ${idleMin} min idle (${sizes})`
    $.ui.log(line)
    // A turn started while the summary ran has already cleared the status; don't pin a stale one.
    if (fired !== state.generation) return
    $.ui.status(line)
    state.hasStatus = true
  } catch {
    // compact rejects while a turn runs; the next turn.complete re-arms the timer
  }
}

/** Starts the timer: due `ms` from now, it measures the idle time from `idleSince`. */
function schedule($: EngineInterface, state: State, idleSince: number, ms: number, delay: number, floor: number) {
  state.timer = $.clock.after(ms, () => {
    state.timer = undefined
    void compactIfWorthIt($, state, idleSince, idleSince + delay + MARGIN_MS, floor)
  })
}

async function arm($: EngineInterface, state: State, options: PluginOptions) {
  disarm(state)
  const armed = state.generation
  const delay = idleDelayMs(options)
  const idleSince = await $.clock.now()
  const sessionId = await $.session.id()
  if (armed !== state.generation) return
  schedule($, state, idleSince, delay, delay, minTokens(options))
  // Kept for a reload of the module, which cancels the timer.
  await $.state.set(LAST_TURN, { sessionId, at: idleSince })
  // A turn.start that disarmed meanwhile may have cleared it before this write landed.
  if (armed !== state.generation) await forget($)
}

/** After a reload: re-arms for what is left of the delay since this session's last turn, if any. */
async function rearm($: EngineInterface, state: State, options: PluginOptions) {
  disarm(state)
  const armed = state.generation
  const delay = idleDelayMs(options)
  const { value: last } = await $.state.get(LAST_TURN)
  const sessionId = await $.session.id()
  const now = await $.clock.now()
  if (armed !== state.generation || !last || last.sessionId !== sessionId) return
  // Past the deadline the timer has fired already, or the session was resumed long after: either way
  // there's nothing to do now.
  const left = last.at + delay - now
  if (left > 0) schedule($, state, last.at, left, delay, minTokens(options))
}

/**
 * Arms a timer at the end of every main-loop turn and cancels it when the next turn starts, so it
 * runs from the last model request: the last time the cache was refreshed. A prompt that starts no
 * turn, such as a local slash command, doesn't touch the cache and so doesn't touch the timer.
 * When it fires on time and the context is big enough, compacts while the cache is still warm and
 * leaves a note in the transcript and the status line. The time of the last turn is kept in
 * `$.state`, so a reload of the module, which cancels the timer, re-arms it for the time left.
 */
export const register: Register = (on, options) => {
  // A reloaded module can't tell whether the one before it pinned a status: assume it did.
  const state: State = { generation: 0, hasStatus: true }

  on('turn.start', async ($, e, next) => {
    disarm(state)
    clearStatus($, state)
    await forget($)
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

  on('session.end', async ($, e, next) => {
    disarm(state)
    clearStatus($, state)
    await forget($)
    return next(e)
  })

  // Also fires when the module is reloaded (/reload-plugins, an update, an options change), which
  // cancels the timer: pick up where the last turn left off.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await rearm($, state, options).catch(() => {})
    return result
  })
}
