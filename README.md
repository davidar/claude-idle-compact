# idle-compact

A [Claude Code](https://code.claude.com) mod that compacts an idle session shortly before its prompt
cache expires. You come back to a small, warm context instead of a big, cold one.

Needs Claude Code 2.1.287 or later, the first release with
[mods](https://code.claude.com/docs/en/plugins/mods/overview) on by default.

## Why

You often step away from a session without knowing you'll be gone for more than an hour. The main
conversation's prompt cache lives for 1 hour on a Claude subscription. When you come back after that,
the next request re-sends the whole context and writes it to the cache again at full price. For a
367k-token session, that is a lot of usage spent on saying "ok, where were we".

Running `/compact` before you leave would fix this, but only if you knew you were leaving.

idle-compact does it for you. After 50 minutes with no activity, it compacts the conversation while
the cache is still warm:

| | Cold return, no compaction | idle-compact at 50 min |
|---|---|---|
| Summary pass | none | reads 367k from cache at about 0.1× input price, writes a few thousand output tokens |
| First request back | re-caches 367k at 2× input price (1-hour cache write) | re-caches the ~12k summary |
| Roughly, in input-token equivalents | ~730k | ~100k |

Cache reads are even cheaper than 0.1× on some current models, which makes the gap bigger. The cost is
that the conversation is now a summary: see [Caveats](#caveats).

## What it does

- After every main-loop turn, it arms a timer. Any new prompt, turn, `/clear` or exit cancels it.
- When the timer fires, it checks the context size. Below 60k tokens it does nothing, because a cold
  re-read is cheap and not worth losing detail over.
- Otherwise it runs the same compaction `/compact` runs. The instructions tell the summariser that the
  user stepped away, and what to keep: open tasks, decisions and their reasons, follow-ups with dates,
  file paths, and anything the user asked to remember.
- It leaves a line in the transcript and a pinned status line under the prompt:

  ```
  ● idle-compact: compacted at 19:13 after 50 min idle (367k → 12k tokens)
  ```

  The status line goes away when you send your next prompt.
- It compacts once. The compaction itself isn't a turn, so nothing re-arms the timer until you're back.

### The cache TTL

The delay is derived from the prompt-cache TTL, resolved the way Claude Code resolves it:

1. `FORCE_PROMPT_CACHING_5M` → 5 minutes
2. `CLAUDE_CODE_PROMPT_CACHE_TTL` (`5m` / `1h`)
3. the `promptCacheTtl` setting (`5m` / `1h`)
4. `ENABLE_PROMPT_CACHING_1H` → 1 hour
5. otherwise automatic: 1 hour on a Claude subscription within its usage limits; 5 minutes on an API
   key, Bedrock, Vertex or Foundry.

On a **1-hour** cache it compacts after 50 minutes idle, which leaves 10 minutes of margin. A
367k-token summary pass took under 2 minutes.

On a **5-minute** cache it stays off and says so once per session. Compacting after 3 or 4 minutes of
reading would be more disruptive than helpful. If you're on an API key and want this, set
`"promptCacheTtl": "1h"` in your settings (1-hour cache writes cost 2× instead of 1.25×). You can also
set `idleMinutes` to force a delay.

## Install

Add this repo as a marketplace and install the plugin:

```
/plugin marketplace add davidar/claude-idle-compact
/plugin install idle-compact@idle-compact
```

To try it without installing, run `claude --plugin-dir /path/to/claude-idle-compact`.

If you set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` during the mods early access, you can remove it.
Claude Code ignores it now.

## Configure

Set these with `/plugin configure idle-compact@idle-compact`, or in `/config`:

| Option | Default | Meaning |
|---|---|---|
| `idleMinutes` | `0` (automatic) | Minutes idle before compacting. `0` means 50 on a 1-hour cache and off on a 5-minute one. |
| `minTokens` | `60000` | Leave contexts smaller than this alone. |

Two environment variables override both options. They're mainly for testing:

| Variable | Meaning |
|---|---|
| `IDLE_COMPACT_MS` | Idle delay in milliseconds, e.g. `60000` for a one-minute check. |
| `IDLE_COMPACT_MIN_TOKENS` | Minimum context size. |

## Caveats

- **Compaction is lossy.** You come back to a summary, not the full transcript. If you'd rather pay
  for a cold re-read than lose detail, raise `minTokens` or disable the plugin for that session.
- **The transcript records it as a manual compaction.** It goes through the same path as `/compact`,
  so the transcript JSONL marks it with `trigger: "manual"`. To find one afterwards, look for the
  "compacted at …" line, which is written to the transcript and shown again after `--resume`.
- **The automatic TTL is inferred.** A mod can't read the TTL Claude Code actually chose, so
  idle-compact repeats Claude Code's own resolution. It detects a subscription by the plan windows
  (`five_hour` / `seven_day`) in the session's rate limits. If Claude Code changes how it picks the
  TTL, set `idleMinutes` or `promptCacheTtl` explicitly.
- **A mod runs with your permissions.** `claude plugin validate .` on a clone shows what the module
  hooks, calls and reads, without running it.

## Develop

```sh
claude plugin test .                               # tests (mocked clock, env, usage)
claude plugin validate .claude-plugin/plugin.json  # what the module hooks, calls and reads
npx -p typescript tsc -p .                         # type-check
```

The types come from Claude Code itself. It writes `.claude-plugin/types/` (gitignored) the first time
it loads the mod from this folder, stamped with its version. The root `tsconfig.json` extends the
`tsconfig.json` in there. On a fresh clone, run the mod once, for example
`claude --plugin-dir . -p ok`, before type-checking.

For a live check, use a throwaway session:

```sh
IDLE_COMPACT_MS=60000 IDLE_COMPACT_MIN_TOKENS=1000 claude --plugin-dir . --model haiku
```

## Related

[cache-tax](https://github.com/karanb192/cache-tax) goes at the same problem from the other side.
Before you step away, you run `/keepwarm`, and it keeps the cache warm with a small fork over the
transcript every 50 idle minutes. If you come back to a cold cache anyway, it stops your first send
and shows what the rewrite will cost. The trade-off:

- **cache-tax** loses no detail, but costs something every hour you're away, and you have to arm it.
- **idle-compact** is automatic and costs something once, but you come back to a summary.

## License

MIT
