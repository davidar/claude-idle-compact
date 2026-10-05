// idle-compact's contract: the one value it keeps in `$.state`.

/** When a session's last main-loop turn ended, kept so a reload of the module can re-arm its timer. */
export type IdleCompactLastTurn = { sessionId: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    // null while a turn runs and after the session ends
    'idle-compact': { lastTurn: IdleCompactLastTurn | null }
  }
}
